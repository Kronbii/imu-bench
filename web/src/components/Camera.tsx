import { useEffect, useRef, useState } from 'react'

import {
  angleBetween,
  cameraAzimuth,
  cameraToNed,
  DEG,
  elevationCircle,
  intrinsics,
  levelBodyCamera,
  matToQuat,
  mount,
  MOUNTS,
  mul,
  project,
  quatToMat,
  slerp,
  transpose,
  warpMatrix,
  type Intrinsics,
  type Mat3,
  type Quat,
} from '../lib/camera'
import { onFrame, quatAt, store, useTick } from '../telemetry'
import { createView, type GlView } from './camgl'
import { download, INK, MONO } from './plot'
import { SectionHead } from './Section'

/*
 * A camera rigidly mounted to the IMU. Left: the camera's image with the
 * horizon and pitch ladder the IMU predicts, drawn from its attitude, the
 * mount (camera-to-body rotation plus trims) and a time offset. When the
 * overlay sticks to the real horizon through fast motion, rotation and
 * timing are right. Right: every frame warped by rotation alone to a
 * virtual camera that stays level, or follows a smoothed path. That is
 * electronic image stabilisation, and it is only as good as the extrinsics.
 */

type Source = 'synthetic' | 'webcam'
type Stab = 'off' | 'level' | 'smooth'
const CROPS = [
  { label: 'None', z: 1 },
  { label: '20 %', z: 1.25 },
  { label: '35 %', z: 1.54 },
]
// the simulated camera's real mounting, which the trims and offset have to find
const TRUTH = { trim: [2.0 * DEG, -1.5 * DEG, 1.0 * DEG], latency: 0.07 }

interface Settings {
  source: Source
  mountName: string
  hfov: number
  trim: [number, number, number] // deg: roll, pitch, yaw about the body axes
  offsetMs: number
  stab: Stab
  zoom: number
}

function drawOverlay(g: CanvasRenderingContext2D, cam: Mat3, K: Intrinsics, title: string) {
  const { w, h } = K
  g.lineCap = 'round'
  g.lineJoin = 'round'
  // pitch ladder: short rungs every 10°, either side of the camera's heading
  const az = cameraAzimuth(cam)
  g.font = MONO
  g.textBaseline = 'middle'
  for (let e = -60; e <= 60; e += 10) {
    if (!e) continue
    const er = e * DEG
    g.strokeStyle = INK(0.55)
    g.lineWidth = 1.5
    g.setLineDash(e < 0 ? [5, 4] : [])
    let label: [number, number] | null = null
    for (const side of [-1, 1]) {
      g.beginPath()
      let first = true
      for (let i = 0; i <= 12; i++) {
        const a = az + side * (1.5 + (i / 12) * 6) * DEG
        const p = project(cam, K, [Math.cos(er) * Math.cos(a), Math.cos(er) * Math.sin(a), -Math.sin(er)])
        if (!p) {
          first = true
          continue
        }
        if (first) g.moveTo(p[0], p[1])
        else g.lineTo(p[0], p[1])
        first = false
        if (side === 1 && i === 12) label = p
      }
      g.stroke()
    }
    g.setLineDash([])
    if (label && label[0] > 0 && label[0] < w - 20 && label[1] > 8 && label[1] < h - 8) {
      g.fillStyle = INK(0.7)
      g.textAlign = 'left'
      g.fillText(String(e), label[0] + 6, label[1])
    }
  }
  // the horizon
  g.strokeStyle = '#b7d3a8'
  g.lineWidth = 2
  for (const line of elevationCircle(cam, K, 0, 720)) {
    g.beginPath()
    line.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
    g.stroke()
  }
  // straight down, when the camera sees it
  const nadir = project(cam, K, [0, 0, 1])
  if (nadir && nadir[0] > 0 && nadir[0] < w && nadir[1] > 0 && nadir[1] < h) {
    g.strokeStyle = '#b7d3a8'
    g.lineWidth = 1.5
    g.beginPath()
    g.arc(nadir[0], nadir[1], 9, 0, Math.PI * 2)
    g.moveTo(nadir[0] - 15, nadir[1])
    g.lineTo(nadir[0] + 15, nadir[1])
    g.moveTo(nadir[0], nadir[1] - 15)
    g.lineTo(nadir[0], nadir[1] + 15)
    g.stroke()
    g.fillStyle = INK(0.8)
    g.textAlign = 'left'
    g.fillText('nadir', nadir[0] + 14, nadir[1] - 12)
  }
  // optical axis
  g.strokeStyle = INK(0.75)
  g.lineWidth = 1.5
  g.beginPath()
  g.moveTo(w / 2 - 22, h / 2)
  g.lineTo(w / 2 - 8, h / 2)
  g.moveTo(w / 2 + 8, h / 2)
  g.lineTo(w / 2 + 22, h / 2)
  g.moveTo(w / 2, h / 2 + 8)
  g.lineTo(w / 2, h / 2 + 3)
  g.stroke()
  g.font = MONO
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  const tw = g.measureText(title).width
  g.fillStyle = 'rgba(7, 9, 8, 0.72)'
  g.beginPath()
  g.roundRect(10, 10, tw + 18, 22, 11)
  g.fill()
  g.fillStyle = INK(0.75)
  g.fillText(title, 19, 21.5)
}

/** Elevation of the optical axis and roll of the image, deg, for the readouts. */
function cameraAngles(cam: Mat3) {
  return {
    elevation: Math.asin(Math.max(-1, Math.min(1, -cam[8]))) / DEG,
    roll: Math.asin(Math.max(-1, Math.min(1, cam[6]))) / DEG,
    azimuth: ((cameraAzimuth(cam) / DEG) % 360 + 360) % 360,
  }
}

function extrinsicsYaml(s: Settings, size: [number, number]) {
  const M = mount(s.mountName, s.trim.map((v) => v * DEG))
  // T_cam_imu takes IMU-frame points to the camera; the IMU frame is FLU, as the ROS 2 publisher sends it
  const R = transpose(mul([1, 0, 0, 0, -1, 0, 0, 0, -1], M))
  const f = size[0] / 2 / Math.tan((s.hfov * DEG) / 2)
  const row = (i: number) => `  - [${[R[i * 3], R[i * 3 + 1], R[i * 3 + 2]].map((v) => v.toFixed(6)).join(', ')}, 0.0]`
  return [
    '# camchain-imucam.yaml (Kalibr layout), from the imuctl horizon overlay.',
    '# Rotation and time offset only; IMU frame FLU, as published on ROS 2.',
    `# ${s.mountName}-looking, trims roll ${s.trim[0].toFixed(1)}°, pitch ${s.trim[1].toFixed(1)}°, yaw ${s.trim[2].toFixed(1)}°.`,
    '# Translation not measured: fill in the lever arm.',
    'cam0:',
    '  camera_model: pinhole',
    `  intrinsics: [${f.toFixed(2)}, ${f.toFixed(2)}, ${(size[0] / 2).toFixed(1)}, ${(size[1] / 2).toFixed(1)}]  # from the field of view`,
    `  resolution: [${size[0]}, ${size[1]}]`,
    '  distortion_model: radtan',
    '  distortion_coeffs: [0.0, 0.0, 0.0, 0.0]',
    '  T_cam_imu:',
    row(0),
    row(1),
    row(2),
    '  - [0.0, 0.0, 0.0, 1.0]',
    `  timeshift_cam_imu: ${(-s.offsetMs / 1000).toFixed(4)}  # t_imu = t_cam + shift`,
    '  rostopic: /cam0/image_raw',
    '',
  ].join('\n')
}

function Slider(p: { id: string; label: string; min: number; max: number; step: number; value: number; unit: string; onChange: (v: number) => void }) {
  return (
    <div className="slider">
      <label htmlFor={p.id} className="label">
        {p.label}
      </label>
      <input id={p.id} type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(parseFloat(e.target.value))} />
      <output htmlFor={p.id} className="mono">
        {p.value > 0 && p.min < 0 ? '+' : ''}
        {p.value.toFixed(p.step < 1 ? 1 : 0)}
        {p.unit}
      </output>
    </div>
  )
}

export function Camera() {
  useTick(250)
  const [s, setS] = useState<Settings>({ source: 'synthetic', mountName: 'forward', hfov: 78, trim: [0, 0, 0], offsetMs: 0, stab: 'level', zoom: 1.25 })
  const [err, setErr] = useState<string | null>(null)
  const [videoSize, setVideoSize] = useState<[number, number] | null>(null)
  const settings = useRef(s)
  settings.current = s
  const rawBox = useRef<HTMLDivElement>(null)
  const stabBox = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const readout = useRef({ user: null as Mat3 | null, virt: null as Mat3 | null, size: [1280, 720] as [number, number] })
  const set = (patch: Partial<Settings>) => setS((p) => ({ ...p, ...patch }))

  useEffect(() => {
    const boxes = [rawBox.current!, stabBox.current!]
    const views: (GlView | null)[] = boxes.map((b) => {
      try {
        return createView(b.querySelector('canvas.gl') as HTMLCanvasElement)
      } catch (e) {
        setErr(`WebGL: ${(e as Error).message}`)
        return null
      }
    })
    if (views.some((v) => !v)) setErr((e) => e ?? 'This browser has no WebGL2, which the camera view needs.')
    const overlays = boxes.map((b) => (b.querySelector('canvas.ov') as HTMLCanvasElement).getContext('2d')!)
    let visible = true
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting))
    io.observe(boxes[0])
    let smooth: Quat | null = null
    let last = performance.now()
    let frame = 0

    const stop = onFrame((now) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (++frame % 2 || !visible) return
      const st = settings.current
      const W = boxes[0].clientWidth
      const H = boxes[0].clientHeight
      if (!W || !H) return
      const tNow = store.series.quat.lastT
      const q = (quatAt(tNow - st.offsetMs / 1000) ?? store.att.q) as Quat
      const toBody = mount(st.mountName, st.trim.map((v) => v * DEG))
      const user = cameraToNed(q, toBody) // where we believe the camera points
      const K = intrinsics(W, H, st.hfov)
      // the simulated camera points where it really points: its own mount error, its own latency
      const qTrue = (quatAt(tNow - TRUTH.latency) ?? q) as Quat
      const truth = cameraToNed(qTrue, mount(st.mountName, TRUTH.trim))
      const vid = st.source === 'webcam' ? video.current : null
      const src: [number, number] = vid?.videoWidth ? [vid.videoWidth, vid.videoHeight] : [W, H]
      const fSrc = src[0] / 2 / Math.tan((st.hfov * DEG) / 2)

      // the virtual camera of the stabilised view: level means the nominal mount on a level body, so the trims
      // (the camera's own misalignment) are taken out too and the horizon comes out truly level
      const target = st.stab === 'level' ? levelBodyCamera(q, mount(st.mountName)) : user
      if (st.stab === 'smooth') {
        const qc = matToQuat(user)
        smooth = smooth ? slerp(smooth, qc, 1 - Math.exp(-dt * 2 / 0.4)) : qc
      } else smooth = null
      const virt = smooth ? quatToMat(smooth) : st.stab === 'off' ? user : target
      const Kv = { w: W, h: H, f: K.f * (st.stab === 'off' ? 1 : st.zoom) }
      readout.current = { user, virt, size: vid?.videoWidth ? [vid.videoWidth, vid.videoHeight] : [1280, 720] }

      views[0]?.draw({ size: [W, H], f: K.f, src, fSrc, warp: [1, 0, 0, 0, 1, 0, 0, 0, 1], cam: truth, video: vid })
      views[1]?.draw({ size: [W, H], f: Kv.f, src, fSrc, warp: warpMatrix(user, virt), cam: truth, video: vid })
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      overlays.forEach((g, i) => {
        const cv = g.canvas
        if (cv.width !== Math.round(W * dpr)) {
          cv.width = Math.round(W * dpr)
          cv.height = Math.round(H * dpr)
        }
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.clearRect(0, 0, W, H)
        drawOverlay(g, i ? virt : user, i ? Kv : K, i ? `virtual camera · ${st.stab}` : 'IMU horizon')
      })
    })
    return () => {
      stop()
      io.disconnect()
      views.forEach((v) => v?.dispose())
    }
  }, [])

  // the webcam: only on request, and it never leaves the page
  useEffect(() => {
    if (s.source !== 'webcam') return
    let stream: MediaStream | null = null
    let cancelled = false
    setErr(null)
    navigator.mediaDevices
      ?.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(async (st) => {
        if (cancelled) return st.getTracks().forEach((t) => t.stop())
        stream = st
        const v = video.current!
        v.srcObject = st
        await v.play()
        setVideoSize([v.videoWidth, v.videoHeight])
      })
      .catch((e: Error) => {
        setErr(`Webcam: ${e.message}`)
        set({ source: 'synthetic' })
      })
    if (!navigator.mediaDevices) {
      setErr('Webcam: needs a secure page (https or localhost).')
      set({ source: 'synthetic' })
    }
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
      setVideoSize(null)
    }
  }, [s.source])

  const r = readout.current
  const a = r.user ? cameraAngles(r.user) : null
  const synthetic = s.source === 'synthetic'
  const mountErr = angleBetween(mount(s.mountName, s.trim.map((v) => v * DEG)), mount(s.mountName, TRUTH.trim)) / DEG
  const timeErr = Math.abs(s.offsetMs - TRUTH.latency * 1000)
  const matched = mountErr < 0.35 && timeErr < 12
  const aspect = s.source === 'webcam' && videoSize ? `${videoSize[0]} / ${videoSize[1]}` : '16 / 9'
  const yaml = extrinsicsYaml(s, r.size)

  return (
    <section id="camera" className="section">
      <SectionHead
        n="04"
        label="Camera"
        title={
          <>
            A <em>camera</em> on the IMU
          </>
        }
        lede={
          <>
            A camera bolted to the IMU turns with it. From the attitude, the mount and a time offset, the IMU predicts
            where the true horizon lands in every frame (left), and a rotation-only warp holds the view level (right).
            When the line sticks to the horizon through fast motion, your rotation and timing are right.
          </>
        }
      />
      <div className="filters" role="toolbar" aria-label="Camera settings">
        <span className="label">Source</span>
        <div className="seg">
          <button aria-pressed={synthetic} onClick={() => set({ source: 'synthetic' })}>
            Synthetic
          </button>
          <button aria-pressed={!synthetic} onClick={() => set({ source: 'webcam' })}>
            Webcam
          </button>
        </div>
        <span className="label">Stabilise</span>
        <div className="seg">
          {(['off', 'level', 'smooth'] as Stab[]).map((m) => (
            <button key={m} aria-pressed={s.stab === m} onClick={() => set({ stab: m })}>
              {m === 'off' ? 'Off' : m === 'level' ? 'Level horizon' : 'Smooth'}
            </button>
          ))}
        </div>
        <span className="label">Crop</span>
        <div className="seg">
          {CROPS.map((c) => (
            <button key={c.label} aria-pressed={s.zoom === c.z} onClick={() => set({ zoom: c.z })}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {err && (
        <p className="note" data-level="warning" style={{ marginTop: 0, marginBottom: 12 }}>
          {err}
        </p>
      )}
      <div className="grid-2">
        <article className="card">
          <span className="tick" />
          <span className="label">Fig. 09 · Camera, with the IMU&rsquo;s horizon</span>
          <div ref={rawBox} className="camview" style={{ aspectRatio: aspect }}>
            <canvas className="gl" role="img" aria-label="Camera image with the horizon and pitch ladder predicted by the IMU" />
            <canvas className="ov" aria-hidden="true" />
          </div>
        </article>
        <article className="card">
          <span className="tick" />
          <span className="label">Fig. 10 · Stabilised by rotation alone</span>
          <div ref={stabBox} className="camview" style={{ aspectRatio: aspect }}>
            <canvas className="gl" role="img" aria-label="The same image warped to a virtual camera that stays level" />
            <canvas className="ov" aria-hidden="true" />
          </div>
        </article>
      </div>
      <video ref={video} playsInline muted style={{ display: 'none' }} />
      <div className="cam-controls">
        <article className="card">
          <span className="tick" />
          <div className="card-head">
            <span className="label">Mount and timing</span>
            <button className="pill" data-variant="quiet" data-size="s" onClick={() => set({ trim: [0, 0, 0], offsetMs: 0 })}>
              Reset
            </button>
          </div>
          <div className="filters" style={{ margin: '10px 0 6px' }}>
            <span className="label">Looking</span>
            <div className="seg">
              {Object.entries(MOUNTS).map(([k, m]) => (
                <button key={k} aria-pressed={s.mountName === k} onClick={() => set({ mountName: k })}>
                  {m.label.split(' (')[0].replace('Looking ', '').replace(/^./, (c) => c.toUpperCase())}
                </button>
              ))}
            </div>
          </div>
          <div className="sliders">
            <Slider id="cam-roll" label="Roll trim" min={-10} max={10} step={0.1} value={s.trim[0]} unit="°" onChange={(v) => set({ trim: [v, s.trim[1], s.trim[2]] })} />
            <Slider id="cam-pitch" label="Pitch trim" min={-10} max={10} step={0.1} value={s.trim[1]} unit="°" onChange={(v) => set({ trim: [s.trim[0], v, s.trim[2]] })} />
            <Slider id="cam-yaw" label="Yaw trim" min={-10} max={10} step={0.1} value={s.trim[2]} unit="°" onChange={(v) => set({ trim: [s.trim[0], s.trim[1], v] })} />
            <Slider id="cam-offset" label="Time offset" min={0} max={300} step={1} value={s.offsetMs} unit=" ms" onChange={(v) => set({ offsetMs: v })} />
            <Slider id="cam-fov" label="Field of view" min={30} max={130} step={1} value={s.hfov} unit="°" onChange={(v) => set({ hfov: v })} />
          </div>
          <dl className="kv" style={{ marginTop: 14 }}>
            <dt>Camera elevation</dt>
            <dd>{a ? `${a.elevation >= 0 ? '+' : '−'}${Math.abs(a.elevation).toFixed(1)}°` : '—'}</dd>
            <dt>Camera roll</dt>
            <dd>{a ? `${a.roll >= 0 ? '+' : '−'}${Math.abs(a.roll).toFixed(1)}°` : '—'}</dd>
            <dt>Camera heading</dt>
            <dd>{a ? `${a.azimuth.toFixed(0)}°` : '—'}</dd>
          </dl>
          {synthetic ? (
            <p className="note" data-level={matched ? 'good' : undefined}>
              {matched ? (
                <>
                  Dialled in: mount within {mountErr.toFixed(2)}°, timing within {timeErr.toFixed(0)} ms. The left line
                  sits on the horizon and the right view holds still.
                </>
              ) : (
                <>
                  The simulated camera is mounted a little off and its frames arrive late. Trim roll and pitch until the
                  line sits on the horizon, then raise the time offset until it stops lagging the motion. Off by{' '}
                  {mountErr.toFixed(1)}° and {timeErr.toFixed(0)} ms.
                </>
              )}
            </p>
          ) : (
            <p className="note">
              Hold the camera and the IMU together, rigidly, and point at a real horizon or a level line. Trim until the
              overlay sits on it, then shake gently and raise the offset until it stops lagging. Frames stay in this page.
            </p>
          )}
        </article>
        <article className="card">
          <span className="tick" />
          <div className="card-head">
            <span className="label">Extrinsics</span>
            <button className="pill" data-variant="quiet" data-size="s" onClick={() => download('camchain-imucam.yaml', yaml, 'text/yaml')}>
              Download
            </button>
          </div>
          <pre className="code">{yaml}</pre>
          <p className="note">
            The rotation from these trims and the offset, in the layout Kalibr&rsquo;s camera–IMU calibration reads: a
            starting point it refines, or enough on its own for horizon overlays and stabilisation.
          </p>
        </article>
      </div>
    </section>
  )
}

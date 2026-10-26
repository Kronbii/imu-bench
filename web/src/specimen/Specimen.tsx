import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

import { displayEuler, displayQuat, type Form, linkState, onFrame, reducedMotion, shortDev, store, useTick } from '../telemetry'
import { buildModel, type Model, VIEW_RADIUS } from './models'

/*
 * FIG. 01, the sensor. One WebGL context: the contour-line terrain from the
 * portfolio's specimen plate (static here: the sensor turns, the world does
 * not), a compass ring on the NED ground, and the device's model (RUG-3,
 * breakout board or quadrotor, by its `form`) turned by the attitude
 * quaternion every frame. Leader lines tie mono callouts to the body axes.
 * Dragging orbits the camera; the attitude only ever comes from the data.
 */

const TERRAIN_VERT = /* glsl */ `
  varying float vHeight;
  varying float vDist;
  varying vec2 vGrid;

  vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  float terrain(vec2 p) {
    float h = snoise(p * 0.11) * 1.1;
    h += snoise(p * 0.27 + 7.3) * 0.38;
    h += snoise(p * 0.62 - 3.1) * 0.12;
    return h;
  }

  void main() {
    vec3 pos = position;
    vec2 q = pos.xz;
    pos.y += terrain(q);
    vHeight = pos.y;
    vGrid = q * 0.5;
    vec4 world = modelMatrix * vec4(pos, 1.0);
    vec4 view = viewMatrix * world;
    vDist = -view.z;
    gl_Position = projectionMatrix * view;
  }
`

const TERRAIN_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vHeight;
  varying float vDist;
  varying vec2 vGrid;

  void main() {
    float k = vHeight * 4.0;
    float c = abs(fract(k - 0.5) - 0.5) / fwidth(k);
    float contour = 1.0 - min(c, 1.0);
    float major = 1.0 - min(abs(fract(k / 5.0 - 0.5) - 0.5) / fwidth(k / 5.0), 1.0);
    vec2 g = abs(fract(vGrid - 0.5) - 0.5) / fwidth(vGrid);
    float grid = 1.0 - min(min(g.x, g.y), 1.0);
    float fade = smoothstep(34.0, 8.0, vDist) * smoothstep(1.5, 6.0, vDist);
    float a = (contour * 0.5 + major * 0.45 + grid * 0.1) * fade * 0.85;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`

const SAGE = '#b7d3a8'
const DEG = Math.PI / 180

/** The compass rose painted on the ground: north is -Z. */
function compassTexture() {
  const s = 1024
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')!
  const mid = s / 2
  const R = s * 0.44
  g.strokeStyle = 'rgba(238, 241, 236, 0.22)'
  g.lineWidth = 2
  g.beginPath()
  g.arc(mid, mid, R, 0, Math.PI * 2)
  g.stroke()
  g.beginPath()
  g.arc(mid, mid, R * 0.82, 0, Math.PI * 2)
  g.strokeStyle = 'rgba(238, 241, 236, 0.08)'
  g.stroke()
  for (let d = 0; d < 360; d += 5) {
    const a = d * DEG - Math.PI / 2 // canvas: 0° at top
    const len = d % 90 === 0 ? 34 : d % 30 === 0 ? 22 : 10
    g.strokeStyle = d % 90 === 0 ? SAGE : 'rgba(238, 241, 236, 0.32)'
    g.lineWidth = d % 30 === 0 ? 3 : 2
    g.beginPath()
    g.moveTo(mid + Math.cos(a) * R, mid + Math.sin(a) * R)
    g.lineTo(mid + Math.cos(a) * (R - len), mid + Math.sin(a) * (R - len))
    g.stroke()
  }
  g.font = '600 46px "Spline Sans Mono Variable", "Spline Sans Mono", monospace'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const card: [string, number][] = [
    ['N', 0],
    ['E', 90],
    ['S', 180],
    ['W', 270],
  ]
  for (const [t, d] of card) {
    const a = d * DEG - Math.PI / 2
    g.fillStyle = t === 'N' ? SAGE : 'rgba(238, 241, 236, 0.6)'
    g.fillText(t, mid + Math.cos(a) * (R + 44), mid + Math.sin(a) * (R + 44))
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

type CalloutText = { key: string; label: string; color?: string }
const currentForm = (): Form => store.device?.form ?? 'board'

const fmtAngle = (v: number) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '°'
const fmtRate = (v: number) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + ' °/s'

/** Over the plate while there is no data: what the bridge is doing about it. */
function Veil() {
  useTick(300)
  const { state, label } = linkState()
  const why = store.link?.why
  const driver = store.src?.driver ?? store.device?.driver
  const port = store.link?.port ?? ''
  const title =
    label === 'No server'
      ? 'Server not running'
      : why === 'searching' || why === 'unplugged'
        ? 'Plug in the sensor'
        : why === 'not answering' || why === 'not an IMX'
          ? 'No reply from the port'
          : why === 'no heartbeat'
            ? 'The vehicle went quiet'
            : 'Waiting for data'
  const detail =
    label === 'No server'
      ? 'Start it with ./imu-bench <driver>; this page reconnects by itself.'
      : why === 'unplugged'
        ? 'It reconnects on its own when the sensor comes back, whatever port name it gets.'
        : why === 'searching' && driver === 'imx'
          ? 'Watching /dev/imx5 and /dev/serial/by-id for an Inertial Sense unit.'
          : why === 'searching' && driver === 'mavlink'
            ? `Listening for a MAVLink heartbeat on ${port}.`
            : why === 'searching'
              ? `Waiting for ${port}.`
              : why === 'not answering' || why === 'not an IMX'
                ? 'A matching USB port is present but it does not speak ISB: another STM32 board?'
                : 'Nothing has arrived for a moment; it carries on as soon as data does.'
  return (
    <div className="veil" data-on={state === 'down' || undefined} role="status" aria-live="polite">
      <span className="lock" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="label">{label}</span>
      <b>{title}</b>
      <p>{detail}</p>
    </div>
  )
}

export function Specimen({ resetView }: { resetView: number }) {
  const host = useRef<HTMLDivElement>(null)
  const canvasHost = useRef<HTMLDivElement>(null)
  const lines = useRef<(SVGPolylineElement | null)[]>([])
  const dots = useRef<(SVGCircleElement | null)[]>([])
  const labels = useRef<(HTMLDivElement | null)[]>([])
  const values = useRef<(HTMLSpanElement | null)[]>([])
  const hud = useRef<{ r?: HTMLElement | null; p?: HTMLElement | null; y?: HTMLElement | null; mode?: HTMLElement | null }>({})
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  // targetAz is the user's orbit on top of the mode's base azimuth
  const view = useRef({ az: 0.62, el: 0.34, targetAz: 0, targetEl: 0.34 })
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [chase, setChase] = useState(true)
  const chaseRef = useRef(chase)
  chaseRef.current = chase
  const [callouts, setCallouts] = useState<CalloutText[]>([])

  useEffect(() => {
    view.current.targetAz = 0
    view.current.targetEl = 0.34
  }, [resetView])

  useEffect(() => {
    const mount = canvasHost.current
    const plate = host.current
    if (!mount || !plate) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    } catch {
      setFailed(true)
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)
    Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%' })

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 90)
    const target = new THREE.Vector3(0, -0.45, 0)

    // ---- world: terrain far below and behind, compass rose under the unit
    const terrainGeo = new THREE.PlaneGeometry(70, 52, 210, 160)
    terrainGeo.rotateX(-Math.PI / 2)
    const terrainMat = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      uniforms: { uColor: { value: new THREE.Color(SAGE) } },
      transparent: true,
      depthWrite: false,
    })
    const terrain = new THREE.Mesh(terrainGeo, terrainMat)
    terrain.position.set(0, -4.2, -10)
    scene.add(terrain)

    const roseTex = compassTexture()
    const roseGeo = new THREE.PlaneGeometry(7, 7)
    const roseMat = new THREE.MeshBasicMaterial({ map: roseTex, transparent: true, depthWrite: false, toneMapped: false })
    const rose = new THREE.Mesh(roseGeo, roseMat)
    rose.rotation.x = -Math.PI / 2 // canvas top (N) lands on -Z
    rose.position.y = -2.3
    scene.add(rose)

    // ---- light
    const pmrem = new THREE.PMREMGenerator(renderer)
    const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    scene.environment = envMap
    scene.add(new THREE.HemisphereLight(0xeef1ec, 0x0f140f, 1.05))
    const key = new THREE.DirectionalLight(0xf4f7f0, 2.3)
    key.position.set(3.5, 6, 4)
    scene.add(key)
    const rim = new THREE.DirectionalLight(SAGE, 2.4)
    rim.position.set(-4, 1.5, -3.5)
    scene.add(rim)
    const fill = new THREE.DirectionalLight(0xeef1ec, 0.7)
    fill.position.set(-2, 2.5, 6)
    scene.add(fill)

    // ---- the sensor: rebuilt whenever the device's form changes
    const rig = new THREE.Group()
    scene.add(rig)
    let model: Model | null = null
    let form: Form | null = null
    let anchors: THREE.Object3D[] = []
    const swapModel = (next: Form) => {
      if (model) {
        rig.remove(model.group)
        model.dispose()
      }
      model = buildModel(next)
      form = next
      rig.add(model.group)
      anchors = model.callouts.map((c) => c.obj)
      setCallouts(model.callouts.map(({ key, label, color }) => ({ key, label, color })))
      resize()
    }

    // ---- size
    let w = 1
    let h = 1
    let radius = 15
    function resize() {
      w = mount!.clientWidth || 1
      h = mount!.clientHeight || 1
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      const fit = VIEW_RADIUS[form ?? 'rug3']
      radius = w / h < 0.9 ? fit * 1.33 : fit // keep the sensor the same apparent size on narrow plates
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)
    swapModel(currentForm())
    setReady(true)

    // ---- orbit by drag or arrow keys
    let drag: { x: number; y: number; az: number; el: number } | null = null
    const v = view.current
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return
      drag = { x: e.clientX, y: e.clientY, az: v.targetAz, el: v.targetEl }
      plate.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (!drag) return
      v.targetAz = drag.az - (e.clientX - drag.x) * 0.008
      v.targetEl = Math.min(1.35, Math.max(-0.2, drag.el + (e.clientY - drag.y) * 0.006))
    }
    const onUp = () => (drag = null)
    const onKey = (e: KeyboardEvent) => {
      const step = { ArrowLeft: [0.12, 0], ArrowRight: [-0.12, 0], ArrowUp: [0, 0.08], ArrowDown: [0, -0.08] }[e.key]
      if (!step) return
      e.preventDefault()
      v.targetAz += step[0]
      v.targetEl = Math.min(1.35, Math.max(-0.2, v.targetEl + step[1]))
    }
    const onDbl = () => {
      v.targetAz = 0
      v.targetEl = 0.34
    }
    plate.addEventListener('pointerdown', onDown)
    plate.addEventListener('pointermove', onMove)
    plate.addEventListener('pointerup', onUp)
    plate.addEventListener('pointercancel', onUp)
    plate.addEventListener('keydown', onKey)
    plate.addEventListener('dblclick', onDbl)

    // ---- callouts: each side stacks its labels by height, kept 48px apart
    const tmp = new THREE.Vector3()
    const side = [0, 1, 2, 3].map(() => 'left' as 'left' | 'right')
    const ly = [0, 1, 2, 3].map((i) => 0.2 + i * 0.18)
    const placeCallouts = () => {
      const pts = anchors.map((a) => {
        const p = a.getWorldPosition(tmp).project(camera)
        return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h }
      })
      pts.forEach((p, i) => {
        // hysteresis keeps a label from flapping across the middle
        if (side[i] === 'left' && p.x > w * 0.56) side[i] = 'right'
        else if (side[i] === 'right' && p.x < w * 0.44) side[i] = 'left'
      })
      const GAP = 50
      const top = 70 // clear of the camera toggle
      const bottom = h - 130 // clear of the HUD
      for (const s of ['left', 'right'] as const) {
        const idx = pts.map((_, i) => i).filter((i) => side[i] === s)
        // ease each label toward its anchor's height...
        for (const i of idx) ly[i] += (Math.min(bottom, Math.max(top, pts[i].y)) / h - ly[i]) * 0.15
        // ...then hold the spacing on where the labels actually are, so they never overlap mid-move
        idx.sort((a, b) => ly[a] - ly[b])
        let prev = -Infinity
        for (const i of idx) {
          const y = Math.max(ly[i] * h, prev + GAP)
          ly[i] = y / h
          prev = y
        }
        let next = Infinity
        for (const i of [...idx].reverse()) {
          const y = Math.min(ly[i] * h, bottom, next - GAP)
          ly[i] = y / h
          next = y
        }
      }
      pts.forEach((p, i) => {
        const y = ly[i] * h
        const left = side[i] === 'left'
        const edge = left ? 24 : w - 24
        const elbow = left ? Math.min(p.x - 30, Math.max(edge + 120, w * 0.26)) : Math.max(p.x + 30, Math.min(edge - 120, w * 0.74))
        lines.current[i]?.setAttribute('points', `${edge},${y} ${elbow},${y} ${p.x},${p.y}`)
        dots.current[i]?.setAttribute('cx', p.x.toFixed(1))
        dots.current[i]?.setAttribute('cy', p.y.toFixed(1))
        const el = labels.current[i]
        if (el) {
          if (el.dataset.side !== side[i]) el.dataset.side = side[i]
          el.style.transform = `translate3d(0, ${(y - 36).toFixed(1)}px, 0)`
        }
      })
    }

    // ---- per frame
    const q3 = new THREE.Quaternion()
    let lastText = 0
    const still = reducedMotion()
    const stop = onFrame((now) => {
      if (currentForm() !== form) swapModel(currentForm())
      const ease = still ? 1 : 0.14
      // chase: sit behind and right of the unit's heading so every axis stays in view;
      // north-up: a fixed corner of the NED world
      const base = chaseRef.current ? -displayEuler()[2] * DEG + 0.95 : 0.62
      let want = base + v.targetAz
      want += Math.round((v.az - want) / (2 * Math.PI)) * 2 * Math.PI // a heading wrap must not spin the camera round
      v.az += (want - v.az) * ease
      v.el += (v.targetEl - v.el) * ease
      camera.position.set(
        target.x + radius * Math.cos(v.el) * Math.sin(v.az),
        target.y + radius * Math.sin(v.el),
        target.z + radius * Math.cos(v.el) * Math.cos(v.az),
      )
      camera.lookAt(target)

      // qn2b (body to NED) into three space: NED (n, e, d) -> (e, -d, -n)
      const [qw, qx, qy, qz] = displayQuat()
      q3.set(qy, -qz, -qx, qw)
      rig.quaternion.copy(q3)
      rose.rotation.z = (store.yawOffset * Math.PI) / 180

      renderer.render(scene, camera)
      placeCallouts()

      if (now - lastText > 50) {
        lastText = now
        const [r, p, y] = displayEuler()
        if (hud.current.r) hud.current.r.textContent = fmtAngle(r)
        if (hud.current.p) hud.current.p.textContent = fmtAngle(p)
        if (hud.current.y) hud.current.y.textContent = y.toFixed(1) + '°'
        const pqr = store.imu.gyro.map((x) => (x * 180) / Math.PI)
        pqr.forEach((d, i) => {
          const el = values.current[i]
          if (el) el.textContent = fmtRate(d)
          const b = bars.current[i]
          if (b) b.style.transform = `scaleY(${Math.max(0.05, Math.min(1, Math.abs(d) / 120)).toFixed(3)})`
        })
        const extra = values.current[3]
        if (extra)
          extra.textContent =
            form === 'quad'
              ? (store.status?.mode ?? '—')
              : store.src?.mode === 'device'
                ? shortDev(store.link?.dev ?? store.link?.port)
                : (store.src?.mode ?? '—')
        const mode = hud.current.mode
        if (mode && store.att.have) {
          const st = store.status
          mode.textContent = st?.mode.split(' · ')[0] ?? (store.att.source === 'fusion' ? 'Fused' : 'Live')
          mode.dataset.level = st?.level ?? 'good'
        }
      }
    })

    return () => {
      stop()
      ro.disconnect()
      plate.removeEventListener('pointerdown', onDown)
      plate.removeEventListener('pointermove', onMove)
      plate.removeEventListener('pointerup', onUp)
      plate.removeEventListener('pointercancel', onUp)
      plate.removeEventListener('keydown', onKey)
      plate.removeEventListener('dblclick', onDbl)
      model?.dispose()
      terrainGeo.dispose()
      terrainMat.dispose()
      roseGeo.dispose()
      roseMat.dispose()
      roseTex.dispose()
      envMap.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return (
    <figure className="specimen">
      <div
        ref={host}
        className="plate"
        tabIndex={0}
        role="group"
        aria-roledescription="3D view"
        aria-label="The sensor, turned by its live attitude. Drag or use the arrow keys to orbit; double-click resets the view."
        data-ready={ready || undefined}
        data-failed={failed || undefined}
      >
        <div ref={canvasHost} className="canvas" />
        <div className="plate-top">
          <div className="seg" role="group" aria-label="Camera">
            <button aria-pressed={chase} onClick={() => setChase(true)}>
              Chase
            </button>
            <button aria-pressed={!chase} onClick={() => setChase(false)}>
              North-up
            </button>
          </div>
        </div>
        <svg className="leaders" aria-hidden="true">
          {callouts.map((c, i) => (
            <g key={c.key}>
              <polyline ref={(el) => void (lines.current[i] = el)} className="leader" points="0,0" />
              <circle ref={(el) => void (dots.current[i] = el)} className="leader-dot" r="3" cx="-10" cy="-10" />
            </g>
          ))}
        </svg>
        {callouts.map((c, i) => (
          <div
            key={c.key}
            ref={(el) => void (labels.current[i] = el)}
            className="callout"
            data-side="left"
            aria-hidden="true"
            style={{ '--k': c.color } as React.CSSProperties}
          >
            <div>
              {c.color && <i />}
              {c.label}
            </div>
            <span ref={(el) => void (values.current[i] = el)}>—</span>
          </div>
        ))}
        <Veil />
        <div className="hud" aria-hidden="true">
          <div className="attitude">
            <span>
              <i>Roll</i>
              <b ref={(el) => void (hud.current.r = el)}>—</b>
            </span>
            <span>
              <i>Pitch</i>
              <b ref={(el) => void (hud.current.p = el)}>—</b>
            </span>
            <span>
              <i>Yaw</i>
              <b ref={(el) => void (hud.current.y = el)}>—</b>
            </span>
          </div>
          <div className="mixer">
            <span ref={(el) => void (hud.current.mode = el)} className="mode">
              Waiting
            </span>
            <div className="bars">
              {(['X', 'Y', 'Z'] as const).map((a, i) => (
                <span key={a} className="bar-well" style={{ '--k': `var(--${a.toLowerCase()})` } as React.CSSProperties}>
                  <span ref={(el) => void (bars.current[i] = el)} className="bar" />
                  <em>ω{a.toLowerCase()}</em>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
      <Caption />
    </figure>
  )
}

function Caption() {
  useTick(1000)
  const form = currentForm()
  const fused = store.att.source === 'fusion'
  const what =
    form === 'rug3'
      ? 'The RUG-3, modelled from its drawing,'
      : form === 'quad'
        ? 'A quadrotor in its flight controller’s body frame,'
        : `${store.device?.name ?? 'The sensor'} on a generic breakout board,`
  return (
    <figcaption className="caption">
      <span className="fig">Fig. 01</span>
      <span>
        {what} turned about the IMU by the attitude quaternion every frame
        {fused ? ', fused here from gyro and accelerometer (Madgwick)' : ', as the sensor reports it'}. Chase follows the
        heading; North-up holds the world still. Drag to orbit, double-click to reset. Bars are body rates, full at 120 °/s.
      </span>
    </figcaption>
  )
}

import { useEffect, useRef, useState } from 'react'

import { MAG_CAL_STATE } from '../decode'
import { has, onFrame, sendCommand, store, useTick } from '../telemetry'
import { SectionHead } from './Section'

/*
 * Magnetometer coverage: the last minute of field vectors, projected onto
 * the three body planes. Calibrated and clean, every orientation puts the
 * vector on a sphere of radius 1 centred on zero, so each projection fills
 * a disc inside the unit circle. An offset centre is hard iron; an
 * ellipse is soft iron; a |B| that changes with orientation means the
 * calibration doesn't fit.
 */

const PLANES: { name: string; a: number; b: number; la: string; lb: string }[] = [
  { name: 'XY · seen from above', a: 1, b: 0, la: 'Y', lb: 'X' },
  { name: 'YZ · seen from the front', a: 1, b: 2, la: 'Y', lb: 'Z' },
  { name: 'XZ · seen from the side', a: 0, b: 2, la: 'X', lb: 'Z' },
]

function useCloudStats() {
  const [s, set] = useState({ n: 0, mean: 0, spread: 0, centre: [0, 0, 0], span: 1 })
  useEffect(() => {
    const id = setInterval(() => {
      const r = store.magCloud
      if (!r.size) return
      let sx = 0, sy = 0, sz = 0, sm = 0, sm2 = 0, span = 0
      for (let i = 0; i < r.size; i++) {
        const j = r.at(i)
        const x = r.ch[0][j], y = r.ch[1][j], z = r.ch[2][j]
        const m = Math.hypot(x, y, z)
        sx += x; sy += y; sz += z; sm += m; sm2 += m * m
        span = Math.max(span, Math.abs(x), Math.abs(y), Math.abs(z))
      }
      const n = r.size
      const mean = sm / n
      set({ n, mean, spread: Math.sqrt(Math.max(0, sm2 / n - mean * mean)) / mean, centre: [sx / n, sy / n, sz / n], span })
    }, 500)
    return () => clearInterval(id)
  }, [])
  return s
}

function Projection({ a, b, la, lb, name }: (typeof PLANES)[number]) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current!
    const g = cv.getContext('2d')!
    let frame = 0
    let scale = 1.6
    return onFrame(() => {
      if (++frame % 4) return // 15 fps
      const dpr = Math.min(devicePixelRatio || 1, 2)
      const S = cv.clientWidth
      if (!S) return
      if (cv.width !== Math.round(S * dpr)) cv.width = cv.height = Math.round(S * dpr)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, S, S)
      const r = store.magCloud
      // the reference circle: |B| = 1 for normalised fields, the mean |B| for µT or gauss
      let sumB = 0
      for (let i = 0; i < r.size; i++) {
        const j = r.at(i)
        sumB += Math.hypot(r.ch[0][j], r.ch[1][j], r.ch[2][j])
      }
      const R = store.mag.unit === 'norm' || !r.size ? 1 : sumB / r.size
      let span = R * 1.15
      for (let i = 0; i < r.size; i++) {
        const j = r.at(i)
        span = Math.max(span, Math.abs(r.ch[a][j]) * 1.1, Math.abs(r.ch[b][j]) * 1.1)
      }
      scale += (span - scale) * 0.1
      const c = S / 2
      const k = (S / 2 - 10) / scale
      // axes and the unit circle
      g.strokeStyle = 'rgba(238, 241, 236, 0.16)'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(c, 8)
      g.lineTo(c, S - 8)
      g.moveTo(8, c)
      g.lineTo(S - 8, c)
      g.stroke()
      g.strokeStyle = 'rgba(238, 241, 236, 0.4)'
      g.beginPath()
      g.arc(c, c, k * R, 0, Math.PI * 2)
      g.stroke()
      // the cloud, newer points brighter
      for (let i = 0; i < r.size; i++) {
        const j = r.at(i)
        g.fillStyle = `rgba(183, 211, 168, ${0.12 + 0.5 * (i / r.size)})`
        g.fillRect(c + r.ch[a][j] * k - 1, c - r.ch[b][j] * k - 1, 2, 2)
      }
      if (r.size) {
        const j = r.at(r.size - 1)
        g.beginPath()
        g.arc(c + r.ch[a][j] * k, c - r.ch[b][j] * k, 4, 0, Math.PI * 2)
        g.fillStyle = '#b7d3a8'
        g.fill()
        g.lineWidth = 2
        g.strokeStyle = '#070908'
        g.stroke()
      }
      g.fillStyle = 'rgba(238, 241, 236, 0.5)'
      g.font = '10px "Spline Sans Mono Variable", ui-monospace, monospace'
      g.fillText(`+${la}`, S - 22, c - 6)
      g.fillText(`+${lb}`, c + 6, 16)
    })
  }, [a, b])
  return (
    <div className="proj">
      <canvas ref={ref} aria-label={`Magnetometer samples projected on the ${name} plane`} role="img" />
      <span className="label">{name}</span>
    </div>
  )
}

export function Calibration() {
  useTick(250)
  const stats = useCloudStats()
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const cal = store.imx.magcal
  const obs = store.imx.magobs
  const ins = store.status?.x?.insStatus ?? 0
  const canRecal = has('cmd:magrecal')
  const recal = (ins & 0x00400000) !== 0
  // a recal we started reports state 200; the firmware also raises the INS flag
  // on its own when it has no calibration, which only means "turn me"
  const running = cal?.state === 200
  const waiting = recal && !running
  const progress = cal && running ? Math.max(0, Math.min(100, cal.progress)) : cal?.state === 201 ? 100 : 0
  const calibrated = obs ? obs.calibrated !== 0 : false
  const stateText = running
    ? 'Recalibrating'
    : waiting
      ? 'Firmware recal pending: turn the unit'
      : cal
        ? (MAG_CAL_STATE[cal.state] ?? `State ${cal.state}`)
        : 'No status yet'

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])

  const run = async (cmd: string) => {
    setBusy(cmd)
    try {
      await sendCommand(cmd)
    } catch (e) {
      store.logs.unshift({ at: Date.now(), msg: `command failed: ${(e as Error).message}` })
    } finally {
      setTimeout(() => setBusy(null), 600)
    }
  }

  const step = running ? 2 : calibrated ? 3 : 0

  return (
    <section id="calibrate" className="section">
      <SectionHead
        n="04"
        label="Calibrate"
        title={
          <>
            Calibrate the <em>magnetometer</em>
          </>
        }
        lede={
          <>
            A gyro and accelerometer are calibrated by their maker, and the filter tracks what bias is left. The
            magnetometer is different: steel, magnets and currents around the mount bend the field. They have to be
            solved where the sensor is installed, or heading has no north.
          </>
        }
      />
      <div className="cal">
        <article className="card">
          <span className="tick" />
          <div className="card-head">
            <span className="label">Fig. 06 · Field coverage, last 60 s</span>
            <button className="pill" data-variant="quiet" data-size="s" onClick={() => store.magCloud.clear()}>
              Clear
            </button>
          </div>
          <h3 className="card-title">
            Where the field has been
            <small>{stats.n} samples</small>
          </h3>
          <div className="proj-grid">
            {PLANES.map((p) => (
              <Projection key={p.name} {...p} />
            ))}
          </div>
          <dl className="kv" style={{ marginTop: 16 }}>
            <dt>|B| mean</dt>
            <dd>{stats.n ? `${stats.mean.toFixed(3)} ${store.mag.unit === 'norm' ? '' : store.mag.unit}` : '—'}</dd>
            <dt>|B| spread across orientations</dt>
            <dd>{stats.n ? `${(stats.spread * 100).toFixed(1)} %` : '—'}</dd>
            <dt>Cloud centre (hard-iron hint)</dt>
            <dd>{stats.n ? stats.centre.map((v) => v.toFixed(2)).join(', ') : '—'}</dd>
          </dl>
          <p className="note">
            Calibrated and clean, the dots sit on the circle whichever way the sensor points (|B| = 1 for normalised
            units, the mean |B| otherwise), and |B| barely changes as you turn it. The centre only means something once
            the cloud covers many orientations.
          </p>
        </article>

        {canRecal ? (
          <article className="card">
            <span className="tick" />
            <span className="label">Procedure · DID_MAG_CAL</span>
            <ol className="steps">
              <li data-on={step >= 0 || undefined}>
                <span>1</span>
                <div>
                  <strong>Mount it where it will fly</strong>
                  <p>In the vehicle, wired as it will run. Calibrating on the desk solves the desk.</p>
                </div>
              </li>
              <li data-on={step >= 2 || undefined}>
                <span>2</span>
                <div>
                  <strong>Start a recalibration</strong>
                  <p>Multi-axis: turn 360° about two axes, more accurate. Single-axis: one full turn in yaw.</p>
                </div>
              </li>
              <li data-on={step >= 2 || undefined}>
                <span>3</span>
                <div>
                  <strong>Turn it slowly until 100 %</strong>
                  <p>Watch the coverage plots fill. The result is stored in flash.</p>
                </div>
              </li>
              <li data-on={step >= 3 || undefined}>
                <span>4</span>
                <div>
                  <strong>Check the solution</strong>
                  <p>It should leave VRS for AHRS, with heading fine and NIS below its threshold.</p>
                </div>
              </li>
            </ol>
            <div className="actions">
              <button className="pill" data-variant="primary" onClick={() => run('magrecal multi')} disabled={!!busy || running}>
                Multi-axis
              </button>
              <button className="pill" onClick={() => run('magrecal single')} disabled={!!busy || running}>
                Single-axis
              </button>
              {(running || waiting) && (
                <button className="pill" data-variant="quiet" onClick={() => run('magrecal abort')}>
                  Abort
                </button>
              )}
            </div>
            <div style={{ marginTop: 16 }}>
              <div className="card-head">
                <span className="label">{stateText}</span>
                <span className="label">{progress.toFixed(0)} %</span>
              </div>
              <div className="meter" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                <i style={{ width: `${progress}%` }} />
              </div>
            </div>

            <span className="tick" style={{ marginTop: 28 }} />
            <span className="label">Gyro bias · DID_SYS_CMD 5</span>
            <p className="note" style={{ marginTop: 8 }}>
              Hold the unit still, then send a zero-motion update: the filter treats the next 2 s as stationary and
              pulls in the gyro bias. Repeat as needed.
            </p>
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="pill" data-variant="quiet" onClick={() => run('zeromotion')} disabled={!!busy}>
                Zero motion
              </button>
              <button
                className="pill"
                data-variant="danger"
                data-armed={armed || undefined}
                onClick={() => {
                  if (!armed) return setArmed(true)
                  setArmed(false)
                  void run('reset')
                }}
              >
                {armed ? 'Confirm reset' : 'Reset IMX'}
              </button>
            </div>
            <p className="note">
              Heading stays magnetic until <code>magDeclination</code> is set (radians) or the WMM bit and{' '}
              <code>refLla</code> are. From the CLI: <code>cltool -c /dev/ttyACM0 -magRecal1</code> is multi-axis (its
              help text has the numbers off by one).
            </p>
          </article>
        ) : (
          <article className="card">
            <span className="tick" />
            <span className="label">Procedure</span>
            <ol className="steps">
              <li data-on>
                <span>1</span>
                <div>
                  <strong>Mount it where it will run</strong>
                  <p>Calibrating on the desk solves the desk.</p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Use the device&rsquo;s own calibration</strong>
                  <p>
                    PX4 and ArduPilot: QGroundControl or Mission Planner&rsquo;s compass calibration. Breakout IMUs: a
                    hard- and soft-iron fit (e.g. ellipsoid) in your firmware, applied before the values are printed.
                  </p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>Check it here</strong>
                  <p>Turn the sensor through every orientation: the cloud should hug the circle, centred, with a small spread.</p>
                </div>
              </li>
            </ol>
            <p className="note">
              Without a magnetometer, fused heading is relative to where the sensor started and drifts slowly; roll and
              pitch stay referenced to gravity.
            </p>
          </article>
        )}
      </div>
    </section>
  )
}

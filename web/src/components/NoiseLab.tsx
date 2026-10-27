import { useEffect, useRef, useState } from 'react'

import { DEMO_NOISE } from '../demo'
import type { NoiseTerms } from '../lib/allan'
import type { NoiseRequest, NoiseResult } from '../lib/noise.worker'
import { onImu, store, useTick } from '../telemetry'
import { css, dot, download, INK, MONO, pow10, sig, stamp, useCanvas, usePointer } from './plot'
import { SectionHead } from './Section'

/*
 * Noise Lab: leave the sensor still, record, and read its noise off an
 * Allan deviation plot (IEEE 952): white noise N, bias instability B and
 * rate random walk K for every gyro and accelerometer axis. N and K are
 * what visual-inertial estimators and Kalibr ask for, so the capture ends
 * in an imu.yaml. Samples are block-averaged to ~100 Hz here, which keeps
 * the curve exact from 10 ms up, and the maths runs in a worker.
 */

const D = 180 / Math.PI
const UG = 9.80665e-6
const MOVE = 0.035 // rad/s (2 °/s): faster than this, the unit is not still
const TARGETS = [
  { s: 120, label: '2 min' },
  { s: 900, label: '15 min' },
  { s: 3600, label: '1 h' },
  { s: 7200, label: '2 h' },
]
const AXES = ['X', 'Y', 'Z']

type Phase = 'idle' | 'warming' | 'recording' | 'done'

interface Capture {
  phase: Phase
  times: number[]
  rate: number
  m0: number
  tau0: number
  sum: number[]
  count: number
  pending: number[]
  blocks: number
  samples: number
  moving: number
  gaps: number
  lastT: number
}

const fresh = (): Capture => ({
  phase: 'idle', times: [], rate: 0, m0: 1, tau0: 0.01, sum: [0, 0, 0, 0, 0, 0], count: 0, pending: [], blocks: 0,
  samples: 0, moving: 0, gaps: 0, lastT: 0,
})

const clock = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}

/** Worst axis: what a filter should assume. */
const worst = (t: NoiseTerms[], k: 'white' | 'randomWalk') => Math.max(...t.map((x) => x[k]).filter(isFinite))

function kalibrYaml(r: NoiseResult, rate: number, simulated: boolean) {
  const g = r.terms.slice(0, 3)
  const a = r.terms.slice(3)
  const kMeasured = r.terms.every((t) => t.randomWalkMeasured)
  const model = store.device?.model ?? 'IMU'
  const e = (v: number) => v.toExponential(3)
  return [
    `# Kalibr imu.yaml · ${model} · ${clock(r.seconds)} ${simulated ? 'simulated' : 'still'} · ${new Date().toISOString().slice(0, 10)}`,
    '# imu-bench Allan deviation (IEEE 952), noisiest axis.',
    kMeasured ? '# Random walk measured on every axis.' : '# Random walk: upper bound on some axes; record longer.',
    '# Moving platform? Inflate these (x2 to x10 is common).',
    'rostopic: /imu/data',
    `update_rate: ${rate.toFixed(1)}  # Hz`,
    `accelerometer_noise_density: ${e(worst(a, 'white'))}  # m/s^2/sqrt(Hz)`,
    `accelerometer_random_walk: ${e(worst(a, 'randomWalk'))}  # m/s^3/sqrt(Hz)`,
    `gyroscope_noise_density: ${e(worst(g, 'white'))}  # rad/s/sqrt(Hz)`,
    `gyroscope_random_walk: ${e(worst(g, 'randomWalk'))}  # rad/s^2/sqrt(Hz)`,
    '',
  ].join('\n')
}

const PAD = { l: 52, r: 16, t: 12, b: 26 }

function AllanChart({ result, sensor }: { result: NoiseResult | null; sensor: 'gyro' | 'acc' }) {
  const props = useRef({ result, sensor })
  props.current = { result, sensor }
  const tipRef = useRef<HTMLDivElement>(null)
  const box = useCanvas<HTMLDivElement>(({ g, W, H }) => {
    const { result: r, sensor: s } = props.current
    const tip = tipRef.current!
    if (!r) return tip.removeAttribute('data-on')
    const k = s === 'gyro' ? D * 3600 : 1 / UG // °/h or µg
    const ch = s === 'gyro' ? [0, 1, 2] : [3, 4, 5]
    const col = ['--x', '--y', '--z'].map(css)
    const curves = ch.map((c) => r.curves[c])
    const terms = ch.map((c) => r.terms[c])
    let tMin = Infinity
    let tMax = -Infinity
    let aMin = Infinity
    let aMax = -Infinity
    for (const c of curves)
      for (let i = 0; i < c.tau.length; i++) {
        if (c.n[i] < 2) continue
        tMin = Math.min(tMin, c.tau[i])
        tMax = Math.max(tMax, c.tau[i])
        aMin = Math.min(aMin, c.adev[i] * k)
        aMax = Math.max(aMax, c.adev[i] * k)
      }
    if (!isFinite(tMin) || !(aMin > 0)) return
    const t = terms[terms.map((x) => x.white).indexOf(Math.max(...terms.map((x) => x.white)))] // noisiest axis
    if (t.randomWalkMeasured) aMin = Math.min(aMin, t.randomWalk * k * 0.8) // its K marker sits at τ = 3 s
    const x0 = Math.floor(Math.log10(tMin))
    const x1 = Math.max(x0 + 2, Math.ceil(Math.log10(tMax)))
    const y0 = Math.floor(Math.log10(aMin))
    const y1 = Math.max(y0 + 2, Math.ceil(Math.log10(aMax)))
    const pw = W - PAD.l - PAD.r
    const ph = H - PAD.t - PAD.b
    const xOf = (tau: number) => PAD.l + ((Math.log10(tau) - x0) / (x1 - x0)) * pw
    const yOf = (v: number) => PAD.t + (1 - (Math.log10(v) - y0) / (y1 - y0)) * ph

    g.font = MONO
    g.lineWidth = 1
    for (let e = y0; e <= y1; e++) {
      const y = Math.round(yOf(10 ** e)) + 0.5
      g.strokeStyle = INK(0.08)
      g.beginPath()
      g.moveTo(PAD.l, y)
      g.lineTo(W - PAD.r, y)
      g.stroke()
      g.fillStyle = INK(0.5)
      g.textAlign = 'right'
      g.textBaseline = 'middle'
      g.fillText(pow10(e), PAD.l - 8, y)
    }
    for (let e = x0; e <= x1; e++) {
      const x = Math.round(xOf(10 ** e)) + 0.5
      g.strokeStyle = INK(0.05)
      g.beginPath()
      g.moveTo(x, PAD.t)
      g.lineTo(x, H - PAD.b)
      g.stroke()
      g.fillStyle = INK(0.5)
      g.textAlign = 'center'
      g.textBaseline = 'alphabetic'
      g.fillText(e === 0 ? '1 s' : e === 3 ? '1000 s' : `${10 ** e}`.replace(/^0\./, '.'), x, H - 6)
    }

    // asymptotes of the noisiest axis: white noise (−½), random walk (+½), and the floor
    g.save()
    g.beginPath()
    g.rect(PAD.l, PAD.t, pw, ph)
    g.clip()
    g.setLineDash([4, 4])
    g.strokeStyle = INK(0.32)
    const line = (f: (tau: number) => number) => {
      g.beginPath()
      g.moveTo(xOf(10 ** x0), yOf(f(10 ** x0)))
      g.lineTo(xOf(10 ** x1), yOf(f(10 ** x1)))
      g.stroke()
    }
    if (isFinite(t.white)) line((tau) => (t.white * k) / Math.sqrt(tau))
    if (t.randomWalkMeasured) line((tau) => t.randomWalk * k * Math.sqrt(tau / 3))
    if (isFinite(t.biasInstability)) line(() => 0.664 * t.biasInstability * k)
    g.setLineDash([])
    // the curves: solid where enough clusters back the point, faint beyond
    g.lineWidth = 2
    g.lineJoin = 'round'
    curves.forEach((c, i) => {
      // n falls as τ grows, so the trusted points are a prefix; the rest continue it faintly
      let last = -1
      while (last + 1 < c.tau.length && c.n[last + 1] >= 9) last++
      g.strokeStyle = col[i]
      for (const [from, to, alpha] of [
        [0, last, 1],
        [Math.max(0, last), c.tau.length - 1, 0.35],
      ]) {
        g.globalAlpha = alpha
        g.beginPath()
        for (let j = from; j <= to && c.n[j] >= 2; j++) {
          if (j === from) g.moveTo(xOf(c.tau[j]), yOf(c.adev[j] * k))
          else g.lineTo(xOf(c.tau[j]), yOf(c.adev[j] * k))
        }
        g.stroke()
      }
      g.globalAlpha = 1
    })
    g.restore()
    // labels on the asymptotes, in ink
    g.fillStyle = INK(0.85)
    g.textAlign = 'left'
    g.textBaseline = 'bottom'
    if (isFinite(t.white) && x0 <= 0 && x1 >= 0) {
      dot(g, xOf(1), yOf(t.white * k), INK(0.9), css('--surface'))
      g.fillText('N at τ = 1 s', xOf(1) + 8, yOf(t.white * k) - 4)
    }
    if (isFinite(t.biasInstability)) {
      const y = yOf(0.664 * t.biasInstability * k)
      dot(g, xOf(t.tauMin), y, INK(0.9), css('--surface'))
      g.textBaseline = 'top'
      g.fillText('minimum = 0.664 B', xOf(t.tauMin) + 8, y + 4)
    }
    if (t.randomWalkMeasured && Math.log10(3) <= x1) {
      const y = yOf(t.randomWalk * k)
      dot(g, xOf(3), y, INK(0.9), css('--surface'))
      g.textBaseline = 'bottom'
      g.fillText('K at τ = 3 s', xOf(3) + 8, y - 4)
    }

    // crosshair: the τ nearest the pointer
    const at = ptr.current
    if (at) {
      const tau = 10 ** (x0 + at.x * (x1 - x0))
      const c0 = curves[0]
      let j = 0
      for (let i = 0; i < c0.tau.length; i++) if (Math.abs(Math.log(c0.tau[i] / tau)) < Math.abs(Math.log(c0.tau[j] / tau))) j = i
      const x = xOf(c0.tau[j])
      g.strokeStyle = INK(0.35)
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(Math.round(x) + 0.5, PAD.t)
      g.lineTo(Math.round(x) + 0.5, H - PAD.b)
      g.stroke()
      curves.forEach((c, i) => dot(g, x, yOf(c.adev[j] * k), col[i], css('--surface')))
      tip.querySelector('header')!.textContent = `τ = ${sig(c0.tau[j], 3)} s${c0.n[j] < 9 ? ' · few clusters' : ''}`
      tip.querySelectorAll('b').forEach((el, i) => (el.textContent = sig(curves[i].adev[j] * k, 3)))
      tip.style.left = `${x + 14 + tip.offsetWidth > W ? x - 14 - tip.offsetWidth : x + 14}px`
      tip.dataset.on = ''
    } else tip.removeAttribute('data-on')
  }, 4)
  const ptr = usePointer(box, PAD)
  const unit = sensor === 'gyro' ? '°/h' : 'µg'
  return (
    <div ref={box} className="chart chart-tall" tabIndex={0} role="img" aria-label={`Allan deviation of the ${sensor === 'gyro' ? 'gyro' : 'accelerometer'}, ${unit}, log-log, X Y Z.`}>
      <canvas />
      <div ref={tipRef} className="tooltip" aria-hidden="true">
        <header />
        {AXES.map((n) => (
          <div key={n} style={{ '--k': `var(--${n.toLowerCase()})` } as React.CSSProperties}>
            <i />
            <b />
            <span>{n}</span>
          </div>
        ))}
        <small className="tip-unit">σ, {unit}</small>
      </div>
    </div>
  )
}

/** One sensor's rows: datasheet units first, the SI value estimators want underneath. */
function TermsTable({ r }: { r: NoiseResult }) {
  const rows: { name: string; terms: NoiseTerms; gyro: boolean }[] = [
    ...AXES.map((a, i) => ({ name: `Gyro ${a}`, terms: r.terms[i], gyro: true })),
    ...AXES.map((a, i) => ({ name: `Accel ${a}`, terms: r.terms[i + 3], gyro: false })),
  ]
  const e = (v: number) => (isFinite(v) ? v.toExponential(2) : '—')
  return (
    <table className="table noise">
      <thead>
        <tr>
          <th>Axis</th>
          <th>White noise · N</th>
          <th>Bias instability · B</th>
          <th>Random walk · K</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ name, terms: t, gyro }) => (
          <tr key={name}>
            <td>
              <i style={{ background: `var(--${name.slice(-1).toLowerCase()})` }} />
              {name}
            </td>
            <td>
              {gyro ? `${(t.white * D * 60).toFixed(3)} °/√h` : `${(t.white * 60).toFixed(4)} m/s/√h`}
              <small>{e(t.white)} {gyro ? 'rad/s/√Hz' : 'm/s²/√Hz'}</small>
            </td>
            <td>
              {gyro ? `${(t.biasInstability * D * 3600).toFixed(2)} °/h` : `${(t.biasInstability / UG).toFixed(1)} µg`}
              <small>at τ = {sig(t.tauMin, 2)} s</small>
            </td>
            <td>
              {t.randomWalkMeasured ? '' : '≤ '}
              {e(t.randomWalk)}
              <small>{gyro ? 'rad/s²/√Hz' : 'm/s³/√Hz'}{t.randomWalkMeasured ? '' : ' · upper bound'}</small>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function NoiseLab() {
  useTick(500)
  const worker = useRef<Worker | null>(null)
  const cap = useRef<Capture>(fresh())
  const [phase, setPhase] = useState<Phase>('idle')
  const [target, setTarget] = useState(900)
  const [result, setResult] = useState<NoiseResult | null>(null)
  const [simulated, setSimulated] = useState(false)
  const [copied, setCopied] = useState(false)
  const targetRef = useRef(target)
  targetRef.current = target
  const demo = store.src?.mode === 'demo'

  const post = (m: NoiseRequest) => worker.current?.postMessage(m)
  const flush = () => {
    const c = cap.current
    if (c.pending.length) post({ type: 'push', block: Float64Array.from(c.pending) })
    c.pending = []
  }
  const holdStill = (on: boolean) => {
    const d = (window as any).__demo
    if (demo && d?.still) d.still(on)
  }
  const stop = () => {
    const c = cap.current
    if (c.phase !== 'recording' && c.phase !== 'warming') return
    c.phase = c.blocks > 20 ? 'done' : 'idle'
    flush()
    post({ type: 'compute' })
    holdStill(false)
    setPhase(c.phase)
  }

  useEffect(() => {
    const w = new Worker(new URL('../lib/noise.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<NoiseResult>) => setResult(e.data)
    worker.current = w
    const off = onImu((m) => {
      const c = cap.current
      if (c.phase === 'warming') {
        // the stream's rate, from its own clock: blocks are whole numbers of samples
        c.times.push(m.time)
        if (c.times.length < 65) return
        c.rate = 64 / (c.times[64] - c.times[0])
        c.m0 = Math.max(1, Math.round(c.rate * 0.01))
        c.tau0 = c.m0 / c.rate
        post({ type: 'reset', tau0: c.tau0 })
        c.phase = 'recording'
        c.lastT = m.time
        return
      }
      if (c.phase !== 'recording') return
      if (m.time < c.lastT || m.time - c.lastT > 5 / c.rate) c.gaps++
      c.lastT = m.time
      const v = [m.gyro[0], m.gyro[1], m.gyro[2], m.acc[0], m.acc[1], m.acc[2]]
      for (let i = 0; i < 6; i++) c.sum[i] += v[i]
      if (Math.hypot(m.gyro[0], m.gyro[1], m.gyro[2]) > MOVE) c.moving++
      c.samples++
      if (++c.count < c.m0) return
      for (let i = 0; i < 6; i++) {
        c.pending.push(c.sum[i] / c.m0)
        c.sum[i] = 0
      }
      c.count = 0
      c.blocks++
      if (c.blocks * c.tau0 >= targetRef.current) stop()
    })
    let ticks = 0
    const id = setInterval(() => {
      const c = cap.current
      if (c.phase !== 'recording') return
      flush()
      // recompute every 2 s, every 10 s once the capture is long
      if (++ticks % (c.blocks * c.tau0 > 600 ? 40 : 8) === 0) post({ type: 'compute' })
    }, 250)
    return () => {
      off()
      clearInterval(id)
      w.terminate()
      holdStill(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = () => {
    cap.current = { ...fresh(), phase: 'warming' }
    setResult(null)
    setSimulated(false)
    holdStill(true)
    setPhase('warming')
  }
  const simulate = () => {
    stop()
    cap.current = { ...fresh(), phase: 'done', rate: 429, tau0: 0.01 }
    setSimulated(true)
    setResult(null)
    post({ type: 'synth', seconds: 7200, tau0: 0.01, ...DEMO_NOISE })
    setPhase('done')
  }

  const c = cap.current
  const elapsed = simulated ? (result?.seconds ?? 0) : c.blocks * c.tau0
  const progress = Math.min(100, (elapsed / target) * 100)
  const movingShare = c.samples ? c.moving / c.samples : 0
  const yaml = result ? kalibrYaml(result, c.rate || 100, simulated) : ''
  const recording = phase === 'recording' || phase === 'warming'

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(yaml)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      download('imu.yaml', yaml, 'text/yaml')
    }
  }
  const curvesCsv = () => {
    if (!result) return
    const names = ['gx', 'gy', 'gz', 'ax', 'ay', 'az']
    const rows = ['tau_s,' + names.map((n) => `adev_${n}`).join(',') + ',clusters']
    const c0 = result.curves[0]
    for (let i = 0; i < c0.tau.length; i++) rows.push([c0.tau[i].toPrecision(6), ...result.curves.map((c) => c.adev[i].toExponential(5)), c0.n[i].toFixed(1)].join(','))
    download(`allan-${stamp()}.csv`, rows.join('\n'), 'text/csv')
  }

  return (
    <section id="noise" className="section">
      <SectionHead
        n="07"
        label="Noise Lab"
        title={
          <>
            Measure the <em>noise</em>, feed the estimator
          </>
        }
        lede={
          <>
            Leave the sensor still and record. The Allan deviation splits its noise into white noise, bias instability and
            bias random walk for every axis: the numbers a visual-inertial estimator or Kalibr needs, measured on your unit
            instead of copied from a datasheet.
          </>
        }
      />
      <div className="filters" role="toolbar" aria-label="Noise capture">
        <span className="label">Record for</span>
        <div className="seg">
          {TARGETS.map((t) => (
            <button key={t.s} aria-pressed={target === t.s} onClick={() => setTarget(t.s)} disabled={recording}>
              {t.label}
            </button>
          ))}
        </div>
        {recording ? (
          <button className="pill" data-variant="primary" data-size="s" onClick={stop}>
            Stop and analyse
          </button>
        ) : (
          <button className="pill" data-variant="primary" data-size="s" onClick={start} disabled={!store.imu.time}>
            Start recording
          </button>
        )}
        {demo && (
          <button className="pill" data-variant="quiet" data-size="s" onClick={simulate} disabled={recording}>
            Simulate 2 h (demo)
          </button>
        )}
        <span className="spacer" />
        <span className="label">
          {phase === 'warming'
            ? 'Measuring the stream rate…'
            : recording
              ? `Recording ${clock(elapsed)} of ${clock(target)}`
              : result
                ? `${clock(result.seconds)} ${simulated ? 'simulated' : 'recorded'} · ${result.samples.toLocaleString('en-US')} samples`
                : 'Nothing recorded yet'}
        </span>
      </div>
      {recording && (
        <div className="meter" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100} style={{ marginBottom: 16 }}>
          <i style={{ width: `${progress}%` }} />
        </div>
      )}
      <div className="grid-2">
        {(['gyro', 'acc'] as const).map((s) => (
          <article className="card" key={s}>
            <span className="tick" />
            <div className="card-head">
              <span className="label">{s === 'gyro' ? 'Fig. 13 · Gyro Allan deviation' : 'Fig. 14 · Accelerometer Allan deviation'}</span>
              <button className="pill" data-variant="quiet" data-size="s" onClick={curvesCsv} disabled={!result}>
                CSV
              </button>
            </div>
            <h3 className="card-title">
              {s === 'gyro' ? 'Gyro' : 'Accelerometer'}
              <small>{s === 'gyro' ? '°/h' : 'µg'} against averaging time τ, s</small>
            </h3>
            <div className="legend">
              {AXES.map((n) => (
                <span key={n} style={{ '--k': `var(--${n.toLowerCase()})` } as React.CSSProperties}>
                  <i />
                  {n}
                </span>
              ))}
              <span>dashed: fitted N, B, K of the noisiest axis</span>
            </div>
            <AllanChart result={result} sensor={s} />
          </article>
        ))}
      </div>
      <div className="noise-out">
        <article className="card">
          <span className="tick" />
          <span className="label">Noise terms, IEEE 952</span>
          {result ? (
            <TermsTable r={result} />
          ) : (
            <p className="note">
              Set the unit on something heavy, let its temperature settle, start, and don&rsquo;t touch it. White noise
              is solid after a minute or two; bias instability needs about ten times the τ where the curve bottoms out;
              random walk needs hours.
            </p>
          )}
          {recording && movingShare > 0.01 && (
            <p className="note" data-level="warning">
              It moved during {(movingShare * 100).toFixed(0)} % of the capture: motion lands in the curve as noise.
              Start again with the unit untouched.
            </p>
          )}
          {c.gaps > 0 && (
            <p className="note" data-level="warning">
              {c.gaps} gap{c.gaps > 1 ? 's' : ''} in the stream: dropped samples bias the long-τ end.
            </p>
          )}
          {demo && (
            <p className="note">
              Demo: the simulated IMU holds still while it records. Its noise is white noise of 6.7×10⁻⁵ rad/s/√Hz (gyro)
              and 3.3×10⁻⁴ m/s²/√Hz (accel) plus a bias random walk; the table should find those numbers.
            </p>
          )}
        </article>
        <article className="card">
          <span className="tick" />
          <div className="card-head">
            <span className="label">Kalibr · imu.yaml</span>
            <div className="actions">
              <button className="pill" data-variant="quiet" data-size="s" onClick={copy} disabled={!result}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button className="pill" data-variant="quiet" data-size="s" onClick={() => download('imu.yaml', yaml, 'text/yaml')} disabled={!result}>
                Download
              </button>
            </div>
          </div>
          <pre className="code">{yaml || '# record a still capture to fill this in'}</pre>
          <p className="note">
            Kalibr, OpenVINS, VINS-Fusion and ORB-SLAM3 take these four numbers (names vary). The topic is what{' '}
            <code>--ros2-publish</code> publishes.
          </p>
        </article>
      </div>
    </section>
  )
}

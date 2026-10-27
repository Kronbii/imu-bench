import { useEffect, useRef, useState } from 'react'

import { bandRms, peaks, welch, type Psd } from '../lib/spectrum'
import { isLive, store, type Ring } from '../telemetry'
import { css, dot, download, INK, MONO, niceStep, pow10, sig, stamp, useCanvas, usePointer } from './plot'
import { SectionHead } from './Section'

/*
 * Vibration: where the energy of the IMU signal sits in frequency. Welch
 * spectra of the last few seconds per axis, the strongest peaks (a motor's
 * tone and harmonics, a frame resonance), and a spectrogram that shows how
 * they move with throttle. Everything below ~5 Hz is the motion itself.
 */

type Sensor = 'acc' | 'gyro'
const UNITS: Record<Sensor, { name: string; unit: string; psd: string }> = {
  acc: { name: 'Accelerometer', unit: 'm/s²', psd: '(m/s²)²/Hz' },
  gyro: { name: 'Gyro', unit: '°/s', psd: '(°/s)²/Hz' },
}
const SIZES = [256, 512, 1024, 2048]
const MOTION_HZ = 5 // below this it is motion, not vibration
const COLUMNS = 120 // spectrogram history: 30 s at 4 columns a second
const AXES = ['X', 'Y', 'Z']
let columnId = 0 // identifies the newest spectrogram column, so the image is rebuilt only when one arrives

interface Analysis {
  fs: number
  axes: Psd[]
  sum: Psd
  peaks: { hz: number; psd: number; rms: number; axis: number }[]
  rms: number[] // per axis, above MOTION_HZ
  seconds: number
}

/** The newest n samples of a ring as three plain arrays, and the rate they were taken at. */
function newest(ring: Ring, n: number) {
  n = Math.min(n, ring.size)
  const x = [new Float64Array(n), new Float64Array(n), new Float64Array(n)]
  const i0 = ring.size - n
  for (let i = 0; i < n; i++) {
    const j = ring.at(i0 + i)
    x[0][i] = ring.ch[0][j]
    x[1][i] = ring.ch[1][j]
    x[2][i] = ring.ch[2][j]
  }
  const span = n > 1 ? ring.t[ring.at(ring.size - 1)] - ring.t[ring.at(i0)] : 0
  return { x, fs: span > 0 ? (n - 1) / span : 0 }
}

function analyse(ring: Ring, size: number): Analysis | null {
  // about 4 s, at least 8 segments: steady peaks without hiding a throttle change
  const probe = newest(ring, 512)
  if (probe.fs <= 0) return null
  const want = Math.max(size * 4, Math.round(probe.fs * 4))
  const { x, fs } = newest(ring, want)
  if (x[0].length < size) return null
  const axes = x.map((v) => welch(v, fs, size))
  const sum: Psd = { f: axes[0].f, psd: axes[0].psd.map((_, k) => axes[0].psd[k] + axes[1].psd[k] + axes[2].psd[k]), segments: axes[0].segments }
  const df = sum.f[1]
  // peaks at least 6 Hz or 4 bins apart: a motor harmonic is never closer than its fundamental
  const found = peaks(sum, 4, MOTION_HZ, Math.max(6, 4 * sum.f[1])).map((p) => {
    const band = [p.hz - 2 * df, p.hz + 2 * df] as const
    const per = axes.map((a) => bandRms(a, ...band))
    return { ...p, rms: bandRms(sum, ...band), axis: per.indexOf(Math.max(...per)) }
  })
  return { fs, axes, sum, peaks: found, rms: axes.map((a) => bandRms(a, MOTION_HZ, fs / 2)), seconds: x[0].length / fs }
}

const PAD = { l: 52, r: 14, t: 12, b: 24 }

function SpectrumChart({ a, sensor }: { a: React.RefObject<Analysis | null>; sensor: Sensor }) {
  const range = useRef({ lo: -6, hi: 0 })
  const tipRef = useRef<HTMLDivElement>(null)
  const box = useCanvas<HTMLDivElement>(({ g, W, H }) => {
    const an = a.current
    const tip = tipRef.current!
    if (!an) {
      tip.removeAttribute('data-on')
      return
    }
    const col = ['--x', '--y', '--z'].map(css)
    const fMax = an.fs / 2
    const pw = W - PAD.l - PAD.r
    const ph = H - PAD.t - PAD.b
    // y: log10 of the density, the top decade over the largest value, 6 decades deep, eased
    let mx = -Infinity
    for (const s of an.axes) for (let k = 1; k < s.psd.length; k++) if (s.psd[k] > 0) mx = Math.max(mx, Math.log10(s.psd[k]))
    if (!isFinite(mx)) return
    const r = range.current
    const hi = Math.ceil(mx + 0.2)
    r.hi = hi > r.hi ? hi : r.hi + (hi - r.hi) * 0.08
    r.lo = r.hi - 6
    const xOf = (f: number) => PAD.l + (f / fMax) * pw
    const yOf = (lg: number) => PAD.t + (1 - (lg - r.lo) / (r.hi - r.lo)) * ph

    g.font = MONO
    g.textAlign = 'right'
    g.textBaseline = 'middle'
    for (let e = Math.ceil(r.lo); e <= Math.floor(r.hi); e++) {
      const y = Math.round(yOf(e)) + 0.5
      g.strokeStyle = INK(0.07)
      g.beginPath()
      g.moveTo(PAD.l, y)
      g.lineTo(W - PAD.r, y)
      g.stroke()
      g.fillStyle = INK(0.5)
      g.fillText(pow10(e), PAD.l - 8, y)
    }
    g.textAlign = 'center'
    g.textBaseline = 'alphabetic'
    const step = niceStep(fMax, 5)
    for (let f = 0; f <= fMax + 1e-9; f += step) {
      g.fillStyle = INK(0.5)
      g.fillText(f === 0 ? '0 Hz' : `${+f.toFixed(1)}`, Math.min(W - PAD.r - 14, Math.max(PAD.l + 10, xOf(f))), H - 6)
    }
    // the motion band, shaded: it is the movement, not vibration
    g.fillStyle = INK(0.035)
    g.fillRect(PAD.l, PAD.t, xOf(MOTION_HZ) - PAD.l, ph)

    g.save()
    g.beginPath()
    g.rect(PAD.l, PAD.t, pw, ph)
    g.clip()
    g.lineWidth = 2
    g.lineJoin = 'round'
    an.axes.forEach((s, i) => {
      g.strokeStyle = col[i]
      g.beginPath()
      for (let k = 1; k < s.psd.length; k++) {
        const y = yOf(Math.log10(Math.max(s.psd[k], 1e-30)))
        if (k === 1) g.moveTo(xOf(s.f[k]), y)
        else g.lineTo(xOf(s.f[k]), y)
      }
      g.stroke()
    })
    g.restore()

    // peak labels, in ink: the strongest three, skipping one that would sit on another
    g.font = MONO
    g.textAlign = 'center'
    const placed: number[] = []
    an.peaks.slice(0, 3).forEach((p) => {
      const top = Math.max(...an.axes.map((s) => s.psd[Math.round(p.hz / s.f[1])] ?? 0))
      const x = Math.min(W - PAD.r - 24, Math.max(PAD.l + 24, xOf(p.hz)))
      if (placed.some((q) => Math.abs(q - x) < 52)) return
      placed.push(x)
      const y = Math.max(PAD.t + 14, yOf(Math.log10(top)) - 10)
      g.fillStyle = INK(0.85)
      g.fillText(`${p.hz.toFixed(p.hz < 20 ? 1 : 0)} Hz`, x, y)
    })

    // crosshair
    const at = ptr.current
    if (at) {
      const f = at.x * fMax
      const k = Math.max(1, Math.min(an.sum.f.length - 1, Math.round(f / an.sum.f[1])))
      const x = xOf(an.sum.f[k])
      g.strokeStyle = INK(0.35)
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(Math.round(x) + 0.5, PAD.t)
      g.lineTo(Math.round(x) + 0.5, H - PAD.b)
      g.stroke()
      const surface = css('--surface')
      an.axes.forEach((s, i) => dot(g, x, yOf(Math.log10(Math.max(s.psd[k], 1e-30))), col[i], surface))
      tip.querySelector('header')!.textContent = `${an.sum.f[k].toFixed(1)} Hz`
      tip.querySelectorAll('b').forEach((el, i) => (el.textContent = sig(Math.sqrt(an.axes[i].psd[k]), 2)))
      tip.style.left = `${x + 14 + tip.offsetWidth > W ? x - 14 - tip.offsetWidth : x + 14}px`
      tip.dataset.on = ''
    } else tip.removeAttribute('data-on')
  })
  const ptr = usePointer(box, PAD)
  return (
    <div
      ref={box}
      className="chart chart-tall"
      tabIndex={0}
      role="img"
      aria-label={`${UNITS[sensor].name} power spectral density, X, Y and Z, log scale. Focus and use the arrow keys to read values.`}
    >
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
        <small className="tip-unit">√PSD, {UNITS[sensor].unit}/√Hz</small>
      </div>
    </div>
  )
}

// sequential blue, near the surface for nothing, light for strong: one hue, never a rainbow
const RAMP = ['#121614', '#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb']
function rampRgb(t: number) {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(x))
  const u = x - i
  const a = parseInt(RAMP[i].slice(1), 16)
  const b = parseInt(RAMP[i + 1].slice(1), 16)
  return [16, 8, 0].map((s) => Math.round(((a >> s) & 255) * (1 - u) + ((b >> s) & 255) * u))
}

interface Waterfall {
  fs: number
  bins: number
  cols: Float32Array[] // log10 PSD, summed over axes
  last: number // columnId of the newest
}

function Spectrogram({ w }: { w: React.RefObject<Waterfall> }) {
  const img = useRef<{ c: HTMLCanvasElement; n: number } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const pad = { l: 52, r: 14, t: 12, b: 24 }
  const box = useCanvas<HTMLDivElement>(({ g, W, H }) => {
    const wf = w.current
    const tip = tipRef.current!
    const pw = W - pad.l - pad.r
    const ph = H - pad.t - pad.b
    g.fillStyle = RAMP[0]
    g.fillRect(pad.l, pad.t, pw, ph)
    if (!wf.cols.length) return
    // rebuild the image when a column arrives: COLUMNS × bins pixels, then scale
    let top = -Infinity
    for (const c of wf.cols) for (let k = 1; k < c.length; k++) top = Math.max(top, c[k])
    const lo = top - 5
    if (!img.current || img.current.n !== wf.last) {
      const c = img.current?.c ?? document.createElement('canvas')
      c.width = COLUMNS
      c.height = wf.bins
      const cg = c.getContext('2d')!
      const id = cg.createImageData(COLUMNS, wf.bins)
      const off = COLUMNS - wf.cols.length
      for (let x = 0; x < COLUMNS; x++) {
        const col = wf.cols[x - off]
        for (let k = 0; k < wf.bins; k++) {
          const p = (wf.bins - 1 - k) * COLUMNS + x
          const [r, gg, b] = col ? rampRgb((col[k] - lo) / (top - lo)) : rampRgb(0)
          id.data[p * 4] = r
          id.data[p * 4 + 1] = gg
          id.data[p * 4 + 2] = b
          id.data[p * 4 + 3] = 255
        }
      }
      cg.putImageData(id, 0, 0)
      img.current = { c, n: wf.last }
    }
    g.imageSmoothingEnabled = true
    g.drawImage(img.current.c, pad.l, pad.t, pw, ph)

    const fMax = wf.fs / 2
    g.font = MONO
    g.textAlign = 'right'
    g.textBaseline = 'middle'
    const step = niceStep(fMax, 4)
    for (let f = 0; f <= fMax + 1e-9; f += step) {
      const y = pad.t + (1 - f / fMax) * ph
      g.fillStyle = INK(0.5)
      g.fillText(f === 0 ? '0 Hz' : `${+f.toFixed(1)}`, pad.l - 8, Math.max(pad.t + 6, y))
    }
    g.textAlign = 'center'
    g.textBaseline = 'alphabetic'
    for (let s = 0; s <= 30; s += 10) g.fillText(s === 0 ? 'now' : `−${s}s`, Math.min(W - pad.r - 12, pad.l + (1 - s / 30) * pw), H - 6)

    const at = ptr.current
    if (at) {
      const x = pad.l + at.x * pw
      const col = Math.floor(at.x * COLUMNS) - (COLUMNS - wf.cols.length)
      const yFrac = Math.max(0, Math.min(1, (at.y * H - pad.t) / ph))
      const k = Math.round((1 - yFrac) * (wf.bins - 1))
      const c = wf.cols[col]
      g.strokeStyle = INK(0.5)
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(Math.round(x) + 0.5, pad.t)
      g.lineTo(Math.round(x) + 0.5, H - pad.b)
      g.stroke()
      if (c) {
        tip.querySelector('header')!.textContent = `${((COLUMNS - 1 - Math.floor(at.x * COLUMNS)) / 4).toFixed(1)} s ago`
        tip.querySelector('b')!.textContent = `${((k * fMax) / (wf.bins - 1)).toFixed(1)} Hz`
        tip.querySelector('em')!.textContent = `${(10 * (c[k] - top)).toFixed(0)} dB`
        tip.style.left = `${x + 14 + tip.offsetWidth > W ? x - 14 - tip.offsetWidth : x + 14}px`
        tip.dataset.on = ''
      } else tip.removeAttribute('data-on')
    } else tip.removeAttribute('data-on')
  })
  const ptr = usePointer(box, pad)
  return (
    <div ref={box} className="chart chart-tall" tabIndex={0} role="img" aria-label="Spectrogram of the last 30 seconds: time across, frequency up, brighter is stronger.">
      <canvas />
      <div ref={tipRef} className="tooltip" aria-hidden="true">
        <header />
        <div>
          <b />
          <em className="tip-unit" />
        </div>
      </div>
    </div>
  )
}

export function Vibration() {
  const [sensor, setSensor] = useState<Sensor>('acc')
  const [size, setSize] = useState(512)
  const [paused, setPaused] = useState(false)
  const [snap, setSnap] = useState<Analysis | null>(null)
  const current = useRef<Analysis | null>(null)
  const wf = useRef<Waterfall>({ fs: 0, bins: 0, cols: [], last: 0 })

  useEffect(() => {
    wf.current = { fs: 0, bins: 0, cols: [], last: 0 }
    const id = setInterval(() => {
      if (paused) return
      const ring = sensor === 'acc' ? store.series.acc : store.series.gyro
      if (!isLive()) return
      const an = analyse(ring, size)
      current.current = an
      if (an) {
        // a spectrogram column from the newest quarter second (256-point segments: time over resolution)
        const { x, fs } = newest(ring, Math.max(256, Math.round(an.fs * 0.5)))
        const s = x.map((v) => welch(v, fs, 256))
        const W = wf.current
        if (Math.abs(W.fs - an.fs) > an.fs * 0.05) Object.assign(W, { fs: an.fs, bins: 129, cols: [] })
        W.cols.push(Float32Array.from(s[0].psd, (_, k) => Math.log10(s[0].psd[k] + s[1].psd[k] + s[2].psd[k] + 1e-30)))
        W.last = ++columnId
        if (W.cols.length > COLUMNS) W.cols.shift()
      }
      setSnap(an)
    }, 250)
    return () => clearInterval(id)
  }, [sensor, size, paused])

  const u = UNITS[sensor]
  const lowRate = snap && snap.fs < 300
  const exportCsv = () => {
    const an = current.current
    if (!an) return
    const rows = ['f_hz,x_psd,y_psd,z_psd'] // density in the unit the panel shows
    for (let k = 0; k < an.sum.f.length; k++) rows.push([an.sum.f[k].toFixed(3), ...an.axes.map((s) => s.psd[k].toExponential(4))].join(','))
    download(`psd-${sensor}-${stamp()}.csv`, rows.join('\n'), 'text/csv')
  }

  return (
    <section id="vibration" className="section">
      <SectionHead
        n="03"
        label="Vibration"
        title={
          <>
            Where the <em>vibration</em> lives
          </>
        }
        lede={
          <>
            The same IMU signal, by frequency. Motor tones, their harmonics and frame resonances show up as peaks: the
            frequencies a notch filter should remove, and the ones that blur a camera or wreck an estimator. Mount the
            sensor on the running machine and read them here.
          </>
        }
      />
      <div className="filters" role="toolbar" aria-label="Spectrum settings">
        <span className="label">Sensor</span>
        <div className="seg">
          {(['acc', 'gyro'] as Sensor[]).map((s) => (
            <button key={s} aria-pressed={sensor === s} onClick={() => setSensor(s)}>
              {UNITS[s].name}
            </button>
          ))}
        </div>
        <span className="label">FFT</span>
        <div className="seg">
          {SIZES.map((n) => (
            <button key={n} aria-pressed={size === n} onClick={() => setSize(n)}>
              {n}
            </button>
          ))}
        </div>
        <button className="pill" data-variant={paused ? 'primary' : 'quiet'} data-size="s" onClick={() => setPaused(!paused)}>
          {paused ? 'Resume' : 'Freeze'}
        </button>
        <span className="spacer" />
        <span className="label">
          {snap ? `${snap.fs.toFixed(0)} Hz stream · ${(snap.fs / size).toFixed(2)} Hz bins · ${snap.seconds.toFixed(1)} s` : 'Waiting for IMU data'}
        </span>
      </div>
      <div className="grid-2">
        <article className="card">
          <span className="tick" />
          <div className="card-head">
            <span className="label">Fig. 07 · Power spectral density, Welch</span>
            <button className="pill" data-variant="quiet" data-size="s" onClick={exportCsv} disabled={!snap}>
              CSV
            </button>
          </div>
          <h3 className="card-title">
            {u.name} spectrum
            <small>{u.psd}, log</small>
          </h3>
          <div className="legend">
            {AXES.map((n, i) => (
              <span key={n} style={{ '--k': `var(--${n.toLowerCase()})` } as React.CSSProperties}>
                <i />
                {n}
                <b>{snap ? sig(snap.rms[i], 3) : '—'}</b>
              </span>
            ))}
            <span>
              RMS above {MOTION_HZ} Hz, {u.unit}
            </span>
          </div>
          <SpectrumChart a={current} sensor={sensor} />
        </article>
        <article className="card">
          <span className="tick" />
          <div className="card-head">
            <span className="label">Fig. 08 · Spectrogram, all axes</span>
          </div>
          <h3 className="card-title">
            Last 30 seconds
            <small>brighter = stronger</small>
          </h3>
          <div className="legend">
            <span className="ramp-key">
              <i className="ramp" />
              −50 dB … peak
            </span>
          </div>
          <Spectrogram w={wf} />
        </article>
      </div>
      <div className="grid-2" style={{ marginTop: 16 }}>
        <article className="card">
          <span className="tick" />
          <span className="label">Strongest peaks above {MOTION_HZ} Hz</span>
          <table className="table">
            <thead>
              <tr>
                <th>Frequency</th>
                <th>RMS</th>
                <th>Strongest on</th>
                <th>As a rotation</th>
              </tr>
            </thead>
            <tbody>
              {(snap?.peaks ?? []).map((p) => (
                <tr key={p.hz}>
                  <td>{p.hz.toFixed(1)} Hz</td>
                  <td>
                    {sig(p.rms, 3)} {u.unit}
                  </td>
                  <td>{AXES[p.axis]}</td>
                  <td>{Math.round(p.hz * 60).toLocaleString('en-US')} rpm</td>
                </tr>
              ))}
              {!snap?.peaks.length && (
                <tr>
                  <td colSpan={4}>No peaks yet</td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="note">
            A motor&rsquo;s first peak sits at its speed (rpm ÷ 60), with harmonics at whole multiples; a peak that stays
            put as throttle changes is the frame resonating. Pick notch centres from the first column, and check the
            spectrogram: a tone that sweeps needs a tracking notch.
          </p>
        </article>
        <article className="card">
          <span className="tick" />
          <span className="label">Reading it right</span>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Highest frequency shown</dt>
            <dd>{snap ? `${(snap.fs / 2).toFixed(0)} Hz (half the stream rate)` : '—'}</dd>
            <dt>Resolution</dt>
            <dd>{snap ? `${(snap.fs / size).toFixed(2)} Hz per bin, ${snap.axes[0].segments} segments averaged` : '—'}</dd>
            <dt>Window</dt>
            <dd>Hann, 50 % overlap, mean removed per segment</dd>
          </dl>
          {lowRate ? (
            <p className="note" data-level="warning">
              This stream runs at {snap!.fs.toFixed(0)} Hz, so anything above {(snap!.fs / 2).toFixed(0)} Hz folds back
              (aliases) onto lower frequencies. For an IMX, run the bridge with <code>--raw-mult 1</code> for the 1 kHz
              IMU stream.
            </p>
          ) : (
            <p className="note">
              Vibration above half the sample rate folds back (aliases) onto lower frequencies; the IMX filters before
              sampling, many breakout boards don&rsquo;t. A wider FFT separates close peaks but reacts more slowly.
            </p>
          )}
          {store.src?.mode === 'demo' && (
            <p className="note">
              Demo: a simulated motor stepping through four throttle settings (68–94 Hz) with its second harmonic, and
              a 23 Hz frame mode on Z.
            </p>
          )}
        </article>
      </div>
    </section>
  )
}

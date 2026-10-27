import { useEffect, useState } from 'react'

import { fitEllipsoid, type MagCal } from '../lib/ellipsoid'
import { has, setMagCal, store, useTick } from '../telemetry'
import { download, stamp } from './plot'

/*
 * Hard- and soft-iron calibration for any magnetometer, done here: turn the
 * sensor through every orientation, fit an ellipsoid to the last minute of
 * field vectors, preview the correction on the plots above, then have the
 * bench apply it to the stream (before fusion, recording and ROS 2) or take
 * the numbers to your firmware.
 */

// 48 directions spread evenly over the sphere (Fibonacci lattice): coverage = share of them visited
const BINS = Array.from({ length: 48 }, (_, i) => {
  const z = 1 - (2 * (i + 0.5)) / 48
  const r = Math.sqrt(1 - z * z)
  const a = i * Math.PI * (3 - Math.sqrt(5))
  return [r * Math.cos(a), r * Math.sin(a), z]
})
const MIN_COVERAGE = 0.45
const MIN_SAMPLES = 300

function coverage(centre: number[]) {
  const r = store.magCloud
  const hit = new Uint8Array(BINS.length)
  for (let i = 0; i < r.size; i++) {
    const j = r.at(i)
    const v = [r.ch[0][j] - centre[0], r.ch[1][j] - centre[1], r.ch[2][j] - centre[2]]
    const n = Math.hypot(v[0], v[1], v[2]) || 1
    let best = 0
    let bd = -2
    for (let b = 0; b < BINS.length; b++) {
      const d = (BINS[b][0] * v[0] + BINS[b][1] * v[1] + BINS[b][2] * v[2]) / n
      if (d > bd) {
        bd = d
        best = b
      }
    }
    hit[best] = 1
  }
  return hit.reduce((s, h) => s + h, 0) / BINS.length
}

const f4 = (v: number) => (v >= 0 ? ' ' : '−') + Math.abs(v).toFixed(4)

function cHeader(cal: MagCal) {
  const W = cal.matrix
  const c = (v: number) => `${v.toFixed(6)}f`
  return [
    '// Magnetometer hard- and soft-iron calibration, from imu-bench (ellipsoid fit).',
    `// ${cal.samples} samples; |B| spread ${(cal.spreadBefore * 100).toFixed(1)} % before, ${(cal.spreadAfter * 100).toFixed(2)} % after.`,
    '// Apply to every raw sample, in the sensor frame:  m_cal = MAG_SOFT_IRON * (m_raw - MAG_HARD_IRON)',
    `static const float MAG_HARD_IRON[3] = {${cal.center.map(c).join(', ')}};`,
    'static const float MAG_SOFT_IRON[3][3] = {',
    ...[0, 1, 2].map((i) => `    {${[W[i * 3], W[i * 3 + 1], W[i * 3 + 2]].map(c).join(', ')}},`),
    '};',
    '',
  ].join('\n')
}

export function MagFit({ preview }: { preview: React.RefObject<MagCal | null> }) {
  useTick(500)
  const [fit, setFit] = useState<MagCal | null>(null)
  const [show, setShow] = useState<'raw' | 'corrected'>('raw')
  const [cover, setCover] = useState(0)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const demo = store.src?.mode === 'demo'
  const applied = store.magcal

  useEffect(() => {
    const id = setInterval(() => setCover(coverage(fit?.center ?? [0, 0, 0])), 500)
    return () => clearInterval(id)
  }, [fit])
  useEffect(() => {
    preview.current = show === 'corrected' && fit && !applied ? fit : null
  }, [show, fit, applied, preview])

  const n = store.magCloud.size
  const ready = n >= MIN_SAMPLES && cover >= MIN_COVERAGE
  const run = () => {
    const r = store.magCloud
    const pts: number[][] = []
    for (let i = 0; i < r.size; i++) {
      const j = r.at(i)
      pts.push([r.ch[0][j], r.ch[1][j], r.ch[2][j]])
    }
    const cal = fitEllipsoid(pts)
    setFit(cal)
    setShow(cal ? 'corrected' : 'raw')
    setMsg(cal ? null : 'No ellipsoid fits these points: the orientations cover too little of the sphere. Keep turning it.')
  }
  const act = async (cal: MagCal | null) => {
    setBusy(true)
    try {
      await setMagCal(cal)
      setMsg(cal ? null : 'Correction removed: the stream is raw again.')
      if (cal) setShow('raw') // the stream itself is corrected now
    } catch (e) {
      setMsg(`Not applied: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const json = () =>
    JSON.stringify(
      { center: fit!.center, matrix: fit!.matrix, radius: fit!.radius, spreadBefore: fit!.spreadBefore, spreadAfter: fit!.spreadAfter, samples: fit!.samples },
      null,
      2,
    )

  return (
    <div className="grid-2" style={{ marginTop: 16 }}>
      <article className="card">
        <span className="tick" />
        <div className="card-head">
          <span className="label">Fig. 12 · Hard- and soft-iron fit</span>
          {fit && !applied && (
            <div className="seg" role="group" aria-label="Plots show">
              <button aria-pressed={show === 'raw'} onClick={() => setShow('raw')}>
                Raw
              </button>
              <button aria-pressed={show === 'corrected'} onClick={() => setShow('corrected')}>
                Corrected
              </button>
            </div>
          )}
        </div>
        <h3 className="card-title">
          Fit the calibration here
          <small>ellipsoid, least squares</small>
        </h3>
        <p className="note" style={{ marginTop: 8 }}>
          Steel nearby squashes the sphere the field should trace into an ellipsoid (soft iron); magnets and currents
          shift its centre (hard iron). Turn the sensor slowly through every orientation, as if painting the inside of a
          ball, until coverage passes {Math.round(MIN_COVERAGE * 100)} %, then fit.
        </p>
        <div style={{ marginTop: 16 }}>
          <div className="card-head">
            <span className="label">Orientations covered</span>
            <span className="label">{Math.round(cover * 100)} %</span>
          </div>
          <div className="meter" role="progressbar" aria-valuenow={Math.round(cover * 100)} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${cover * 100}%` }} />
          </div>
        </div>
        <div className="actions" style={{ marginTop: 16 }}>
          <button className="pill" data-variant="primary" onClick={run} disabled={!ready || !!applied}>
            Fit
          </button>
          {demo && (
            <button className="pill" onClick={() => (window as any).__demo?.tumble?.()}>
              Tumble it (demo)
            </button>
          )}
          <button className="pill" data-variant="quiet" onClick={() => (store.magCloud.clear(), setFit(null))}>
            Start over
          </button>
        </div>
        {!ready && !applied && (
          <p className="note">
            {n < MIN_SAMPLES ? `${n} of ${MIN_SAMPLES} samples.` : 'Not enough orientations yet.'} The cloud keeps the last
            minute.
          </p>
        )}
        {msg && <p className="note" data-level="warning">{msg}</p>}
        {applied && (
          <p className="note" data-level="good">
            Applied: the bench corrects every magnetometer sample before fusion, recording and ROS 2. The plots above now
            show the corrected field; it should hug the circle from every side.
          </p>
        )}
      </article>
      <article className="card">
        <span className="tick" />
        <div className="card-head">
          <span className="label">Result</span>
          {fit && (
            <div className="actions">
              <button className="pill" data-variant="quiet" data-size="s" onClick={() => download(`magcal-${stamp()}.json`, json(), 'application/json')}>
                JSON
              </button>
              <button className="pill" data-variant="quiet" data-size="s" onClick={() => download('magcal.h', cHeader(fit), 'text/x-c')}>
                C header
              </button>
            </div>
          )}
        </div>
        {fit ? (
          <>
            <div className="big-state compact" style={{ marginTop: 10 }}>
              <b className="mono">
                {(fit.spreadBefore * 100).toFixed(1)}% → {(fit.spreadAfter * 100).toFixed(2)}%
              </b>
              <span className="label">|B| spread across orientations</span>
            </div>
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Hard iron (centre)</dt>
              <dd>{fit.center.map((v) => v.toFixed(3)).join(', ')}</dd>
              <dt>Field strength after</dt>
              <dd>{fit.radius.toFixed(3)} {store.mag.unit === 'norm' ? '(normalised)' : store.mag.unit}</dd>
              <dt>Samples</dt>
              <dd>{fit.samples}</dd>
            </dl>
            <span className="label" style={{ display: 'block', marginTop: 14 }}>
              Soft iron, applied as W · (m − c)
            </span>
            <pre className="code matrix">{[0, 1, 2].map((i) => [0, 1, 2].map((j) => f4(fit.matrix[i * 3 + j])).join('  ')).join('\n')}</pre>
            <div className="actions" style={{ marginTop: 14 }}>
              {applied ? (
                <button className="pill" onClick={() => act(null)} disabled={busy}>
                  Remove correction
                </button>
              ) : (
                <button className="pill" data-variant="primary" onClick={() => act(fit)} disabled={busy}>
                  Apply to the stream
                </button>
              )}
            </div>
            <p className="note">
              {has('panel:imx')
                ? 'The IMX computes heading on board with its own calibration (the procedure above); this corrects the magnetometer stream the bench records and publishes.'
                : 'Sensors without on-board fusion get it in the bench’s Madgwick heading too. Or take the C header to your firmware.'}{' '}
              With <code>--magcal FILE</code> the server keeps it across restarts.
            </p>
          </>
        ) : applied ? (
          <>
            <p className="note">A correction is active on the stream.</p>
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="pill" onClick={() => act(null)} disabled={busy}>
                Remove correction
              </button>
            </div>
          </>
        ) : (
          <p className="note">
            The fit gives a centre (hard iron) and a 3×3 matrix (soft iron). The spread of |B| across orientations is the
            check: a few percent before, well under one percent after.
          </p>
        )}
      </article>
    </div>
  )
}

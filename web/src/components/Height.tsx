import { useState } from 'react'

import { baroAltitude, ISA_QNH, relHeight, setQnh, store, useTick, zeroHeight } from '../telemetry'

/*
 * The barometer, honestly: it measures pressure. Height comes from the
 * standard atmosphere (about 8.3 m per hPa near sea level), so changes over
 * seconds to minutes are good to a few centimetres, while absolute altitude
 * is only as good as the sea-level pressure (QNH) it is referred to.
 */

const signed = (v: number, d: number) => (isNaN(v) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d))

/** Standard deviation of one channel of the height ring over the last `secs`. */
function spread(channel: number, secs: number) {
  const r = store.series.height
  if (r.size < 10) return NaN
  const end = r.lastT
  let n = 0
  let s = 0
  let s2 = 0
  for (let i = r.size - 1; i >= 0; i--) {
    const j = r.at(i)
    if (end - r.t[j] > secs) break
    const v = r.ch[channel][j]
    n++
    s += v
    s2 += v * v
  }
  return n > 5 ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : NaN
}

export function HeightCard() {
  useTick(250)
  const b = store.baro
  const h = store.height
  const [draft, setDraft] = useState(String(h.qnh))
  const rel = relHeight()
  const pAlt = b ? baroAltitude(h.p, ISA_QNH) : NaN
  const qAlt = b ? baroAltitude(h.p, h.qnh) : NaN
  const custom = Math.abs(h.qnh - ISA_QNH) > 0.01
  const rawSd = spread(0, 5)
  const smoothSd = spread(1, 5)

  const applyQnh = () => {
    const v = parseFloat(draft)
    if (v > 800 && v < 1100) setQnh(v)
    else setDraft(String(h.qnh))
  }

  return (
    <article className="card">
      <span className="tick" />
      <div className="card-head">
        <span className="label">Barometer · height</span>
        <button className="pill" data-variant="quiet" data-size="s" onClick={zeroHeight} disabled={!b}>
          Zero height
        </button>
      </div>
      <div className="big-state" style={{ marginTop: 10 }}>
        <b className="mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {signed(rel, 2)} m
        </b>
        <span className="label">above zero</span>
      </div>
      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>Pressure</dt>
        <dd>{b ? `${b.pressure.toFixed(3)} kPa · ${(b.pressure * 10).toFixed(2)} hPa` : '—'}</dd>
        <dt>Pressure altitude</dt>
        <dd>{isNaN(pAlt) ? '—' : `${pAlt.toFixed(1)} m (standard 1013.25 hPa)`}</dd>
        {custom && (
          <>
            <dt>Altitude, QNH</dt>
            <dd>{isNaN(qAlt) ? '—' : `${qAlt.toFixed(1)} m (${h.qnh.toFixed(2)} hPa)`}</dd>
          </>
        )}
        <dt>Spread, last 5 s</dt>
        <dd>{isNaN(rawSd) ? '—' : `${(rawSd * 100).toFixed(1)} cm raw · ${(smoothSd * 100).toFixed(1)} cm smoothed`}</dd>
        {b?.temp != null && (
          <>
            <dt>Sensor temperature</dt>
            <dd>{b.temp.toFixed(1)} °C</dd>
          </>
        )}
      </dl>
      <div className="filters" style={{ marginTop: 14, marginBottom: 0 }}>
        <label className="label" htmlFor="qnh">
          QNH, hPa
        </label>
        <input
          id="qnh"
          className="field mono"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={applyQnh}
          onKeyDown={(e) => e.key === 'Enter' && applyQnh()}
        />
        <button className="pill" data-variant="quiet" data-size="s" onClick={() => (setQnh(ISA_QNH), setDraft(String(ISA_QNH)))}>
          Standard
        </button>
      </div>
      <p className="note">
        A barometer measures pressure; height comes from the standard atmosphere, about 8.3 m per hPa near sea level.
        Good for changes over seconds to minutes. Weather moves it by metres over hours, so absolute altitude is only
        as good as the QNH you enter (your nearest airport&rsquo;s METAR, the Q group). The spread of a still sensor
        is its noise.
      </p>
    </article>
  )
}

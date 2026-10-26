import { useEffect, useRef, useState } from 'react'

import { solution } from '../decode'
import { Specimen } from '../specimen/Specimen'
import { displayEuler, onFrame, shortDev, store, useTick } from '../telemetry'
import { AttitudeIndicator, HeadingIndicator } from './Instruments'

const R2D = 180 / Math.PI
const signed = (v: number) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1)

function Readouts() {
  const val = useRef<(HTMLElement | null)[]>([])
  const sig = useRef<(HTMLElement | null)[]>([])
  useEffect(() => {
    let last = 0
    return onFrame((now) => {
      if (now - last < 60) return
      last = now
      const [r, p, y] = displayEuler()
      const live = store.att.have
      const text = live ? [signed(r) + '°', signed(p) + '°', y.toFixed(1) + '°'] : ['—', '—', '—']
      text.forEach((t, i) => {
        const el = val.current[i]
        if (el && el.textContent !== t) el.textContent = t
      })
      const s = store.sigma?.StdAttNed
      if (s) {
        const tilt = Math.max(s[0], s[1]) * R2D
        const v = [`1σ ${tilt.toFixed(3)}°`, `1σ ${tilt.toFixed(3)}°`, `1σ ${(s[2] * R2D).toFixed(2)}°`]
        v.forEach((t, i) => {
          const el = sig.current[i]
          if (el && el.textContent !== t) el.textContent = t
        })
      }
    })
  }, [])

  const items: [string, string][] = [
    ['Roll', '--x'],
    ['Pitch', '--y'],
    ['Yaw', '--z'],
  ]
  return (
    <div className="readouts" aria-live="off">
      {items.map(([name, k], i) => (
        <div key={name} className="readout" style={{ '--k': `var(${k})` } as React.CSSProperties}>
          <span className="label">
            <i />
            {name}
          </span>
          <b ref={(el) => void (val.current[i] = el)}>—</b>
          <small ref={(el) => void (sig.current[i] = el)}>1σ —</small>
        </div>
      ))}
    </div>
  )
}

function HeadingCaption() {
  useTick(500)
  const sol = solution(store.att.insStatus)
  const cfg = store.cfg
  const magnetic = !cfg || (cfg.magDeclination === 0 && (cfg.sysCfgBits & 0x800) === 0)
  const text = !store.att.have
    ? 'Heading'
    : sol.code === 7 || sol.code === 8
      ? 'Heading · no north (VRS)'
      : magnetic
        ? 'Heading · magnetic north'
        : 'Heading · true north'
  return <span className="label">{text}</span>
}

function Identity() {
  useTick(1000)
  const dev = store.dev
  return (
    <p className="hero-id">
      ID lock · RUG-3-IMX-5 · SN {dev ? dev.serialNumber : '——————'}
    </p>
  )
}

function Where() {
  useTick(1000)
  const dev = store.dev
  const src = store.src
  const where =
    src?.mode === 'sim' ? 'simulated stream' : src?.mode === 'replay' ? `replay · ${src.detail}` : shortDev(store.link?.dev ?? store.link?.port)
  return (
    <span className="hero-where">
      fw {dev?.firmwareVer ?? '—'} · {where}
      {store.yawOffset ? ` · yaw zeroed at ${store.yawOffset.toFixed(1)}°` : ''}
    </span>
  )
}

export function Hero() {
  const [resetView, setResetView] = useState(0)
  const [, force] = useState(0)

  const zeroYaw = () => {
    store.yawOffset = store.yawOffset ? 0 : store.att.theta[2] * R2D
    force((n) => n + 1)
  }

  return (
    <section id="attitude" className="hero" aria-label="Attitude">
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-text">
        <Identity />
        <div className="name-box">
          <h1 className="name fx">
            IMX-5<span>.</span>
          </h1>
          <span className="lock" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>
        <p className="hero-sub">
          Attitude, heading and raw inertial signals, <em>live</em>.
        </p>
        <Readouts />
        <div className="instruments">
          <div className="instrument">
            <AttitudeIndicator />
            <span className="label">Attitude</span>
          </div>
          <div className="instrument">
            <HeadingIndicator />
            <HeadingCaption />
          </div>
        </div>
        <div className="hero-actions">
          <button className="pill" data-variant={store.yawOffset ? 'primary' : undefined} onClick={zeroYaw}>
            {store.yawOffset ? 'Restore yaw' : 'Zero yaw'}
          </button>
          <button className="pill" data-variant="quiet" onClick={() => setResetView((n) => n + 1)}>
            Reset view
          </button>
          <Where />
        </div>
      </div>
      <Specimen resetView={resetView} />
    </section>
  )
}

import { Calibration } from './components/Calibration'
import { Device } from './components/Device'
import { Health } from './components/Health'
import { Hero } from './components/Hero'
import { Signals } from './components/Signals'
import { linkState, store, useTick } from './telemetry'

function LinkPill() {
  useTick(300)
  const { state, label, where } = linkState()
  const hz = store.rates.ins1
  return (
    <span className="linkpill" data-state={state} role="status" aria-live="polite">
      <span className="dot" />
      <b>{label}</b>
      <span className="port">{where}</span>
      {state !== 'down' && hz ? <span>{hz.toFixed(0)} Hz</span> : null}
    </span>
  )
}

function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M5 11V5h6M27 11V5h-6M5 21v6h6M27 21v6h-6" fill="none" stroke="var(--sage)" strokeWidth="2.4" />
      <circle cx="16" cy="16" r="3.4" fill="var(--sage)" />
    </svg>
  )
}

export function App() {
  return (
    <>
      <header className="top">
        <a className="brand" href="#attitude" aria-label="IMX-5 bench, top">
          <Mark />
          IMX-5 bench
          <small>RUG-3 · test</small>
        </a>
        <nav className="nav" aria-label="Sections">
          <a href="#attitude">Attitude</a>
          <a href="#signals">Signals</a>
          <a href="#health">Health</a>
          <a href="#calibrate">Calibrate</a>
          <a href="#device">Device</a>
        </nav>
        <LinkPill />
      </header>
      <main>
        <Hero />
        <Signals />
        <Health />
        <Calibration />
        <Device />
      </main>
      <footer className="footer">
        <span>RUG-3-IMX-5 · Inertial Sense SDK 2.7.1 · bridge → /stream (SSE, NDJSON batches)</span>
        <span>Axes: X forward, away from MAIN · Y right · Z down · NED</span>
      </footer>
    </>
  )
}

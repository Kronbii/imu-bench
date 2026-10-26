import { useState } from 'react'

import { bit, genFaults, hex, HDW_FLAGS, INS_FLAGS, parseErrors, resetCause, solution, sysCfg, type Level } from '../decode'
import { sendCommand, store, useTick } from '../telemetry'
import { SectionHead, StatusIcon, StatusRow } from './Section'

const R2D = 180 / Math.PI

// always shown (dim when clear): the flags an AHRS without GNSS can actually raise; others appear only when set
const AHRS_FLAGS = new Set([0x1, 0x10, 0x800, 0x2000, 0x00400000, 0x00800000])
const f = (v: number | undefined, d = 2) => (v === undefined || v === null || !isFinite(v) ? '—' : v.toFixed(d))

/** Streams the bridge asks for, and the rate each should arrive at on this unit. */
const STREAMS: [string, string, number][] = [
  ['ins1', 'DID_INS_1', 143],
  ['ins2', 'DID_INS_2', 143],
  ['imu', 'DID_IMU', 71.4],
  ['mag', 'DID_MAGNETOMETER', 50],
  ['baro', 'DID_BAROMETER', 50],
  ['sys', 'DID_SYS_PARAMS', 10],
  ['sigma', 'DID_INL2_NED_SIGMA', 7],
]

export function Health() {
  useTick(250)
  const [clearing, setClearing] = useState(false)
  const ins = store.att.insStatus
  const hdw = store.att.hdwStatus
  const have = store.att.have
  const sol = solution(ins)
  const sys = store.sys
  const obs = store.magobs
  const sig = store.sigma
  const inl2 = store.inl2
  const cfg = store.cfg
  const faults = genFaults(sys?.genFaultCode ?? 0)

  const magHdg = (ins & 0x800) !== 0
  const gpsHdg = (ins & 0x80) !== 0
  const hdgFine = (ins & 0x10) !== 0
  const hdgCoarse = (ins & 0x1) !== 0
  const recal = (ins & 0x00400000) !== 0
  const interference = (ins & 0x00800000) !== 0
  const calibrated = obs ? obs.calibrated !== 0 : undefined
  const moving = (hdw & 0x3) !== 0
  const sat = (hdw & 0xf00) !== 0
  const b = bit(hdw)
  const wmm = cfg ? (cfg.sysCfgBits & 0x800) !== 0 : false
  const declination = cfg ? cfg.magDeclination * R2D : 0

  const headingSource: [string, Level, string] = gpsHdg
    ? ['GNSS', 'good', 'Heading from GNSS velocity or dual antennas.']
    : magHdg && (hdgFine || hdgCoarse)
      ? ['Magnetometer', hdgFine ? 'good' : 'warning', hdgFine ? 'Within spec (fine).' : 'Usable, outside spec (coarse).']
      : magHdg
        ? ['Magnetometer, holding only', 'warning', 'The mag keeps yaw from drifting but gives no north while it calibrates.']
        : ['None', 'serious', 'Yaw is integrated gyro only and will drift.']

  const magState: [string, Level, string] =
    calibrated === undefined
      ? ['Waiting for data', 'neutral', '']
      : recal
        ? ['Recalibrating', 'warning', 'Rotate the unit slowly through every orientation until it completes.']
        : !calibrated
          ? ['Not calibrated', 'serious', 'Hard and soft iron have never been solved on this unit. See Calibrate.']
          : interference
            ? ['Interference or bad cal', 'serious', 'Move away from steel, magnets and motor currents, or recalibrate.']
            : ['Calibrated', 'good', 'Field fits the stored hard and soft iron model.']

  const clear = async () => {
    setClearing(true)
    try {
      await sendCommand('clearfault')
    } finally {
      setTimeout(() => setClearing(false), 800)
    }
  }

  return (
    <section id="health" className="section">
      <SectionHead
        n="03"
        label="Health"
        title={
          <>
            Filter <em>health</em>
          </>
        }
        lede={
          <>
            Every bit of <code>insStatus</code> and <code>hdwStatus</code>, decoded per the SDK&rsquo;s{' '}
            <code>data_sets.h</code>, beside the EKF&rsquo;s own estimates of its biases and uncertainty.
          </>
        }
      />
      <div className="grid-3">
        <article className="card">
          <span className="tick" />
          <span className="label">Solution · insStatus</span>
          <div className="big-state">
            <StatusIcon level={have ? sol.level : 'neutral'} />
            <b>{have ? sol.name : '—'}</b>
          </div>
          <p className="note" style={{ marginTop: 4 }}>
            {have ? sol.detail : 'No INS data yet.'}
          </p>
          <div className="chips">
            {INS_FLAGS.filter((fl) => AHRS_FLAGS.has(fl.bit) || (ins & fl.bit) !== 0).map((fl) => (
              <span key={fl.bit} className="chip" data-off={(ins & fl.bit) === 0 || undefined}>
                {fl.label}
              </span>
            ))}
          </div>
          <p className="note mono">{hex(ins)}</p>
        </article>

        <article className="card">
          <span className="tick" />
          <span className="label">Heading</span>
          <div className="status-list">
            <StatusRow level={headingSource[1]} title={`Source: ${headingSource[0]}`} detail={headingSource[2]} />
            <StatusRow level={magState[1]} title={`Magnetometer: ${magState[0]}`} detail={magState[2]} />
            <StatusRow
              level={declination === 0 && !wmm ? 'warning' : 'good'}
              title={declination === 0 && !wmm ? 'North: magnetic' : 'North: true'}
              detail={
                declination === 0 && !wmm
                  ? 'magDeclination is 0 and WMM is off; set one before trusting a compass heading.'
                  : wmm
                    ? 'World Magnetic Model declination from refLla.'
                    : `Declination ${declination.toFixed(2)}° from flash config.`
              }
            />
            <StatusRow
              level={!obs ? 'neutral' : obs.nis <= obs.nis_threshold ? 'good' : 'warning'}
              title="Mag innovation (NIS)"
              detail="How well the field fits the filter; below the threshold is consistent."
              value={obs ? `${f(obs.nis, 3)} / ${f(obs.nis_threshold, 1)}` : '—'}
            />
          </div>
        </article>

        <article className="card">
          <span className="tick" />
          <span className="label">Hardware · hdwStatus</span>
          <div className="status-list">
            <StatusRow level={b.level} title={`Built-in test: ${b.label}`} />
            <StatusRow
              level={sat ? 'critical' : 'good'}
              title={sat ? 'Sensor saturated now' : 'No saturation'}
              detail={sat ? HDW_FLAGS.filter((x) => x.bit & 0xf00 && hdw & x.bit).map((x) => x.label).join(', ') : undefined}
            />
            <StatusRow
              level={faults.length ? 'serious' : 'good'}
              title={faults.length ? 'Latched fault' : 'No latched faults'}
              detail={faults.length ? faults.join(', ') + '. Cleared by writing 0; it re-latches if it happens again.' : undefined}
              value={
                faults.length ? (
                  <button className="pill" data-variant="quiet" data-size="s" onClick={clear} disabled={clearing}>
                    Clear
                  </button>
                ) : undefined
              }
            />
            <StatusRow level="neutral" title={moving ? 'Moving' : 'Stationary'} detail="Gyro and accel motion detectors." />
            <StatusRow
              level={parseErrors(hdw) ? 'warning' : 'good'}
              title="Comms parse errors"
              detail="4-bit counter, sticks at 15. Junk on the port or two programs sharing it."
              value={parseErrors(hdw) === 15 ? '≥15' : parseErrors(hdw)}
            />
          </div>
          <p className="note mono">
            {hex(hdw)} · reset cause {resetCause(hdw)}
          </p>
        </article>

        <article className="card">
          <span className="tick" />
          <span className="label">Filter estimates · DID_INL2</span>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Gyro bias X</dt>
            <dd>{inl2 ? `${f(inl2.biasPqr[0] * R2D * 3600, 1)} °/h` : '—'}</dd>
            <dt>Gyro bias Y</dt>
            <dd>{inl2 ? `${f(inl2.biasPqr[1] * R2D * 3600, 1)} °/h` : '—'}</dd>
            <dt>Gyro bias Z</dt>
            <dd>{inl2 ? `${f(inl2.biasPqr[2] * R2D * 3600, 1)} °/h` : '—'}</dd>
            <dt>Bias 1σ</dt>
            <dd>{sig ? `${f(Math.max(...sig.StdGyrBias) * R2D * 3600, 1)} °/h` : '—'}</dd>
            <dt>Tilt 1σ</dt>
            <dd>{sig ? `${f(Math.max(sig.StdAttNed[0], sig.StdAttNed[1]) * R2D, 3)}°` : '—'}</dd>
            <dt>Heading 1σ</dt>
            <dd>{sig ? `${f(sig.StdAttNed[2] * R2D, 2)}°` : '—'}</dd>
          </dl>
          <p className="note">
            The EKF estimates and removes each gyro&rsquo;s offset continuously, fastest with the unit still. The
            datasheet&rsquo;s &lt; 2 °/h is how much that offset wanders in a run, not how large it is.
          </p>
        </article>

        <article className="card">
          <span className="tick" />
          <span className="label">Environment</span>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>IMU temperature</dt>
            <dd>{sys ? `${f(sys.imuTemp, 1)} °C` : '—'}</dd>
            <dt>Baro temperature</dt>
            <dd>{store.baro ? `${f(store.baro.barTemp, 1)} °C` : '—'}</dd>
            <dt>Pressure</dt>
            <dd>{store.baro ? `${f(store.baro.bar, 3)} kPa` : '—'}</dd>
            <dt>Baro altitude, MSL</dt>
            <dd>{store.baro ? `${f(store.baro.mslBar, 1)} m` : '—'}</dd>
            <dt>Uptime</dt>
            <dd>{sys ? uptime(sys.upTime) : '—'}</dd>
            <dt>Fusion</dt>
            <dd>{cfg ? sysCfg(cfg.sysCfgBits).filter((s) => s.includes('off')).join(', ') || 'all on' : '—'}</dd>
          </dl>
        </article>

        <article className="card">
          <span className="tick" />
          <span className="label">Streams · measured</span>
          <dl className="kv" style={{ marginTop: 10 }}>
            {STREAMS.map(([k, name, want]) => {
              const got = store.rates[k]
              return [
                <dt key={k + 't'}>{name}</dt>,
                <dd key={k + 'd'}>
                  {got === undefined ? '—' : `${got.toFixed(1)} Hz`}
                  <span style={{ color: 'var(--ink3)' }}> / {want}</span>
                </dd>,
              ]
            })}
          </dl>
          <p className="note">Arrival rate at this browser over 2 s, against the rate the bridge requested.</p>
        </article>
      </div>
    </section>
  )
}

function uptime(s: number) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`
}

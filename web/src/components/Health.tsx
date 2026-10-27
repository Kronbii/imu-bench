import { useState } from 'react'

import { bit, genFaults, hex, HDW_FLAGS, INS_FLAGS, parseErrors, resetCause, solution, sysCfg, type Level } from '../decode'
import { isImx, sendCommand, store, useTick } from '../telemetry'
import { SectionHead, StatusIcon, StatusRow } from './Section'

const R2D = 180 / Math.PI
const f = (v: number | undefined | null, d = 2) => (v === undefined || v === null || !isFinite(v) ? '—' : v.toFixed(d))

// always shown (dim when clear): the INS flags an AHRS without GNSS can actually raise; others appear only when set
const AHRS_FLAGS = new Set([0x1, 0x10, 0x800, 0x2000, 0x00400000, 0x00800000])

const STREAM_NAMES: Record<string, string> = {
  att: 'Attitude',
  imu: 'IMU',
  mag: 'Magnetometer',
  baro: 'Barometer',
  status: 'Status',
}

export function Health() {
  useTick(250)
  const imx = isImx()
  return (
    <section id="health" className="section">
      <SectionHead
        n="05"
        label="Health"
        title={
          <>
            Filter <em>health</em>
          </>
        }
        lede={
          imx ? (
            <>
              Every bit of <code>insStatus</code> and <code>hdwStatus</code>, decoded per the SDK&rsquo;s{' '}
              <code>data_sets.h</code>, beside the EKF&rsquo;s own estimates of its biases and uncertainty.
            </>
          ) : (
            <>
              What the device says about itself, where the attitude comes from, and the rate each stream actually arrives
              at.
            </>
          )
        }
      />
      {imx ? <ImxHealth /> : <GenericHealth />}
    </section>
  )
}

function SolutionCard({ chips }: { chips?: React.ReactNode }) {
  const st = store.status
  const have = store.att.have
  const level: Level = !have ? 'neutral' : (st?.level ?? 'good')
  const name = st?.mode ?? (have ? (store.att.source === 'fusion' ? 'Fused' : 'Live') : '—')
  const detail =
    st?.detail ??
    (!have ? 'No attitude yet.' : store.att.source === 'fusion' ? 'Attitude computed here from gyro and accelerometer.' : 'Attitude as the sensor reports it.')
  return (
    <article className="card">
      <span className="tick" />
      <span className="label">State</span>
      <div className="big-state">
        <StatusIcon level={level} />
        <b>{name}</b>
      </div>
      <p className="note" style={{ marginTop: 4 }}>
        {detail}
      </p>
      {chips}
      {!!st?.flags?.length && (
        <div className="status-list" style={{ marginTop: 10 }}>
          {st.flags.map((fl) => (
            <StatusRow key={fl.label} level={fl.level} title={fl.label} />
          ))}
        </div>
      )}
    </article>
  )
}

function StreamsCard() {
  const kinds = Object.keys(STREAM_NAMES).filter((k) => k in store.rates)
  return (
    <article className="card">
      <span className="tick" />
      <span className="label">Streams · measured</span>
      <dl className="kv" style={{ marginTop: 10 }}>
        {kinds.map((k) => [
          <dt key={k + 't'}>{STREAM_NAMES[k] ?? k}</dt>,
          <dd key={k + 'd'}>{store.rates[k] ? `${store.rates[k].toFixed(1)} Hz` : '—'}</dd>,
        ])}
      </dl>
      <p className="note">Arrival rate at this browser over the last 2 s.</p>
    </article>
  )
}

function EnvironmentCard() {
  const baro = store.baro
  const imxSys = store.imx.sys
  return (
    <article className="card">
      <span className="tick" />
      <span className="label">Environment</span>
      <dl className="kv" style={{ marginTop: 10 }}>
        <dt>Sensor temperature</dt>
        <dd>{imxSys ? `${f(imxSys.imuTemp, 1)} °C` : store.status?.temp != null ? `${f(store.status.temp, 1)} °C` : '—'}</dd>
        <dt>Baro temperature</dt>
        <dd>{baro?.temp != null ? `${f(baro.temp, 1)} °C` : '—'}</dd>
        <dt>Pressure</dt>
        <dd>{baro ? `${f(baro.pressure, 3)} kPa` : '—'}</dd>
        <dt>Baro altitude</dt>
        <dd>{baro?.alt != null ? `${f(baro.alt, 1)} m` : '—'}</dd>
        {imxSys && (
          <>
            <dt>Uptime</dt>
            <dd>{uptime(imxSys.upTime)}</dd>
          </>
        )}
        {store.imx.cfg && (
          <>
            <dt>Fusion</dt>
            <dd>{sysCfg(store.imx.cfg.sysCfgBits).filter((s) => s.includes('off')).join(', ') || 'all on'}</dd>
          </>
        )}
      </dl>
    </article>
  )
}

function GenericHealth() {
  const att = store.att
  const fused = att.source === 'fusion'
  const hasMag = !!store.rates.mag
  return (
    <div className="grid-2">
      <SolutionCard />
      <article className="card">
        <span className="tick" />
        <span className="label">Attitude</span>
        <div className="status-list">
          <StatusRow
            level={att.have ? 'good' : 'neutral'}
            title={fused ? 'Source: fusion (Madgwick)' : 'Source: the sensor'}
            detail={
              fused
                ? 'Gyro integrated, corrected toward gravity by the accelerometer; heading pulled slowly toward the magnetometer.'
                : 'Orientation computed on the device and passed through as reported.'
            }
          />
          <StatusRow
            level={!hasMag && fused ? 'warning' : 'good'}
            title={hasMag ? 'Heading reference: magnetometer' : 'No heading reference'}
            detail={hasMag ? 'Magnetic north unless the device applies declination.' : 'Yaw is relative to where it started and drifts slowly.'}
          />
          <StatusRow
            level="neutral"
            title="Uncertainty"
            value={att.sigma ? `${f(Math.max(att.sigma[0], att.sigma[1]) * R2D, 3)}° tilt` : 'not reported'}
          />
        </div>
      </article>
      <EnvironmentCard />
      <StreamsCard />
    </div>
  )
}

function ImxHealth() {
  const [clearing, setClearing] = useState(false)
  const x = store.status?.x
  const ins = x?.insStatus ?? 0
  const hdw = x?.hdwStatus ?? 0
  const sol = solution(ins)
  const sys = store.imx.sys
  const obs = store.imx.magobs
  const sig = store.imx.sigma
  const inl2 = store.imx.inl2
  const cfg = store.imx.cfg
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
    <div className="grid-3">
      <article className="card">
        <span className="tick" />
        <span className="label">Solution · insStatus</span>
        <div className="big-state">
          <StatusIcon level={x ? sol.level : 'neutral'} />
          <b>{x ? sol.name : '—'}</b>
        </div>
        <p className="note" style={{ marginTop: 4 }}>
          {x ? sol.detail : 'No status yet.'}
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

      <EnvironmentCard />
      <StreamsCard />
    </div>
  )
}

function uptime(s: number) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`
}

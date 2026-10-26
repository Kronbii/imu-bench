import { accelRange, DYNAMIC_MODELS, gyroRange, hex, platform, rug3Preset, sysCfg } from '../decode'
import { shortDev, store, useTick } from '../telemetry'
import { SectionHead } from './Section'

const R2D = 180 / Math.PI

/*
 * Headline numbers from docs/datasheet.md. DS = IMX-5 datasheet (9/21/2026),
 * DWG = IS-RUG-3.0-G0 drawing rev 1, EOL = IS-EOL-2026-IMX5, LIVE = measured
 * on this unit.
 */
const SPECS: [string, string, string, string][] = [
  ['Gyro bias stability', '< 2.0 °/h', 'In-run, IEEE-952', 'DS'],
  ['Gyro angle random walk', '0.23 °/√h', 'Noise density 5 mdps/√Hz', 'DS'],
  ['Accel bias stability', '< 27 µg', 'In-run', 'DS'],
  ['Accel velocity random walk', '0.020 m/s/√h', 'Noise density 60 µg/√Hz', 'DS'],
  ['Static roll / pitch', '0.1° RMS', 'Holds without GNSS: gravity is the reference', 'DS'],
  ['Static heading, magnetometer', '1.0° RMS', 'Only once the magnetometer is calibrated', 'DS'],
  ['Ranges', '±4000 °/s · ±16 g', 'This unit is set to ±2000 °/s, ±16 g', 'DS · LIVE'],
  ['Magnetometer · barometer', '±2500 µT · 30–125 kPa', '50 Hz each', 'DS · LIVE'],
  ['Max output rate', '1000 / 200 / 142 Hz', 'IMU / AHRS / GNSS-INS', 'DS'],
  ['This unit, as configured', '143 Hz INS · 71 Hz IMU', '7 ms output, 14 ms filter update', 'LIVE'],
  ['IMU latency · startup', '4 ms · 0.8 s', 'At 1 kHz output data rate', 'DS'],
  ['Supply · ingress', '4.5–20 V · IP40', 'No liquid protection', 'DS'],
  ['Size · mass', '30.5 × 25.4 × 9.9 mm', '14.0 g on p2, 10.5 g on p1: weigh it', 'DS · DWG'],
  ['RS-232 maximum', '500 kbps', 'Ser0 is at 921600 now: use USB, or 460800', 'DS · LIVE'],
  ['Operating temperature', '−40 to 85 °C', 'IMU temperature-calibrated over the full range', 'DS'],
  ['End of support', '31 Dec 2027', 'IMX-5 is end-of-life; IMX-6 is the drop-in successor', 'EOL'],
]

export function Device() {
  useTick(500)
  const dev = store.dev
  const cfg = store.cfg
  const link = store.link
  const src = store.src

  return (
    <section id="device" className="section">
      <SectionHead
        n="05"
        label="Device"
        title={
          <>
            The <em>unit</em>
          </>
        }
        lede={
          <>
            What the IMX reports about itself, its flash configuration decoded, and the datasheet numbers that matter.
            The integration guide is <code>docs/datasheet.md</code>.
          </>
        }
      />
      <div className="grid-3">
        <article className="card">
          <span className="tick" />
          <span className="label">Identity · DID_DEV_INFO</span>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Product</dt>
            <dd>RUG-3-IMX-5</dd>
            <dt>Part number</dt>
            <dd>IS-RUG-3.0-G0</dd>
            <dt>Serial</dt>
            <dd>{dev ? dev.serialNumber : '—'}</dd>
            <dt>Hardware</dt>
            <dd>{dev ? `IMX ${dev.hardwareVer}` : '—'}</dd>
            <dt>Firmware</dt>
            <dd>{dev ? `${dev.firmwareVer} · ${dev.buildDate}` : '—'}</dd>
            <dt>Platform</dt>
            <dd>{cfg ? platform(cfg.platformConfig) : '—'}</dd>
            <dt>Add. info</dt>
            <dd>{dev?.addInfo || '—'}</dd>
            <dt>Link</dt>
            <dd>{src?.mode === 'device' ? (link?.up ? `${shortDev(link.dev ?? link.port)} · USB CDC` : (link?.why ?? '—')) : (src?.mode ?? '—')}</dd>
          </dl>
        </article>

        <article className="card">
          <span className="tick" />
          <span className="label">Configuration · DID_FLASH_CONFIG</span>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Gyro · accel range</dt>
            <dd>{cfg ? `±${gyroRange(cfg.sensorConfig)} °/s · ±${accelRange(cfg.sensorConfig)} g` : '—'}</dd>
            <dt>IMU sample · nav output</dt>
            <dd>{cfg ? `${cfg.startupImuDtMs} ms · ${cfg.startupNavDtMs} ms` : '—'}</dd>
            <dt>Dynamic model</dt>
            <dd>{cfg ? (DYNAMIC_MODELS[cfg.dynamicModel] ?? cfg.dynamicModel) : '—'}</dd>
            <dt>RUG-3 preset</dt>
            <dd>{cfg ? rug3Preset(cfg.platformConfig) : '—'}</dd>
            <dt>Serial baud</dt>
            <dd>{cfg ? `${cfg.ser0BaudRate} / ${cfg.ser1BaudRate} / ${cfg.ser2BaudRate}` : '—'}</dd>
            <dt>Declination</dt>
            <dd>{cfg ? `${(cfg.magDeclination * R2D).toFixed(2)}°` : '—'}</dd>
            <dt>INS rotation</dt>
            <dd>{cfg ? cfg.insRotation.map((v) => (v * R2D).toFixed(1)).join(', ') + '°' : '—'}</dd>
            <dt>INS offset</dt>
            <dd>{cfg ? cfg.insOffset.map((v) => v.toFixed(3)).join(', ') + ' m' : '—'}</dd>
          </dl>
          {cfg && (
            <div className="chips">
              {sysCfg(cfg.sysCfgBits).map((s) => (
                <span key={s} className="chip">
                  {s}
                </span>
              ))}
              <span className="chip">ioConfig {hex(cfg.ioConfig, 2)}</span>
            </div>
          )}
        </article>

        <article className="card">
          <span className="tick" />
          <span className="label">Events</span>
          {store.logs.length ? (
            <ul className="log" style={{ marginTop: 10 }}>
              {store.logs.map((l, i) => (
                <li key={l.at + ':' + i}>
                  <time>{new Date(l.at).toLocaleTimeString()}</time>
                  {l.msg}
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">Commands you send and bridge messages land here.</p>
          )}
        </article>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="specs">
          {SPECS.map(([name, value, note, source]) => (
            <div key={name} className="spec">
              <span className="label">{name}</span>
              <b>{value}</b>
              <p>
                {note} <span className="mono" style={{ color: 'var(--ink3)' }}>· {source}</span>
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

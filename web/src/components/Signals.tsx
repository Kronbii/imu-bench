import { useState } from 'react'

import { store } from '../telemetry'
import { LiveChart, type Series } from './LiveChart'
import { SectionHead } from './Section'

const XYZ: Series[] = [
  { name: 'X', color: '--x', channel: 0 },
  { name: 'Y', color: '--y', channel: 1 },
  { name: 'Z', color: '--z', channel: 2 },
]
// roll turns about X and pitch about Y, so they wear those axes' colours
const TILT: Series[] = [
  { name: 'Roll', color: '--x', channel: 0 },
  { name: 'Pitch', color: '--y', channel: 1 },
]
const WINDOWS = [5, 10, 30, 60]

export function Signals() {
  const [win, setWin] = useState(10)
  const [paused, setPaused] = useState(false)
  const s = store.series

  return (
    <section id="signals" className="section">
      <SectionHead
        n="02"
        label="Signals"
        title={
          <>
            The raw <em>signals</em>
          </>
        }
        lede={
          <>
            Body-frame rates and specific force from <code>DID_IMU</code>, field from <code>DID_MAGNETOMETER</code>,
            tilt from <code>DID_INS_1</code>. Sitting level and still, Z reads about −9.81 m/s²: the accelerometer
            measures the push of the table, not gravity. Hover or focus a chart to read every axis at one instant.
          </>
        }
      />
      <div className="filters" role="toolbar" aria-label="Chart window">
        <span className="label">Window</span>
        <div className="seg">
          {WINDOWS.map((w) => (
            <button key={w} aria-pressed={win === w} onClick={() => setWin(w)}>
              {w} s
            </button>
          ))}
        </div>
        <button className="pill" data-variant={paused ? 'primary' : 'quiet'} data-size="s" onClick={() => setPaused(!paused)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <span className="spacer" />
        <span className="label">{paused ? 'Paused: the buffer keeps filling' : 'Redrawn at 30 fps'}</span>
      </div>
      <div className="grid-2">
        <LiveChart
          fig="Fig. 02 · DID_INS_1"
          title="Tilt"
          unit="deg"
          ring={s.tilt}
          series={TILT}
          windowS={win}
          paused={paused}
          minSpan={4}
          digits={2}
          csvName="tilt"
        />
        <LiveChart
          fig="Fig. 03 · DID_IMU"
          title="Angular rate"
          unit="deg/s"
          ring={s.gyro}
          series={XYZ}
          windowS={win}
          paused={paused}
          minSpan={2}
          digits={2}
          csvName="gyro"
        />
        <LiveChart
          fig="Fig. 04 · DID_IMU"
          title="Specific force"
          unit="m/s²"
          ring={s.acc}
          series={XYZ}
          windowS={win}
          paused={paused}
          minSpan={4}
          digits={3}
          csvName="accel"
        />
        <LiveChart
          fig="Fig. 05 · DID_MAGNETOMETER"
          title="Magnetic field"
          unit="normalized, ≈1 when calibrated"
          ring={s.mag}
          series={XYZ}
          windowS={win}
          paused={paused}
          minSpan={0.4}
          digits={3}
          csvName="mag"
        />
      </div>
    </section>
  )
}

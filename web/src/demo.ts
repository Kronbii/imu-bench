/*
 * The hosted demo: the same imuctl messages a server would send, made in the
 * page from a synthetic hand-held wobble (the Python simulator's motion, so
 * every readout agrees). On when built with VITE_DEMO=1 or opened with ?demo.
 *
 *   ?demo                    an IMX-5 in a RUG-3, every panel live
 *   ?demo&emulate=ahrs       a generic AHRS          ?demo&form=quad   the quadrotor model
 *
 * Simulated, and labelled so wherever it shows: the IMU runs at 429 Hz with
 * a motor tone stepping between throttle settings (and its harmonic) on top of the motion,
 * the noise of a tactical MEMS IMU (white noise plus bias random walk), and
 * a raw magnetometer with hard and soft iron still in it. window.__demo can
 * unplug, tumble the unit through every orientation, or hold it still.
 */

type Emit = (m: Record<string, any>) => void

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()
export const DEMO = import.meta.env.VITE_DEMO === '1' || params.has('demo')

const G = 9.80665
const D2R = Math.PI / 180
const INC = 48 * D2R
const FIELD = [Math.cos(INC), 0, Math.sin(INC)]

function attitude(t: number): [number, number, number] {
  return [
    (16 * Math.sin(0.31 * t) + 5 * Math.sin(1.27 * t + 0.4)) * D2R,
    (11 * Math.sin(0.23 * t + 1.0) + 3.5 * Math.sin(0.93 * t)) * D2R,
    (35 * Math.sin(0.06 * t) + 22 * Math.sin(0.17 * t + 2.0)) * D2R,
  ]
}

function quat(r: number, p: number, y: number): number[] {
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(r / 2), Math.sin(r / 2), Math.cos(p / 2), Math.sin(p / 2), Math.cos(y / 2), Math.sin(y / 2)]
  return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy]
}

/** A NED vector seen in the body frame (rotate by the conjugate). */
function toBody(q: number[], v: number[]) {
  const [w, x, y, z] = q
  const m = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
  return [0, 1, 2].map((i) => m[0][i] * v[0] + m[1][i] * v[1] + m[2][i] * v[2])
}

/** Motor speed, Hz: holds each throttle setting 8 s, then moves to the next over 2 s. */
function motorHz(t: number) {
  const steps = [72, 88, 68, 94]
  const u = t / 10
  const i = Math.floor(u)
  const a = Math.min(1, Math.max(0, (u - i - 0.8) / 0.2))
  return steps[i % 4] + (steps[(i + 1) % 4] - steps[i % 4]) * a * a * (3 - 2 * a)
}

/** Seeded noise, so recordings come out the same every time. */
function gauss(seed: number) {
  let s = seed >>> 0
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return (sd: number) => sd * Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())
}

const PROFILES: Record<string, Record<string, any>> = {
  imx: {
    vendor: 'Inertial Sense', name: 'IMX-5', model: 'RUG-3-IMX-5', form: 'rug3', serial: 'DEMO', firmware: '2.7.0',
    caps: ['attitude', 'imu', 'mag', 'baro', 'status', 'sigma', 'panel:imx', 'cmd:magrecal', 'cmd:zeromotion', 'cmd:clearfault', 'cmd:reset'],
  },
  ahrs: { vendor: 'Simulated', name: 'AHRS', model: 'Generic AHRS', form: 'board', caps: ['attitude', 'imu', 'mag', 'baro', 'status'] },
}

/** The demo's IMU noise, also used to simulate a long Noise Lab capture. */
export const DEMO_NOISE = { gyroN: 6.7e-5, accN: 3.3e-4, gyroK: 4e-6, accK: 4e-5 }

/** Start emitting; returns the handlers for dashboard commands and the magnetometer correction. */
export function startDemo(emit: Emit) {
  const emulate = PROFILES[params.get('emulate') ?? ''] ? params.get('emulate')! : 'imx'
  const prof = { ...PROFILES[emulate] }
  const form = params.get('form')
  if (form === 'quad' || form === 'board' || form === 'rug3') prof.form = form
  if (prof.form === 'quad' && emulate === 'imx') Object.assign(prof, { model: 'Quadrotor · RUG-3-IMX-5' })
  const imx = emulate === 'imx'
  const n = gauss(7)
  const rate = 429 // IMU rate; attitude every 3rd sample (143 Hz), magnetometer every 9th
  let t0 = performance.now()
  let k = 0
  let recalUntil = 0
  let fault = imx ? 0x40000 : 0
  let plugged = true

  emit({ t: 'src', mode: 'demo', driver: 'demo', detail: 'simulated motion' })
  const hello = () => {
    emit({ t: 'device', driver: 'demo', ...prof })
    emit({ t: 'link', up: true, port: 'demo' })
    if (imx) {
      emit({ t: 'imx.dev', serialNumber: 0, hardwareType: 3, hardwareVer: '5.0.5', firmwareVer: '2.7.0', buildDate: 'demo', manufacturer: 'Simulator', addInfo: 'P8 I2' })
      emit({
        t: 'imx.cfg', sensorConfig: 0x33, dynamicModel: 8, startupImuDtMs: 1, startupNavDtMs: 7, startupGPSDtMs: 200,
        sysCfgBits: 0x0010c000, platformConfig: 0x007c0108, ioConfig: 0x46, ser0BaudRate: 921600, ser1BaudRate: 921600,
        ser2BaudRate: 921600, magDeclination: 0, insRotation: [0, 0, 0], insOffset: [0, 0, 0],
      })
    }
  }
  hello()

  // for scripted recordings: window.__demo.unplug() / .plug()
  ;(window as any).__demo = {
    unplug() {
      plugged = false
      emit({ t: 'link', up: false, port: 'demo', why: 'unplugged' })
    },
    plug() {
      t0 = performance.now() - (k / rate) * 1000 // resume where it stopped, not with a burst
      plugged = true
      hello()
    },
  }

  // ---- motion: the wobble, a tumble through every orientation, or perfectly still
  type Mode = 'wobble' | 'tumble' | 'still'
  let mode: Mode = 'wobble'
  let modeAt = 0
  let stillAt: [number, number, number] = [0, 0, 0]
  let from: [number, number, number] | null = null // leaving 'still': ease back into the wobble
  const tumbleSecs = 24
  const pose = (t: number): [number, number, number] => {
    if (mode === 'still') return stillAt
    const [r, p, y] = attitude(t)
    if (mode === 'wobble') {
      const a = from ? Math.min(1, (t - modeAt) / 2) : 1
      const e = a * a * (3 - 2 * a)
      return from && a < 1 ? [from[0] + e * (r - from[0]), from[1] + e * (p - from[1]), from[2] + e * (y - from[2])] : [r, p, y]
    }
    const u = t - modeAt
    const a = Math.min(1, u / 2) * Math.min(1, Math.max(0, (tumbleSecs - u) / 2)) // ease in and out
    return [r + a * Math.PI * Math.sin((2 * Math.PI * u) / 11), p + a * 1.3 * Math.sin((2 * Math.PI * u) / 7), y + a * ((2 * Math.PI * u) / 8)]
  }
  const bodyRates = (t: number) => {
    const [r, p, y] = pose(t)
    const [r2, p2, y2] = pose(t + 1e-4)
    const dr = (r2 - r) / 1e-4
    const dp = (p2 - p) / 1e-4
    const dy = (y2 - y) / 1e-4
    return [dr - dy * Math.sin(p), dp * Math.cos(r) + dy * Math.sin(r) * Math.cos(p), -dp * Math.sin(r) + dy * Math.cos(r) * Math.cos(p)]
  }

  // ---- sensor errors: tactical-MEMS-like noise, and an uncalibrated magnetometer
  const gyroWhite = DEMO_NOISE.gyroN * Math.sqrt(rate) // ARW 0.23 °/√h
  const accWhite = DEMO_NOISE.accN * Math.sqrt(rate) // VRW 0.020 m/s/√h
  const gyroBias = [3e-4, -4.6e-4, -1.4e-3]
  const accBias = [0.004, -0.006, 0.01]
  const softIron = [1.24, 0.1, -0.05, 0.1, 0.84, 0.06, -0.05, 0.06, 1.04]
  const hardIron = [0.38, -0.26, 0.14]
  let magcal: { center: number[]; matrix: number[] } | null = null // what the server would apply, see setMagCal
  let phase = 0

  const step = (t: number) => {
    const [r, p, y] = pose(t)
    const q = quat(r, p, y)
    const tt = Math.round(t * 1e4) / 1e4
    const dt = 1 / rate
    // bias random walk
    for (let i = 0; i < 3; i++) {
      gyroBias[i] += DEMO_NOISE.gyroK * Math.sqrt(dt) * n(1)
      accBias[i] += DEMO_NOISE.accK * Math.sqrt(dt) * n(1)
    }
    // a motor: throttle stepping between four settings (68–94 Hz), its second harmonic, and a 23 Hz frame mode
    const vib = mode !== 'still'
    const f1 = motorHz(t)
    phase += 2 * Math.PI * f1 * dt
    const s1 = Math.sin(phase)
    const s2 = Math.sin(2 * phase + 0.7)
    const s3 = Math.sin(2 * Math.PI * 23 * t)
    const w = bodyRates(t)
    const gyro = w.map((v, i) => v + gyroBias[i] + n(gyroWhite) + (vib ? [0.012 * s1, 0.009 * s1 + 0.004 * s2, 0.005 * s2][i] : 0))
    const acc = toBody(q, [0, 0, -G]).map(
      (v, i) => v + accBias[i] + n(accWhite) + (vib ? [0.2 * s1 + 0.07 * s2, 0.13 * s1 + 0.09 * s2, 0.3 * s1 + 0.12 * s2 + 0.06 * s3][i] : 0),
    )
    emit({ t: 'imu', time: tt, gyro, acc })
    if (k % 3 === 0) emit({ t: 'att', time: tt, q, euler: [r, p, y], source: 'sensor', sigma: imx ? [1e-4, 1e-4, 5.2e-3] : undefined })
    if (k % 9 === 0) {
      const b = toBody(q, FIELD)
      let mag = [0, 1, 2].map((i) => softIron[i * 3] * b[0] + softIron[i * 3 + 1] * b[1] + softIron[i * 3 + 2] * b[2] + hardIron[i] + n(0.004))
      if (magcal) {
        const { center: c, matrix: W } = magcal
        const d = mag.map((v, i) => v - c[i])
        mag = [0, 1, 2].map((i) => W[i * 3] * d[0] + W[i * 3 + 1] * d[1] + W[i * 3 + 2] * d[2])
      }
      emit({ t: 'mag', time: tt, mag, unit: 'norm', cal: magcal ? true : undefined })
      emit({ t: 'baro', time: tt, pressure: 100.67 + n(0.002), alt: 54.9 + n(0.15), temp: 29.6 })
    }
    if (k % 42 === 0) status(t, y)
    if (mode === 'tumble' && t - modeAt > tumbleSecs) mode = 'wobble'
    k++
  }

  // for scripted recordings and the Calibrate and Noise Lab panels
  Object.assign((window as any).__demo, {
    tumble() {
      from = null
      mode = 'tumble'
      modeAt = k / rate
    },
    still(on: boolean) {
      if (on) stillAt = pose(k / rate)
      from = on ? null : stillAt
      mode = on ? 'still' : 'wobble'
      modeAt = k / rate
    },
    get mode() {
      return mode
    },
  })

  const status = (t: number, yaw: number) => {
    const recal = performance.now() < recalUntil
    if (!imx) return emit({ t: 'status', mode: 'AHRS', level: 'good', detail: 'Simulated attitude.', temp: 27 })
    const moving = Math.max(...bodyRates(t).map(Math.abs)) > 0.05
    const ins = (5 << 16) | 0x800 | 0x10 | (recal ? 0x00400000 : 0) | (fault ? 0x80000000 : 0)
    const hdw = 0x02000000 | (moving ? 0x3 : 0)
    emit({ t: 'status', mode: 'AHRS', level: 'good', detail: 'Attitude and heading good.', temp: 26.5, x: { insStatus: ins >>> 0, hdwStatus: hdw } })
    emit({ t: 'imx.sys', insStatus: ins >>> 0, hdwStatus: hdw, imuTemp: 26.5 + 0.2 * Math.sin(t / 60), baroTemp: 29.6, genFaultCode: fault, upTime: t })
    emit({ t: 'imx.inl2', biasPqr: [3e-4, -4.6e-4, -1.4e-3], biasAcc: [0, 0, 0] })
    emit({ t: 'imx.sigma', StdAttNed: [1e-4, 1e-4, 5.2e-3], StdGyrBias: [1.4e-5, 1.4e-5, 1.6e-5] })
    emit({ t: 'imx.magobs', calibrated: 1, nis: Math.abs(n(0.3)), nis_threshold: 5, magHdg: yaw })
    const left = (recalUntil - performance.now()) / 1000
    emit({ t: 'imx.magcal', state: recal ? 200 : 0, progress: recal ? Math.max(0, Math.min(100, 100 * (1 - left / 20))) : 0 })
  }

  setInterval(() => {
    if (!plugged) return
    // catch up to the clock in fixed steps, so the rate holds whatever the timer does
    const due = Math.floor(((performance.now() - t0) / 1000) * rate)
    if (due - k > rate * 2) k = due - rate // a background tab: skip ahead rather than replay minutes of samples
    while (k < due) step(k / rate)
  }, 7)

  return {
    command(cmd: string) {
      if (cmd.startsWith('magrecal')) recalUntil = cmd.endsWith('abort') ? 0 : performance.now() + 20000
      if (cmd === 'clearfault') fault = 0
      emit({ t: 'log', msg: `demo: ${cmd}` })
    },
    magcal(cal: { center: number[]; matrix: number[] } | null) {
      magcal = cal && { center: [...cal.center], matrix: [...cal.matrix] }
      emit({ t: 'magcal', applied: !!cal, ...(cal ?? {}) })
    },
  }
}

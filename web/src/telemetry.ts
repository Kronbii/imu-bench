/*
 * The live stream, outside React. server/serve.py pushes batches of the
 * bridge's messages (one JSON object per IMX data set, SDK field names) over
 * Server-Sent Events; they land in `store`. Fast consumers (3D, charts,
 * readouts) read it every animation frame; text panels re-render on a timer
 * (useTick), so 143 Hz data never drives React renders.
 */

import { useEffect, useState } from 'react'

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number] // w, x, y, z

export interface Dev {
  serialNumber: number
  hardwareType: number
  hardwareVer: string
  firmwareVer: string
  buildDate: string
  manufacturer: string
  addInfo: string
}
export interface Cfg {
  sensorConfig: number
  dynamicModel: number
  startupImuDtMs: number
  startupNavDtMs: number
  startupGPSDtMs: number
  sysCfgBits: number
  platformConfig: number
  ioConfig: number
  ser0BaudRate: number
  ser1BaudRate: number
  ser2BaudRate: number
  magDeclination: number
  insRotation: Vec3
  insOffset: Vec3
}
export interface Sys {
  insStatus: number
  hdwStatus: number
  imuTemp: number
  baroTemp: number
  mcuTemp: number
  sysStatus: number
  imuSamplePeriodMs: number
  navOutputPeriodMs: number
  navUpdatePeriodMs: number
  genFaultCode: number
  upTime: number
}
export interface MagObs {
  Ncal_samples: number
  calibrated: number
  auto_recal: number
  outlier: number
  magHdg: number
  insHdg: number
  magInsHdgDelta: number
  nis: number
  nis_threshold: number
  Tcal: number
  bias_cal: Vec3
}
export interface MagCal {
  state: number
  progress: number
  declination: number
}
export interface Sigma {
  StdAttNed: Vec3
  StdVelNed: Vec3
  StdGyrBias: Vec3
  StdAccBias: Vec3
  StdMagDeclination: number
}
export interface Inl2 {
  biasPqr: Vec3
  biasAcc: Vec3
  biasBaro: number
  magDec: number
  magInc: number
}
export interface Baro {
  time: number
  bar: number
  mslBar: number
  barTemp: number
  humidity: number
}

/** A fixed-capacity time series: one time column and N value channels. */
export class Ring {
  readonly t: Float64Array
  readonly ch: Float32Array[]
  head = 0
  size = 0

  constructor(
    readonly cap: number,
    channels: number,
  ) {
    this.t = new Float64Array(cap)
    this.ch = Array.from({ length: channels }, () => new Float32Array(cap))
  }

  get lastT() {
    return this.size ? this.t[(this.head - 1 + this.cap) % this.cap] : 0
  }

  /** Index into the arrays of the i-th oldest sample. */
  at(i: number) {
    return (this.head - this.size + i + this.cap) % this.cap
  }

  push(t: number, ...v: number[]) {
    // A clock that jumps (device reset, GPS time arriving) starts a new trace.
    if (this.size && (t < this.lastT - 0.25 || t > this.lastT + 5)) this.clear()
    this.t[this.head] = t
    for (let c = 0; c < this.ch.length; c++) this.ch[c][this.head] = v[c]
    this.head = (this.head + 1) % this.cap
    if (this.size < this.cap) this.size++
  }

  clear() {
    this.head = 0
    this.size = 0
  }
}

const RAD = 180 / Math.PI

export const store = {
  connected: false,
  src: null as null | { mode: 'device' | 'sim' | 'replay'; detail: string },
  /** bridge connection: port is what it opened (often a by-id link), dev the ttyACM behind it */
  link: null as null | { up: boolean; port: string; dev?: string; why?: string },
  dev: null as Dev | null,
  cfg: null as Cfg | null,
  sys: null as Sys | null,
  magobs: null as MagObs | null,
  magcal: null as MagCal | null,
  sigma: null as Sigma | null,
  inl2: null as Inl2 | null,
  baro: null as Baro | null,
  /** DID_INS_1 / DID_INS_2: Euler (rad) and qn2b, body to NED */
  att: {
    have: false,
    tow: 0,
    theta: [0, 0, 0] as Vec3,
    q: [1, 0, 0, 0] as Quat,
    insStatus: 0,
    hdwStatus: 0,
    uvw: [0, 0, 0] as Vec3,
  },
  imu: { time: 0, status: 0, pqr: [0, 0, 0] as Vec3, acc: [0, 0, 0] as Vec3 },
  mag: { time: 0, mag: [0, 0, 0] as Vec3 },
  series: {
    tilt: new Ring(12000, 3), // roll, pitch, yaw (deg), DID_INS_1
    gyro: new Ring(6000, 3), // deg/s, DID_IMU
    acc: new Ring(6000, 3), // m/s², DID_IMU
    mag: new Ring(4000, 3), // normalized, DID_MAGNETOMETER
  },
  /** last minute of magnetometer vectors, for the coverage plots */
  magCloud: new Ring(3000, 3),
  /** messages per second, per type, over a 2 s window */
  rates: {} as Record<string, number>,
  lastRx: 0,
  logs: [] as { at: number; msg: string }[],
  /** subtracted from yaw for display; set by "Zero yaw" */
  yawOffset: 0,
}

function log(msg: string) {
  store.logs.unshift({ at: Date.now(), msg })
  store.logs.length = Math.min(store.logs.length, 30)
}

const counts: Record<string, number> = {}
let rateStart = performance.now()

function ingest(m: Record<string, any>) {
  counts[m.t] = (counts[m.t] ?? 0) + 1
  switch (m.t) {
    case 'ins1': {
      const a = store.att
      a.have = true
      a.tow = m.timeOfWeek
      a.theta = m.theta
      a.insStatus = m.insStatus
      a.hdwStatus = m.hdwStatus
      a.uvw = m.uvw
      store.series.tilt.push(m.timeOfWeek, m.theta[0] * RAD, m.theta[1] * RAD, m.theta[2] * RAD)
      break
    }
    case 'ins2':
      store.att.q = m.qn2b
      break
    case 'imu':
      store.imu = m as typeof store.imu
      store.series.gyro.push(m.time, m.pqr[0] * RAD, m.pqr[1] * RAD, m.pqr[2] * RAD)
      store.series.acc.push(m.time, m.acc[0], m.acc[1], m.acc[2])
      break
    case 'mag':
      store.mag = m as typeof store.mag
      store.series.mag.push(m.time, m.mag[0], m.mag[1], m.mag[2])
      store.magCloud.push(m.time, m.mag[0], m.mag[1], m.mag[2])
      break
    case 'baro':
      store.baro = m as Baro
      break
    case 'log':
      log(m.msg)
      break
    case 'link':
      if (store.link?.up !== m.up || store.link?.why !== m.why)
        log(m.up ? `connected · ${shortDev(m.dev ?? m.port)}` : `${m.why ?? 'disconnected'} · ${shortDev(m.dev ?? m.port)}`)
      store.link = m as typeof store.link
      if (!m.up) {
        // what was live is now history; identity and config stay until the unit says otherwise
        store.att.have = false
        store.sys = store.magobs = store.magcal = store.sigma = store.inl2 = null
        store.baro = null
      }
      break
    case 'src':
    case 'dev':
    case 'cfg':
    case 'sys':
    case 'magobs':
    case 'magcal':
    case 'sigma':
    case 'inl2':
      ;(store as any)[m.t] = m
      break
  }
}

let started = false
export function connect() {
  if (started) return
  started = true
  const es = new EventSource('/stream')
  es.onopen = () => (store.connected = true)
  es.onerror = () => (store.connected = false) // EventSource retries on its own
  es.onmessage = (e) => {
    store.connected = true
    store.lastRx = performance.now()
    for (const m of JSON.parse(e.data)) ingest(m)
  }
  setInterval(() => {
    const now = performance.now()
    const dt = (now - rateStart) / 1000
    for (const k of Object.keys(counts)) {
      store.rates[k] = counts[k] / dt
      counts[k] = 0
    }
    rateStart = now
  }, 2000)
}

/** The link pill's words for each state the bridge reports. */
export function linkState(): { state: 'live' | 'sim' | 'down'; label: string; where: string } {
  const src = store.src
  const link = store.link
  const where = src?.mode === 'device' ? shortDev(link?.dev ?? link?.port) : (src?.detail ?? '')
  if (!store.connected) return { state: 'down', label: 'No server', where: '' }
  if (isLive()) return { state: src?.mode === 'device' ? 'live' : 'sim', label: src?.mode === 'device' ? 'Live' : src?.mode === 'replay' ? 'Replay' : 'Simulated', where }
  const why = link?.why
  const label =
    why === 'searching' ? 'Searching' : why === 'unplugged' ? 'Unplugged' : why === 'not answering' || why === 'not an IMX' ? 'No reply' : why === 'no data' ? 'No data' : 'Waiting'
  return { state: 'down', label, where: why === 'searching' ? 'plug in the IMX' : where }
}

/** A port as people read it: /dev/ttyACM1, never a 70-character by-id link. */
export const shortDev = (p?: string) => {
  if (!p) return '—'
  if (p.startsWith('/dev/serial/by-id/')) return 'USB serial'
  return p.length > 20 ? '…' + p.slice(-18) : p
}

/** Is data arriving? (stream open, bridge linked, a sample in the last second) */
export function isLive() {
  return store.connected && store.link?.up !== false && performance.now() - store.lastRx < 1000
}

export async function sendCommand(cmd: string) {
  const r = await fetch('/api/cmd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  })
  if (!r.ok) throw new Error(await r.text())
}

// ---- display attitude ------------------------------------------------------------

export const wrap360 = (d: number) => ((d % 360) + 360) % 360
export const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180

/** Roll, pitch (deg) and yaw (deg, 0-360) with the zero-yaw offset applied. */
export function displayEuler(): Vec3 {
  const [r, p, y] = store.att.theta
  return [r * RAD, p * RAD, wrap360(y * RAD - store.yawOffset)]
}

/** qn2b rotated about NED down by the zero-yaw offset. */
export function displayQuat(): Quat {
  const [w, x, y, z] = store.att.q
  const h = (-store.yawOffset * Math.PI) / 360
  const c = Math.cos(h)
  const s = Math.sin(h)
  // (c, 0, 0, s) ⊗ q
  return [c * w - s * z, c * x - s * y, c * y + s * x, c * z + s * w]
}

// ---- frame + tick plumbing ------------------------------------------------------

type FrameFn = (now: number) => void
const frameFns = new Set<FrameFn>()
let raf = 0
function loop(now: number) {
  for (const fn of frameFns) fn(now)
  raf = frameFns.size ? requestAnimationFrame(loop) : 0
}
/** Run fn every animation frame until the returned cleanup is called. */
export function onFrame(fn: FrameFn) {
  frameFns.add(fn)
  if (!raf) raf = requestAnimationFrame(loop)
  return () => void frameFns.delete(fn)
}

/** Re-render the calling component every `ms`. */
export function useTick(ms = 250) {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}

export const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

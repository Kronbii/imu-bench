/*
 * The live stream, outside React. The server pushes batches of bench
 * messages (docs/protocol.md: device, att, imu, mag, baro, status, link,
 * plus imx.* extras from Inertial Sense units) over Server-Sent Events;
 * they land in `store`. Fast consumers (3D, charts, readouts) read it every
 * animation frame; text panels re-render on a timer (useTick), so 143 Hz
 * data never drives React renders. Without a server (the hosted demo), an
 * in-page simulator feeds the same ingest().
 */

import { useEffect, useState } from 'react'

import { DEMO, startDemo } from './demo'
import type { Level } from './decode'

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number] // w, x, y, z

export type Form = 'rug3' | 'board' | 'quad'

export interface Device {
  vendor: string
  name: string
  model: string
  form: Form
  serial?: string
  firmware?: string | null
  hardware?: string
  driver: string
  caps: string[]
  fusion?: string
}
export interface Status {
  mode: string
  level: Level
  detail?: string
  temp?: number
  flags?: { label: string; level: Level }[]
  x?: { insStatus: number; hdwStatus: number }
}

// Inertial Sense extras (imx.* messages), SDK field names
export interface ImxDev {
  serialNumber: number
  hardwareType: number
  hardwareVer: string
  firmwareVer: string
  buildDate: string
  manufacturer: string
  addInfo: string
}
export interface ImxCfg {
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
export interface ImxSys {
  insStatus: number
  hdwStatus: number
  imuTemp: number
  baroTemp: number
  genFaultCode: number
  upTime: number
}
export interface ImxMagObs {
  calibrated: number
  nis: number
  nis_threshold: number
}
export interface ImxMagCal {
  state: number
  progress: number
}
export interface ImxSigma {
  StdAttNed: Vec3
  StdGyrBias: Vec3
}
export interface ImxInl2 {
  biasPqr: Vec3
  biasAcc: Vec3
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
  src: null as null | { mode: 'device' | 'sim' | 'replay' | 'demo'; driver?: string; detail: string },
  link: null as null | { up: boolean; port: string; dev?: string; why?: string },
  device: null as Device | null,
  status: null as Status | null,
  att: {
    have: false,
    time: 0,
    q: [1, 0, 0, 0] as Quat,
    euler: [0, 0, 0] as Vec3, // rad, ZYX
    source: 'sensor' as 'sensor' | 'fusion',
    sigma: null as Vec3 | null, // rad, 1-sigma roll/pitch/yaw when the device reports it
  },
  imu: { time: 0, gyro: [0, 0, 0] as Vec3, acc: [0, 0, 0] as Vec3 },
  mag: { time: 0, mag: [0, 0, 0] as Vec3, unit: 'norm' as 'norm' | 'uT' | 'gauss' },
  baro: null as null | { time: number; pressure: number; alt?: number; temp?: number },
  imx: {
    dev: null as ImxDev | null,
    cfg: null as ImxCfg | null,
    sys: null as ImxSys | null,
    magobs: null as ImxMagObs | null,
    magcal: null as ImxMagCal | null,
    sigma: null as ImxSigma | null,
    inl2: null as ImxInl2 | null,
  },
  series: {
    tilt: new Ring(12000, 3), // roll, pitch, yaw (deg)
    gyro: new Ring(12000, 3), // deg/s
    acc: new Ring(12000, 3), // m/s²
    mag: new Ring(4000, 3),
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

export const has = (cap: string) => !!store.device?.caps?.includes(cap)
export const isImx = () => has('panel:imx')

function log(msg: string) {
  store.logs.unshift({ at: Date.now(), msg })
  store.logs.length = Math.min(store.logs.length, 30)
}

function eulerOf([w, x, y, z]: Quat): Vec3 {
  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))),
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  ]
}

const counts: Record<string, number> = {}
let rateStart = performance.now()

export function ingest(m: Record<string, any>) {
  store.lastRx = performance.now()
  counts[m.t] = (counts[m.t] ?? 0) + 1
  switch (m.t) {
    case 'att': {
      const a = store.att
      a.have = true
      a.time = m.time
      a.q = m.q
      a.euler = m.euler ?? eulerOf(m.q)
      a.source = m.source ?? 'sensor'
      if (m.sigma) a.sigma = m.sigma
      store.series.tilt.push(m.time, a.euler[0] * RAD, a.euler[1] * RAD, a.euler[2] * RAD)
      break
    }
    case 'imu':
      store.imu = m as typeof store.imu
      store.series.gyro.push(m.time, m.gyro[0] * RAD, m.gyro[1] * RAD, m.gyro[2] * RAD)
      store.series.acc.push(m.time, m.acc[0], m.acc[1], m.acc[2])
      break
    case 'mag':
      store.mag = { time: m.time, mag: m.mag, unit: m.unit ?? 'norm' }
      store.series.mag.push(m.time, m.mag[0], m.mag[1], m.mag[2])
      store.magCloud.push(m.time, m.mag[0], m.mag[1], m.mag[2])
      break
    case 'baro':
      store.baro = m as NonNullable<typeof store.baro>
      break
    case 'status':
      store.status = m as Status
      break
    case 'device':
      if (store.device && store.device.model !== m.model) for (const r of Object.values(store.series)) r.clear()
      store.device = m as Device
      break
    case 'link':
      if (store.link?.up !== m.up || store.link?.why !== m.why)
        log(m.up ? `connected · ${shortDev(m.dev ?? m.port)}` : `${m.why ?? 'disconnected'} · ${shortDev(m.dev ?? m.port)}`)
      store.link = m as typeof store.link
      if (!m.up) {
        // what was live is now history; identity stays until the device says otherwise
        store.att.have = false
        store.status = store.baro = null
        Object.assign(store.imx, { sys: null, magobs: null, magcal: null, sigma: null, inl2: null })
      }
      break
    case 'src':
      store.src = m as typeof store.src
      break
    case 'log':
      log(m.msg)
      break
    default:
      if (typeof m.t === 'string' && m.t.startsWith('imx.')) {
        const key = m.t.slice(4) as keyof typeof store.imx
        if (key in store.imx) (store.imx as any)[key] = m
        if (key === 'sigma') store.att.sigma = m.StdAttNed
      }
  }
}

let started = false
let sendLocal: ((cmd: string) => void) | null = null
export function connect() {
  if (started) return
  started = true
  setInterval(() => {
    const now = performance.now()
    const dt = (now - rateStart) / 1000
    for (const k of Object.keys(counts)) {
      store.rates[k] = counts[k] / dt
      counts[k] = 0
    }
    rateStart = now
  }, 2000)
  if (DEMO) {
    store.connected = true
    sendLocal = startDemo(ingest)
    return
  }
  const es = new EventSource('stream')
  es.onopen = () => (store.connected = true)
  es.onerror = () => (store.connected = false) // EventSource retries on its own
  es.onmessage = (e) => {
    store.connected = true
    for (const m of JSON.parse(e.data)) ingest(m)
  }
}

/** Is data arriving? (stream open, device linked, a sample in the last second) */
export function isLive() {
  return store.connected && store.link?.up !== false && performance.now() - store.lastRx < 1000
}

/** A port as people read it: /dev/ttyACM1, never a 70-character by-id link. */
export const shortDev = (p?: string) => {
  if (!p) return '—'
  if (p.startsWith('/dev/serial/by-id/')) return 'USB serial'
  return p.length > 20 ? '…' + p.slice(-18) : p
}

/** The link pill's words for each state. */
export function linkState(): { state: 'live' | 'sim' | 'down'; label: string; where: string } {
  const src = store.src
  const link = store.link
  const where = src?.mode === 'device' ? shortDev(link?.dev ?? link?.port) : (src?.detail ?? '')
  if (!store.connected) return { state: 'down', label: 'No server', where: '' }
  if (isLive()) {
    const label = { device: 'Live', replay: 'Replay', sim: 'Simulated', demo: 'Demo' }[src?.mode ?? 'device'] ?? 'Live'
    return { state: src?.mode === 'device' ? 'live' : 'sim', label, where }
  }
  const why = link?.why
  const label =
    why === 'searching'
      ? 'Searching'
      : why === 'unplugged'
        ? 'Unplugged'
        : why === 'not answering' || why === 'not an IMX'
          ? 'No reply'
          : why === 'no data' || why === 'no heartbeat'
            ? 'No data'
            : 'Waiting'
  return { state: 'down', label, where: why === 'searching' ? 'plug in the sensor' : where }
}

export async function sendCommand(cmd: string) {
  if (sendLocal) return sendLocal(cmd)
  const r = await fetch('api/cmd', {
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
  const [r, p, y] = store.att.euler
  return [r * RAD, p * RAD, wrap360(y * RAD - store.yawOffset)]
}

/** The attitude quaternion rotated about NED down by the zero-yaw offset. */
export function displayQuat(): Quat {
  const [w, x, y, z] = store.att.q
  const h = (-store.yawOffset * Math.PI) / 360
  const c = Math.cos(h)
  const s = Math.sin(h)
  return [c * w - s * z, c * x - s * y, c * y + s * x, c * z + s * w] // (c, 0, 0, s) ⊗ q
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

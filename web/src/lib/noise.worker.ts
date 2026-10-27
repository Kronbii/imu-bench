/*
 * The Noise Lab's recorder and number cruncher, off the main thread. It
 * keeps the capture (six channels: gyro x/y/z in rad/s, accelerometer
 * x/y/z in m/s², block-averaged to ~100 Hz by the page) and recomputes the
 * Allan deviation of each on request. A capture of two hours is about
 * 700 000 samples a channel; the curve takes a few hundred milliseconds.
 */

import { allanDeviation, noiseTerms, type NoiseTerms } from './allan'

export const CHANNELS = 6

export type NoiseRequest =
  | { type: 'reset'; tau0: number }
  | { type: 'push'; block: Float64Array } // CHANNELS values per sample, interleaved
  | { type: 'compute' }
  | { type: 'synth'; seconds: number; tau0: number; gyroN: number; accN: number; gyroK: number; accK: number }

export interface Curve {
  tau: Float64Array
  adev: Float64Array
  n: Float64Array
}

export interface NoiseResult {
  type: 'result'
  samples: number
  seconds: number
  tau0: number
  curves: Curve[]
  terms: NoiseTerms[]
}

let tau0 = 0.01
let size = 0
let data = Array.from({ length: CHANNELS }, () => new Float64Array(1 << 15))

function reserve(more: number) {
  if (size + more <= data[0].length) return
  let cap = data[0].length
  while (cap < size + more) cap *= 2
  data = data.map((d) => {
    const n = new Float64Array(cap)
    n.set(d.subarray(0, size))
    return n
  })
}

function push(block: Float64Array) {
  const m = block.length / CHANNELS
  reserve(m)
  for (let i = 0; i < m; i++) for (let c = 0; c < CHANNELS; c++) data[c][size + i] = block[i * CHANNELS + c]
  size += m
}

/** Seeded normal deviates, so a simulated capture is the same every time. */
function gauss(seed: number) {
  let s = seed >>> 0
  const u = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u())
}

function synth(r: Extract<NoiseRequest, { type: 'synth' }>) {
  tau0 = r.tau0
  size = 0
  const n = Math.round(r.seconds / r.tau0)
  reserve(n)
  const g = gauss(42)
  const bias = [3e-4, -4.6e-4, -1.4e-3, 0.004, -0.006, 0.01]
  const white = [r.gyroN, r.gyroN, r.gyroN, r.accN, r.accN, r.accN].map((N) => N / Math.sqrt(r.tau0)) // block averages of white noise
  const walk = [r.gyroK, r.gyroK, r.gyroK, r.accK, r.accK, r.accK].map((K) => K * Math.sqrt(r.tau0))
  const level = [0, 0, 0, 0, 0, -9.80665]
  for (let i = 0; i < n; i++)
    for (let c = 0; c < CHANNELS; c++) {
      bias[c] += walk[c] * g()
      data[c][i] = level[c] + bias[c] + white[c] * g()
    }
  size = n
}

function compute(): NoiseResult {
  const curves = data.map((d) => allanDeviation(d.subarray(0, size), tau0))
  return { type: 'result', samples: size, seconds: size * tau0, tau0, curves, terms: curves.map(noiseTerms) }
}

self.onmessage = (e: MessageEvent<NoiseRequest>) => {
  const r = e.data
  if (r.type === 'reset') {
    tau0 = r.tau0
    size = 0
  } else if (r.type === 'push') push(r.block)
  else if (r.type === 'synth') {
    synth(r)
    self.postMessage(compute())
  } else if (r.type === 'compute' && size > 20) self.postMessage(compute())
}

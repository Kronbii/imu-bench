// node --test --experimental-strip-types tests/   (the maths behind Vibration, Noise Lab and magnetometer fit)
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { allanDeviation, noiseTerms } from '../src/lib/allan.ts'
import { apply, fitEllipsoid, symEig, type M3 } from '../src/lib/ellipsoid.ts'
import { bandRms, peaks, welch } from '../src/lib/spectrum.ts'

function rng(seed: number) {
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

test('welch finds a tone and conserves power', () => {
  const fs = 1000
  const g = rng(1)
  const x = Array.from({ length: 8192 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 87 * i) / fs) + 0.05 * g())
  const s = welch(x, fs, 1024)
  assert.ok(Math.abs(peaks(s, 1)[0].hz - 87) < 1.5, `peak at ${peaks(s, 1)[0].hz}`)
  // a sine of amplitude a has RMS a/√2
  assert.ok(Math.abs(bandRms(s, 80, 95) - 0.5 / Math.SQRT2) < 0.02)
  const w = Array.from({ length: 65536 }, () => g())
  const sw = welch(w, 100, 512)
  assert.ok(Math.abs(bandRms(sw, 0, 50) - 1) < 0.05, `white noise RMS ${bandRms(sw, 0, 50)}`)
})

test('allan deviation recovers white noise density and rate random walk', () => {
  const fs = 20
  const tau0 = 1 / fs
  const g = rng(7)
  const Nd = 1e-3 // rad/s/√Hz
  const K = 1e-4 // rad/s²/√Hz
  const n = 400_000 // 20000 s: a random walk needs long captures to show reliably
  const y = new Float64Array(n)
  let bias = 0
  for (let i = 0; i < n; i++) {
    bias += K * Math.sqrt(tau0) * g()
    y[i] = bias + Nd * Math.sqrt(fs) * g()
  }
  const terms = noiseTerms(allanDeviation(y, tau0))
  assert.ok(Math.abs(terms.white / Nd - 1) < 0.1, `white ${terms.white}`)
  assert.ok(terms.randomWalkMeasured, 'random walk should show on a 20000 s capture')
  assert.ok(Math.abs(terms.randomWalk / K - 1) < 0.35, `random walk ${terms.randomWalk}`)
})

test('a short white-noise capture gives a random-walk ceiling, not a measurement', () => {
  const g = rng(3)
  const y = Array.from({ length: 20_000 }, () => 0.01 * g())
  const terms = noiseTerms(allanDeviation(y, 0.01))
  assert.equal(terms.randomWalkMeasured, false)
  assert.ok(terms.randomWalk > 0)
})

test('symmetric eigen decomposition rebuilds the matrix', () => {
  const S = [4, 1, 0.5, 1, 3, 0.2, 0.5, 0.2, 2] as M3
  const { values, vectors: V } = symEig(S)
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0
      for (let e = 0; e < 3; e++) s += V[i * 3 + e] * values[e] * V[j * 3 + e]
      assert.ok(Math.abs(s - S[i * 3 + j]) < 1e-9)
    }
})

test('ellipsoid fit undoes hard and soft iron', () => {
  const g = rng(11)
  const soft = [1.25, 0.12, 0.0, 0.12, 0.85, 0.06, 0.0, 0.06, 1.05]
  const offset = [12, -20, 6]
  const pts: number[][] = []
  for (let i = 0; i < 2000; i++) {
    const v = [g(), g(), g()]
    const r = Math.hypot(v[0], v[1], v[2])
    const s = v.map((c) => (45 * c) / r)
    pts.push([0, 1, 2].map((k) => soft[k * 3] * s[0] + soft[k * 3 + 1] * s[1] + soft[k * 3 + 2] * s[2] + offset[k] + 0.15 * g()))
  }
  const cal = fitEllipsoid(pts)
  assert.ok(cal, 'fit should succeed')
  assert.ok(cal.spreadBefore > 0.1, `distortion visible before: ${cal.spreadBefore}`)
  assert.ok(cal.spreadAfter < 0.01, `sphere after: ${cal.spreadAfter}`)
  cal.center.forEach((c, k) => assert.ok(Math.abs(c - offset[k]) < 0.3, `centre ${cal.center}`))
  const r = Math.hypot(...apply(cal, pts[0]))
  assert.ok(Math.abs(r / cal.radius - 1) < 0.02)
})

test('the fit refuses a plane of points (no coverage)', () => {
  const g = rng(5)
  const flat = Array.from({ length: 500 }, () => {
    const a = Math.PI * 2 * Math.abs(g())
    return [40 * Math.cos(a), 40 * Math.sin(a), 0.01 * g()]
  })
  const cal = fitEllipsoid(flat)
  assert.ok(cal === null || cal.spreadAfter > 0.05)
})

/*
 * Allan deviation of rate data (gyro rad/s, accelerometer m/s²) and the
 * IEEE 952 noise terms read from it:
 *
 *   white noise (ARW / VRW)  N  the −½-slope line at τ = 1 s
 *   bias instability         B  the curve's minimum / 0.664
 *   rate random walk         K  the +½-slope line at τ = 3 s
 *
 * N is the continuous noise density Kalibr calls *_noise_density and K is
 * its *_random_walk. No DOM: runs in a worker and under node for tests.
 */

export interface Adev {
  tau: Float64Array // s
  adev: Float64Array // same unit as the data
  n: Float64Array // clusters averaged at each tau (confidence)
}

/** Overlapping Allan deviation of samples y taken every tau0 seconds, at ~log-spaced cluster sizes. */
export function allanDeviation(y: ArrayLike<number>, tau0: number, perDecade = 10): Adev {
  const N = y.length
  // theta = integral of the rate: theta[k] = tau0 * sum(y[0..k-1])
  const theta = new Float64Array(N + 1)
  for (let i = 0; i < N; i++) theta[i + 1] = theta[i] + y[i] * tau0
  const ms: number[] = []
  const maxM = Math.floor((N - 1) / 2)
  for (let e = 0; ; e++) {
    const m = Math.round(Math.pow(10, e / perDecade))
    if (m > maxM) break
    if (!ms.length || m > ms[ms.length - 1]) ms.push(m)
  }
  const tau = new Float64Array(ms.length)
  const adev = new Float64Array(ms.length)
  const n = new Float64Array(ms.length)
  ms.forEach((m, i) => {
    const t = m * tau0
    const terms = N + 1 - 2 * m
    // long clusters: a stride keeps the cost linear without changing the estimate much
    const stride = Math.max(1, Math.floor(m / 8))
    let sum = 0
    let count = 0
    for (let k = 0; k < terms; k += stride) {
      const d = theta[k + 2 * m] - 2 * theta[k + m] + theta[k]
      sum += d * d
      count++
    }
    tau[i] = t
    adev[i] = Math.sqrt(sum / count / (2 * t * t))
    n[i] = terms / m
  })
  return { tau, adev, n }
}

export interface NoiseTerms {
  /** white-noise density, unit/√Hz (= unit·√s); N in IEEE 952 */
  white: number
  /** bias instability, unit; B */
  biasInstability: number
  /** τ where the curve bottoms out, s */
  tauMin: number
  /** rate random walk, unit/s/√Hz; K. Measured, or an upper bound when the curve never turns up */
  randomWalk: number
  randomWalkMeasured: boolean
}

/**
 * Read N, B and K off an Allan deviation curve. N comes from the −½-slope
 * region (median of σ·√τ), B from the minimum. K comes from a weighted
 * least-squares fit of the standard model σ²(τ) = N²/τ + b + K²τ/3 over
 * every trustworthy point, and counts as measured only when its term
 * dominates the longest τ; otherwise the last point bounds it from above.
 */
export function noiseTerms(a: Adev): NoiseTerms {
  const L = a.tau.length
  const lt = Array.from(a.tau, Math.log10)
  const la = Array.from(a.adev, (v) => Math.log10(Math.max(v, 1e-300)))
  const slope = (i: number) => {
    const j = Math.min(L - 1, i + 1)
    const h = Math.max(0, i - 1)
    return (la[j] - la[h]) / (lt[j] - lt[h])
  }
  const ok = (i: number) => a.n[i] >= 9 // enough independent clusters to trust the point
  const idx = Array.from({ length: L }, (_, i) => i).filter(ok)
  if (!idx.length) return { white: NaN, biasInstability: NaN, tauMin: NaN, randomWalk: NaN, randomWalkMeasured: false }

  let iMin = idx[0]
  for (const i of idx) if (a.adev[i] < a.adev[iMin]) iMin = i
  const whiteEst = idx.filter((i) => slope(i) > -0.65 && slope(i) < -0.35).map((i) => a.adev[i] * Math.sqrt(a.tau[i]))
  whiteEst.sort((x, y) => x - y)
  const white = whiteEst.length ? whiteEst[Math.floor(whiteEst.length / 2)] : a.adev[idx[0]] * Math.sqrt(a.tau[idx[0]])

  // weighted least squares on σ² with basis [1/τ, 1, τ]; Var(σ²) ∝ σ⁴/n
  const fit = (cols: number[]) => {
    const k = cols.length
    const AtA = new Array(k * k).fill(0)
    const Atb = new Array(k).fill(0)
    for (const i of idx) {
      const t = a.tau[i]
      const v = a.adev[i] * a.adev[i]
      const w = a.n[i] / (v * v)
      const basis = [1 / t, 1, t]
      const row = cols.map((c) => basis[c])
      for (let r = 0; r < k; r++) {
        Atb[r] += w * row[r] * v
        for (let c = 0; c < k; c++) AtA[r * k + c] += w * row[r] * row[c]
      }
    }
    // tiny k×k Gauss-Jordan
    const M = AtA.slice()
    const x = Atb.slice()
    for (let c = 0; c < k; c++) {
      let p = c
      for (let r = c + 1; r < k; r++) if (Math.abs(M[r * k + c]) > Math.abs(M[p * k + c])) p = r
      for (let j = 0; j < k; j++) [M[c * k + j], M[p * k + j]] = [M[p * k + j], M[c * k + j]]
      ;[x[c], x[p]] = [x[p], x[c]]
      const d = M[c * k + c] || 1e-300
      for (let j = 0; j < k; j++) M[c * k + j] /= d
      x[c] /= d
      for (let r = 0; r < k; r++) {
        if (r === c) continue
        const f = M[r * k + c]
        for (let j = 0; j < k; j++) M[r * k + j] -= f * M[c * k + j]
        x[r] -= f * x[c]
      }
    }
    return x
  }
  let coef = fit([0, 1, 2])
  if (coef[1] < 0) coef = (([c0, c2]) => [c0, 0, c2])(fit([0, 2]))
  const kTerm = Math.max(0, coef[2])
  const last = idx[idx.length - 1]
  const tl = a.tau[last]
  const measured = kTerm > 0 && (kTerm * tl) / (a.adev[last] * a.adev[last]) > 0.5
  return {
    white,
    biasInstability: a.adev[iMin] / 0.664,
    tauMin: a.tau[iMin],
    randomWalk: measured ? Math.sqrt(3 * kTerm) : a.adev[last] * Math.sqrt(3 / tl),
    randomWalkMeasured: measured,
  }
}

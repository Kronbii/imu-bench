/*
 * Magnetometer hard- and soft-iron calibration by ellipsoid fit.
 *
 * A clean magnetometer turned through every orientation traces a sphere.
 * Nearby steel (soft iron) squashes it into an ellipsoid and magnets or
 * currents (hard iron) move its centre. Fit the general quadric
 *   A x² + B y² + C z² + 2D xy + 2E xz + 2F yz + 2G x + 2H y + 2I z = 1
 * by least squares, then the correction is  m_cal = W (m − c):  c the
 * centre, W the symmetric square root of the shape matrix, scaled so the
 * corrected sphere keeps the field's own size (its units don't change).
 */

export type V3 = [number, number, number]
export type M3 = [number, number, number, number, number, number, number, number, number] // row-major

export interface MagCal {
  center: V3 // hard iron
  matrix: M3 // soft iron, applied after removing the centre
  radius: number // field strength of the corrected sphere
  spreadBefore: number // relative spread of |m| as measured, e.g. 0.12 = 12 %
  spreadAfter: number
  samples: number
}

/** Solve A x = b (n×n, row-major) by Gaussian elimination with partial pivoting. */
function solve(A: number[], b: number[], n: number): number[] | null {
  const a = A.slice()
  const x = b.slice()
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r * n + c]) > Math.abs(a[p * n + c])) p = r
    if (Math.abs(a[p * n + c]) < 1e-14) return null
    if (p !== c) {
      for (let k = 0; k < n; k++) [a[c * n + k], a[p * n + k]] = [a[p * n + k], a[c * n + k]]
      ;[x[c], x[p]] = [x[p], x[c]]
    }
    for (let r = c + 1; r < n; r++) {
      const f = a[r * n + c] / a[c * n + c]
      for (let k = c; k < n; k++) a[r * n + k] -= f * a[c * n + k]
      x[r] -= f * x[c]
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r]
    for (let k = r + 1; k < n; k++) s -= a[r * n + k] * x[k]
    x[r] = s / a[r * n + r]
  }
  return x
}

/** Eigen-decomposition of a symmetric 3×3 matrix (Jacobi): S = V diag(e) Vᵀ. */
export function symEig(S: M3): { values: V3; vectors: M3 } {
  const a = S.slice() as number[]
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5]
    if (off < 1e-30) break
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      const apq = a[p * 3 + q]
      if (Math.abs(apq) < 1e-300) continue
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq)
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p]
        const akq = a[k * 3 + q]
        a[k * 3 + p] = c * akp - s * akq
        a[k * 3 + q] = s * akp + c * akq
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k]
        const aqk = a[q * 3 + k]
        a[p * 3 + k] = c * apk - s * aqk
        a[q * 3 + k] = s * apk + c * aqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p]
        const vkq = v[k * 3 + q]
        v[k * 3 + p] = c * vkp - s * vkq
        v[k * 3 + q] = s * vkp + c * vkq
      }
    }
  }
  return { values: [a[0], a[4], a[8]], vectors: v as M3 }
}

export function apply(cal: Pick<MagCal, 'center' | 'matrix'>, m: ArrayLike<number>): V3 {
  const d = [m[0] - cal.center[0], m[1] - cal.center[1], m[2] - cal.center[2]]
  const W = cal.matrix
  return [W[0] * d[0] + W[1] * d[1] + W[2] * d[2], W[3] * d[0] + W[4] * d[1] + W[5] * d[2], W[6] * d[0] + W[7] * d[1] + W[8] * d[2]]
}

function spread(points: ArrayLike<number>[], f: (p: ArrayLike<number>) => ArrayLike<number>) {
  let s = 0
  let s2 = 0
  for (const p of points) {
    const q = f(p)
    const r = Math.hypot(q[0], q[1], q[2])
    s += r
    s2 += r * r
  }
  const mean = s / points.length
  return Math.sqrt(Math.max(0, s2 / points.length - mean * mean)) / mean
}

/** Fit a calibration to magnetometer samples. Null when the points don't define an ellipsoid (too little coverage). */
export function fitEllipsoid(points: ArrayLike<number>[]): MagCal | null {
  if (points.length < 30) return null
  // normal equations of the 9-term linear least squares, centred and scaled for conditioning
  let mx = 0
  let my = 0
  let mz = 0
  for (const p of points) {
    mx += p[0]
    my += p[1]
    mz += p[2]
  }
  mx /= points.length
  my /= points.length
  mz /= points.length
  let scale = 0
  for (const p of points) scale = Math.max(scale, Math.abs(p[0] - mx), Math.abs(p[1] - my), Math.abs(p[2] - mz))
  if (!(scale > 0)) return null
  const AtA = new Array(81).fill(0)
  const Atb = new Array(9).fill(0)
  for (const p of points) {
    const x = (p[0] - mx) / scale
    const y = (p[1] - my) / scale
    const z = (p[2] - mz) / scale
    const row = [x * x, y * y, z * z, 2 * x * y, 2 * x * z, 2 * y * z, 2 * x, 2 * y, 2 * z]
    for (let i = 0; i < 9; i++) {
      Atb[i] += row[i]
      for (let j = 0; j < 9; j++) AtA[i * 9 + j] += row[i] * row[j]
    }
  }
  const v = solve(AtA, Atb, 9)
  if (!v) return null
  const M = [v[0], v[3], v[4], v[3], v[1], v[5], v[4], v[5], v[2]] as M3
  const g = [v[6], v[7], v[8]]
  const cs = solve(M, [-g[0], -g[1], -g[2]], 3)
  if (!cs) return null
  // at the centre: (p−c)ᵀ M (p−c) = 1 + cᵀ M c
  const Mc = [M[0] * cs[0] + M[1] * cs[1] + M[2] * cs[2], M[3] * cs[0] + M[4] * cs[1] + M[5] * cs[2], M[6] * cs[0] + M[7] * cs[1] + M[8] * cs[2]]
  const k = 1 + cs[0] * Mc[0] + cs[1] * Mc[1] + cs[2] * Mc[2]
  const { values, vectors: V } = symEig(M.map((x) => x / k) as M3)
  if (values.some((e) => !(e > 0))) return null // not an ellipsoid: coverage too thin
  // real soft iron is a few tens of percent; a 3:1 ellipsoid means the points only cover a band
  if (Math.sqrt(Math.max(...values) / Math.min(...values)) > 3) return null
  // the radius that keeps the units: the geometric mean of the semi-axes, in raw units
  const radius = scale / Math.cbrt(Math.sqrt(values[0] * values[1] * values[2]))
  // sqrt(M') maps the normalised ellipsoid onto the unit sphere; /scale takes raw offsets in, ×radius keeps the size
  const W = new Array(9).fill(0)
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0
      for (let e = 0; e < 3; e++) s += V[i * 3 + e] * Math.sqrt(values[e]) * V[j * 3 + e]
      W[i * 3 + j] = (s * radius) / scale
    }
  const center: V3 = [cs[0] * scale + mx, cs[1] * scale + my, cs[2] * scale + mz]
  const cal = { center, matrix: W as M3 }
  return {
    ...cal,
    radius,
    spreadBefore: spread(points, (p) => p), // |m| as measured, as the coverage card shows it
    spreadAfter: spread(points, (p) => apply(cal, p)),
    samples: points.length,
  }
}

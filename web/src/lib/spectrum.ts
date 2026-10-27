/*
 * Spectra for vibration analysis: an in-place radix-2 FFT and Welch's
 * averaged periodogram (Hann window, 50 % overlap, one-sided density).
 * No DOM, so it runs in a worker and under node for tests.
 */

/** In-place complex FFT; re/im length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

export interface Psd {
  f: Float64Array // Hz, 0 .. fs/2
  psd: Float64Array // units² / Hz, one-sided
  segments: number
}

/** Welch power spectral density of evenly sampled x at fs Hz, segments of n (power of two). */
export function welch(x: ArrayLike<number>, fs: number, n = 512): Psd {
  const half = n / 2
  const f = new Float64Array(half + 1)
  const psd = new Float64Array(half + 1)
  for (let k = 0; k <= half; k++) f[k] = (k * fs) / n
  if (x.length < n) return { f, psd, segments: 0 }
  const w = new Float64Array(n)
  let wss = 0
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    wss += w[i] * w[i]
  }
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  let segments = 0
  for (let start = 0; start + n <= x.length; start += half) {
    let mean = 0
    for (let i = 0; i < n; i++) mean += x[start + i]
    mean /= n
    for (let i = 0; i < n; i++) {
      re[i] = (x[start + i] - mean) * w[i]
      im[i] = 0
    }
    fft(re, im)
    for (let k = 0; k <= half; k++) {
      const p = (re[k] * re[k] + im[k] * im[k]) / (fs * wss)
      psd[k] += k === 0 || k === half ? p : 2 * p // fold negative frequencies in
    }
    segments++
  }
  for (let k = 0; k <= half; k++) psd[k] /= segments
  return { f, psd, segments }
}

/** The strongest local maxima above minHz, strongest first, at least sepHz apart (one per hill, not every ripple). */
export function peaks(s: Psd, count = 3, minHz = 1, sepHz = 0): { hz: number; psd: number }[] {
  const all: { hz: number; psd: number }[] = []
  for (let k = 1; k < s.psd.length - 1; k++) {
    if (s.f[k] < minHz) continue
    if (s.psd[k] > s.psd[k - 1] && s.psd[k] >= s.psd[k + 1]) all.push({ hz: s.f[k], psd: s.psd[k] })
  }
  all.sort((a, b) => b.psd - a.psd)
  const out: { hz: number; psd: number }[] = []
  for (const p of all) {
    if (out.some((q) => Math.abs(q.hz - p.hz) < sepHz)) continue
    out.push(p)
    if (out.length === count) break
  }
  return out
}

/** RMS of the signal within a band, from its PSD. */
export function bandRms(s: Psd, lo: number, hi: number) {
  let sum = 0
  const df = s.f[1] - s.f[0]
  for (let k = 0; k < s.f.length; k++) if (s.f[k] >= lo && s.f[k] <= hi) sum += s.psd[k] * df
  return Math.sqrt(sum)
}

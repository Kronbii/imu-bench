/*
 * A camera rigidly mounted to the IMU: where the true horizon lands in its
 * image, and the rotation-only warp that stabilises it.
 *
 * Frames: NED world; FRD body; camera as OpenCV (x right, y down, z along
 * the optical axis). A mount is the rotation from camera to body (its
 * columns are the camera's axes written in the body frame). Images are
 * pinhole with square pixels and the principal point at the centre.
 */

export type Mat3 = number[] // row-major 3×3
export type Quat = number[] // w, x, y, z

export const DEG = Math.PI / 180

export function quatToMat([w, x, y, z]: Quat): Mat3 {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ]
}

export function matToQuat(m: Mat3): Quat {
  const tr = m[0] + m[4] + m[8]
  let q: Quat
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    q = [0.25 * s, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s]
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2
    q = [(m[7] - m[5]) / s, 0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s]
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2
    q = [(m[2] - m[6]) / s, (m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s]
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2
    q = [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s]
  }
  const n = Math.hypot(...q)
  return q.map((c) => c / n)
}

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return r
}

export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]

export const apply = (m: Mat3, v: number[]) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]

/** ZYX (yaw, pitch, roll) rotation, radians. */
export function eulerMat(roll: number, pitch: number, yaw: number): Mat3 {
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(roll), Math.sin(roll), Math.cos(pitch), Math.sin(pitch), Math.cos(yaw), Math.sin(yaw)]
  return [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr,
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr,
    -sp, cp * sr, cp * cr,
  ]
}

/** Camera-to-body mounts. Columns: camera x (right), y (down), z (optical axis), in the body frame. */
export const MOUNTS: Record<string, { label: string; m: Mat3 }> = {
  forward: { label: 'Looking forward (+X)', m: [0, 0, 1, 1, 0, 0, 0, 1, 0] },
  down: { label: 'Looking down (+Z)', m: [0, -1, 0, 1, 0, 0, 0, 0, 1] },
  backward: { label: 'Looking back (−X)', m: [0, 0, -1, -1, 0, 0, 0, 1, 0] },
}

/** Camera-to-body rotation for a mount, adjusted by small trims (body-frame ZYX, radians). */
export function mount(name: string, trim = [0, 0, 0]) {
  return mul(eulerMat(trim[0], trim[1], trim[2]), (MOUNTS[name] ?? MOUNTS.forward).m)
}

export interface Intrinsics {
  w: number
  h: number
  f: number // pixels
}

export const intrinsics = (w: number, h: number, hfovDeg: number): Intrinsics => ({ w, h, f: w / 2 / Math.tan((hfovDeg * DEG) / 2) })

/** Camera-to-NED rotation for an attitude (body to NED quaternion) and a mount. */
export const cameraToNed = (q: Quat, camToBody: Mat3) => mul(quatToMat(q), camToBody)

/** Image point of a NED direction, or null when it is behind the camera. */
export function project(camToNed: Mat3, K: Intrinsics, dNed: number[]): [number, number] | null {
  const c = apply(transpose(camToNed), dNed)
  if (c[2] <= 1e-3) return null
  return [K.w / 2 + (K.f * c[0]) / c[2], K.h / 2 + (K.f * c[1]) / c[2]]
}

/** Polylines (in pixels) of the circle at `elevDeg` above the horizon; split where it leaves the view. */
export function elevationCircle(camToNed: Mat3, K: Intrinsics, elevDeg = 0, steps = 720): [number, number][][] {
  const e = elevDeg * DEG
  const lines: [number, number][][] = []
  let cur: [number, number][] = []
  const margin = Math.max(K.w, K.h)
  for (let i = 0; i <= steps; i++) {
    const az = (i / steps) * 2 * Math.PI
    const p = project(camToNed, K, [Math.cos(e) * Math.cos(az), Math.cos(e) * Math.sin(az), -Math.sin(e)])
    if (p && p[0] > -margin && p[0] < K.w + margin && p[1] > -margin && p[1] < K.h + margin) cur.push(p)
    else if (cur.length) {
      if (cur.length > 1) lines.push(cur)
      cur = []
    }
  }
  if (cur.length > 1) lines.push(cur)
  return lines
}

/** Heading (rad) of the optical axis, projected on the horizontal plane. */
export function cameraAzimuth(camToNed: Mat3) {
  return Math.atan2(camToNed[5], camToNed[2])
}

/** A virtual camera looking horizontally along the real one's azimuth, no roll: the "level horizon" view. */
export function levelCamera(camToNed: Mat3): Mat3 {
  const az = cameraAzimuth(camToNed)
  const [c, s] = [Math.cos(az), Math.sin(az)]
  // columns: right (−s, c, 0), down (0, 0, 1), forward (c, s, 0)
  return [-s, 0, c, c, 0, s, 0, 1, 0]
}

/** Body yaw (rad) of a body-to-NED quaternion, ZYX. */
export const yawOf = ([w, x, y, z]: Quat) => Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))

/**
 * The camera as it would sit if the body were level, keeping its heading:
 * "level horizon" stabilisation that works for any mount (looking forward,
 * it is levelCamera; looking down, it stays pointed at the ground).
 */
export const levelBodyCamera = (q: Quat, camToBody: Mat3) => mul(eulerMat(0, 0, yawOf(q)), camToBody)

/** Angle (rad) of the rotation between two rotation matrices. */
export function angleBetween(a: Mat3, b: Mat3) {
  const m = mul(transpose(a), b)
  return Math.acos(Math.max(-1, Math.min(1, (m[0] + m[4] + m[8] - 1) / 2)))
}

/**
 * The 3×3 matrix the warp shader needs: for a pixel of the virtual camera, the ray in the real camera.
 * r_real = R_realᵀ · R_virtual · r_virtual (rays in normalised camera coordinates).
 */
export const warpMatrix = (realCamToNed: Mat3, virtualCamToNed: Mat3) => mul(transpose(realCamToNed), virtualCamToNed)

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const bb = dot < 0 ? b.map((c) => -c) : b
  dot = Math.abs(dot)
  if (dot > 0.9995) {
    const r = a.map((c, i) => c + t * (bb[i] - c))
    const n = Math.hypot(...r)
    return r.map((c) => c / n)
  }
  const th = Math.acos(dot)
  const s = Math.sin(th)
  const wa = Math.sin((1 - t) * th) / s
  const wb = Math.sin(t * th) / s
  return a.map((c, i) => wa * c + wb * bb[i])
}

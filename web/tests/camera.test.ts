// node --test --experimental-strip-types tests/camera.test.ts   (horizon projection and stabilisation maths)
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { angleBetween, apply, cameraToNed, DEG, elevationCircle, intrinsics, levelBodyCamera, levelCamera, matToQuat, mount, quatToMat, transpose, warpMatrix } from '../src/lib/camera.ts'

const q = (roll: number, pitch: number, yaw: number) => {
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(roll / 2), Math.sin(roll / 2), Math.cos(pitch / 2), Math.sin(pitch / 2), Math.cos(yaw / 2), Math.sin(yaw / 2)]
  return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy]
}
const K = intrinsics(640, 480, 90) // f = 320 px

/** Horizon line through the image: its points near the centre column, as [slope, row at centre]. */
function horizon(qn2b: number[], m = mount('forward')) {
  const pts = elevationCircle(cameraToNed(qn2b, m), K).flat().filter(([u]) => u > 200 && u < 440)
  // least-squares line: the circle can split into several segments, in any order
  const n = pts.length
  const mu = pts.reduce((s, [u]) => s + u, 0) / n
  const mv = pts.reduce((s, [, v]) => s + v, 0) / n
  const slope = pts.reduce((s, [u, v]) => s + (u - mu) * (v - mv), 0) / pts.reduce((s, [u]) => s + (u - mu) ** 2, 0)
  return { slope, row: mv + slope * (320 - mu) }
}

test('a level forward camera sees the horizon straight across the middle', () => {
  const h = horizon(q(0, 0, 0.7))
  assert.ok(Math.abs(h.slope) < 1e-6)
  assert.ok(Math.abs(h.row - 240) < 1e-6)
})

test('pitching the nose up drops the horizon by f·tan(pitch)', () => {
  const h = horizon(q(0, 10 * DEG, 0))
  assert.ok(Math.abs(h.row - (240 + 320 * Math.tan(10 * DEG))) < 0.5, `row ${h.row}`)
})

test('rolling right tilts the horizon the other way in the image', () => {
  // right wing down: the world appears to rotate counter-clockwise, so the horizon rises to the right (v falls)
  const h = horizon(q(15 * DEG, 0, 0))
  assert.ok(Math.abs(h.slope + Math.tan(15 * DEG)) < 1e-3, `slope ${h.slope}`)
})

test('the level virtual camera undoes roll and pitch exactly', () => {
  const real = cameraToNed(q(12 * DEG, -7 * DEG, 40 * DEG), mount('forward'))
  const virt = levelCamera(real)
  const virtExpected = cameraToNed(q(0, 0, 40 * DEG), mount('forward'))
  virt.forEach((v, i) => assert.ok(Math.abs(v - virtExpected[i]) < 1e-9))
  // a level camera's horizon ray (forward) maps to the real camera's view of the horizon
  const M = warpMatrix(real, virt)
  const r = apply(M, [0, 0, 1]) // virtual centre ray
  const dNed = apply(real, r)
  assert.ok(Math.abs(dNed[2]) < 1e-9, 'the virtual centre looks at the horizon')
})

test('quaternion and matrix conversions agree', () => {
  const m = quatToMat(q(0.3, -0.2, 2.5))
  const back = quatToMat(matToQuat(m))
  m.forEach((v, i) => assert.ok(Math.abs(v - back[i]) < 1e-9))
  // rotation matrices are orthonormal: Mᵀ M = I
  const mtm = transpose(m).map((_, i) => [0, 1, 2].reduce((s, k) => s + transpose(m)[Math.floor(i / 3) * 3 + k] * m[k * 3 + (i % 3)], 0))
  mtm.forEach((v, i) => assert.ok(Math.abs(v - (i % 4 === 0 ? 1 : 0)) < 1e-9))
})

test('levelling the body matches the level camera looking forward, and keeps a down camera on the ground', () => {
  const att = q(9 * DEG, -14 * DEG, 130 * DEG)
  const fwd = mount('forward', [0, 0, 0])
  const a = levelBodyCamera(att, fwd)
  const b = levelCamera(cameraToNed(att, fwd))
  assert.ok(angleBetween(a, b) < 1e-9)
  const down = levelBodyCamera(att, mount('down'))
  assert.ok(Math.abs(down[8] - 1) < 1e-9, 'the optical axis points straight down')
  assert.ok(Math.abs(angleBetween(mount('forward', [0.01, 0, 0]), fwd) - 0.01) < 1e-9)
})

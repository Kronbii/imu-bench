import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

import type { Form } from '../telemetry'
import { buildRug3 } from './rug3'

/*
 * The three specimens the plate can hold, all in the same space: three.js
 * coordinates with the body at zero attitude, body +X (forward) along -Z,
 * +Y (right) along +X, +Z (down) along -Y, origin at the IMU. One unit is
 * 10 mm for the RUG-3, which is drawn to its drawing; the board and the
 * quadrotor are generic and sized to read well, not to scale.
 */

export interface Callout {
  key: string
  label: string
  color?: string
  obj: THREE.Object3D
}

export interface Model {
  group: THREE.Group
  callouts: Callout[]
  dispose(): void
}

const AXIS = { x: '#d95926', y: '#199e70', z: '#3987e5' }

type Keep = <T extends { dispose(): void }>(x: T) => T

function arrows(group: THREE.Group, keep: Keep, lengths: [number, number, number]) {
  const make = (dir: THREE.Vector3, length: number, color: string) => {
    const g = new THREE.Group()
    const mat = keep(new THREE.MeshBasicMaterial({ color, toneMapped: false }))
    const head = 0.36
    const shaft = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.03, 0.03, length - head, 12)), mat)
    shaft.position.y = (length - head) / 2
    const cone = new THREE.Mesh(keep(new THREE.ConeGeometry(0.12, head, 18)), mat)
    cone.position.y = length - head / 2
    g.add(shaft, cone)
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    const tip = new THREE.Object3D()
    tip.position.copy(dir).multiplyScalar(length)
    group.add(g, tip)
    return tip
  }
  const origin = new THREE.Mesh(keep(new THREE.SphereGeometry(0.07, 16, 12)), keep(new THREE.MeshBasicMaterial({ color: 0xeef1ec, toneMapped: false })))
  group.add(origin)
  return {
    x: make(new THREE.Vector3(0, 0, -1), lengths[0], AXIS.x),
    y: make(new THREE.Vector3(1, 0, 0), lengths[1], AXIS.y),
    z: make(new THREE.Vector3(0, -1, 0), lengths[2], AXIS.z),
  }
}

const axisCallouts = (tips: { x: THREE.Object3D; y: THREE.Object3D; z: THREE.Object3D }, names: [string, string, string]): Callout[] => [
  { key: 'x', label: names[0], color: 'var(--x)', obj: tips.x },
  { key: 'y', label: names[1], color: 'var(--y)', obj: tips.y },
  { key: 'z', label: names[2], color: 'var(--z)', obj: tips.z },
]

function silk(w: number, h: number, title: string) {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = Math.round((1024 * h) / w)
  const g = c.getContext('2d')!
  const W = c.width
  const H = c.height
  const mono = '"Spline Sans Mono Variable", "Spline Sans Mono", monospace'
  g.fillStyle = '#16211b'
  g.fillRect(0, 0, W, H)
  g.strokeStyle = 'rgba(238, 241, 236, 0.22)'
  g.lineWidth = 4
  g.strokeRect(W * 0.04, H * 0.05, W * 0.92, H * 0.9)
  g.fillStyle = 'rgba(238, 241, 236, 0.75)'
  g.font = `600 ${W * 0.06}px ${mono}`
  g.textBaseline = 'middle'
  g.fillText(title, W * 0.08, H * 0.13)
  // printed axis mark, bottom right: X up (forward), Y right
  const cx = W * 0.8
  const cy = H * 0.74
  const L = W * 0.1
  for (const [dx, dy, col, t] of [
    [0, -1, AXIS.x, 'X'],
    [1, 0, AXIS.y, 'Y'],
  ] as const) {
    g.strokeStyle = col
    g.fillStyle = col
    g.lineWidth = W * 0.012
    g.beginPath()
    g.moveTo(cx, cy)
    g.lineTo(cx + dx * L, cy + dy * L)
    g.stroke()
    g.fillStyle = 'rgba(238, 241, 236, 0.8)'
    g.font = `600 ${W * 0.045}px ${mono}`
    g.textAlign = 'center'
    g.fillText(t, cx + dx * (L + W * 0.04), cy + dy * (L + W * 0.04))
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/** A generic breakout board: PCB, the IMU package at the origin, a pin header at the back. */
function buildBoard(): Model {
  const group = new THREE.Group()
  const bin: { dispose(): void }[] = []
  const keep: Keep = (x) => (bin.push(x), x)
  const L = 3.0 // along X
  const W = 2.3 // along Y
  const T = 0.16
  const chipT = 0.14

  const pcb = new THREE.Mesh(keep(new RoundedBoxGeometry(W, T, L, 2, 0.08)), keep(new THREE.MeshStandardMaterial({ color: 0x17231c, roughness: 0.6, metalness: 0.1 })))
  pcb.position.y = -chipT / 2 - T / 2
  group.add(pcb)
  const top = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(W - 0.12, L - 0.12)),
    keep(new THREE.MeshStandardMaterial({ map: keep(silk(W, L, 'IMU')), roughness: 0.65, metalness: 0.1 })),
  )
  top.rotation.x = -Math.PI / 2
  top.position.y = -chipT / 2 + 0.002
  group.add(top)

  const chip = new THREE.Mesh(keep(new RoundedBoxGeometry(0.8, chipT, 0.8, 2, 0.03)), keep(new THREE.MeshStandardMaterial({ color: 0x0b0d0c, roughness: 0.45, metalness: 0.2 })))
  group.add(chip)
  const dot = new THREE.Mesh(keep(new THREE.CircleGeometry(0.05, 16)), keep(new THREE.MeshBasicMaterial({ color: 0x9aa39c })))
  dot.rotation.x = -Math.PI / 2
  dot.position.set(-0.28, chipT / 2 + 0.002, -0.28) // pin 1
  group.add(dot)

  const gold = keep(new THREE.MeshStandardMaterial({ color: 0xc9a85a, metalness: 1, roughness: 0.3 }))
  const plastic = keep(new THREE.MeshStandardMaterial({ color: 0x0c0e0d, roughness: 0.5 }))
  const header = new THREE.Group()
  const n = 8
  const pitch = 0.254
  const housing = new THREE.Mesh(keep(new THREE.BoxGeometry(n * pitch, 0.25, 0.25)), plastic)
  header.add(housing)
  const pinGeo = keep(new THREE.BoxGeometry(0.064, 0.6, 0.064))
  for (let i = 0; i < n; i++) {
    const pin = new THREE.Mesh(pinGeo, gold)
    pin.position.set((i - (n - 1) / 2) * pitch, 0.12, 0)
    header.add(pin)
  }
  header.position.set(0, -chipT / 2 + 0.125, L / 2 - 0.3) // the -X edge
  group.add(header)
  const holeGeo = keep(new THREE.RingGeometry(0.1, 0.17, 24))
  for (const s of [-1, 1]) {
    const ring = new THREE.Mesh(holeGeo, gold)
    ring.rotation.x = -Math.PI / 2
    ring.position.set(s * (W / 2 - 0.3), -chipT / 2 + 0.003, -L / 2 + 0.3)
    group.add(ring)
  }

  const tips = arrows(group, keep, [L / 2 + 1.5, W / 2 + 1.3, 1.6])
  const pinsAnchor = new THREE.Object3D()
  pinsAnchor.position.set(0, 0.2, L / 2 - 0.3)
  group.add(pinsAnchor)
  return {
    group,
    callouts: [...axisCallouts(tips, ['+X · roll axis', '+Y · pitch axis', '+Z · yaw axis, down']), { key: 'extra', label: 'Pin header', obj: pinsAnchor }],
    dispose: () => bin.forEach((b) => b.dispose()),
  }
}

/** An X quadrotor seen from its flight controller's frame. */
function buildQuad(): Model {
  const group = new THREE.Group()
  const bin: { dispose(): void }[] = []
  const keep: Keep = (x) => (bin.push(x), x)
  const carbon = keep(new THREE.MeshStandardMaterial({ color: 0x1a1f1c, roughness: 0.55, metalness: 0.35 }))
  const metal = keep(new THREE.MeshStandardMaterial({ color: 0x2b312d, roughness: 0.35, metalness: 0.8 }))
  const dark = keep(new THREE.MeshStandardMaterial({ color: 0x0c0e0d, roughness: 0.5 }))
  const disc = keep(new THREE.MeshBasicMaterial({ color: 0xb7d3a8, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }))
  const rim = keep(new THREE.MeshBasicMaterial({ color: 0xb7d3a8, transparent: true, opacity: 0.35 }))

  const plate = new THREE.Mesh(keep(new RoundedBoxGeometry(1.25, 0.12, 2.0, 2, 0.06)), carbon)
  plate.position.y = -0.2
  group.add(plate)
  const topPlate = new THREE.Mesh(keep(new RoundedBoxGeometry(1.1, 0.09, 1.6, 2, 0.04)), carbon)
  topPlate.position.y = 0.32
  group.add(topPlate)
  const stack = new THREE.Mesh(keep(new RoundedBoxGeometry(0.75, 0.42, 0.75, 2, 0.05)), dark)
  stack.position.y = 0.05
  group.add(stack)
  const battery = new THREE.Mesh(keep(new RoundedBoxGeometry(0.85, 0.42, 1.45, 3, 0.1)), keep(new THREE.MeshStandardMaterial({ color: 0x232a26, roughness: 0.7 })))
  battery.position.y = 0.6
  group.add(battery)
  const cam = new THREE.Mesh(keep(new RoundedBoxGeometry(0.42, 0.42, 0.36, 2, 0.06)), dark)
  cam.position.set(0, 0.05, -1.05)
  group.add(cam)
  const lens = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.11, 0.11, 0.1, 20)), metal)
  lens.rotation.x = Math.PI / 2
  lens.position.set(0, 0.05, -1.25)
  group.add(lens)

  const armLen = 2.25
  const motorAnchor = new THREE.Object3D()
  // front right, rear right, rear left, front left; front is -Z, right is +X
  const corners: [number, number][] = [
    [1, -1],
    [1, 1],
    [-1, 1],
    [-1, -1],
  ]
  corners.forEach(([sx, sz], i) => {
    const angle = Math.atan2(sx, sz)
    const arm = new THREE.Mesh(keep(new RoundedBoxGeometry(0.26, 0.1, armLen, 2, 0.04)), carbon)
    arm.position.set((sx * armLen) / 2 / Math.SQRT2, -0.2, (sz * armLen) / 2 / Math.SQRT2)
    arm.rotation.y = angle
    group.add(arm)
    const end = new THREE.Vector3((sx * armLen) / Math.SQRT2, -0.2, (sz * armLen) / Math.SQRT2)
    const motor = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.22, 0.24, 0.32, 24)), metal)
    motor.position.copy(end).add(new THREE.Vector3(0, 0.2, 0))
    group.add(motor)
    const prop = new THREE.Mesh(keep(new THREE.CircleGeometry(0.95, 48)), disc)
    prop.rotation.x = -Math.PI / 2
    prop.position.copy(end).add(new THREE.Vector3(0, 0.4, 0))
    group.add(prop)
    const ring = new THREE.Mesh(keep(new THREE.RingGeometry(0.93, 0.95, 64)), rim)
    ring.rotation.x = -Math.PI / 2
    ring.position.copy(prop.position)
    group.add(ring)
    if (i === 0) {
      motorAnchor.position.copy(end).add(new THREE.Vector3(0, 0.45, 0))
      group.add(motorAnchor)
    }
  })

  const tips = arrows(group, keep, [2.6, 2.2, 1.9])
  return {
    group,
    callouts: [...axisCallouts(tips, ['+X · nose', '+Y · right', '+Z · down']), { key: 'extra', label: 'Motor 1 · front right', obj: motorAnchor }],
    dispose: () => bin.forEach((b) => b.dispose()),
  }
}

function rug3(): Model {
  const r = buildRug3()
  return {
    group: r.group,
    callouts: [
      ...axisCallouts(r.anchors, ['+X · roll axis', '+Y · pitch axis', '+Z · yaw axis, down']),
      { key: 'extra', label: 'Connector', obj: r.anchors.connector },
    ],
    dispose: r.dispose,
  }
}

export function buildModel(form: Form): Model {
  return form === 'quad' ? buildQuad() : form === 'board' ? buildBoard() : rug3()
}

/** Distance the camera keeps from each model, so all three fill the plate alike. */
export const VIEW_RADIUS: Record<Form, number> = { rug3: 15, board: 14, quad: 19 }

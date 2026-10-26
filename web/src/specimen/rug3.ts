import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

/*
 * The RUG-3-IMX-5 (P/N IS-RUG-3.0-G0), modelled from drawing
 * IS-RUG-3.0-G0-PINOUT rev 1, with the body axes drawn from the IMU centre.
 *
 * Model space is three.js space with the unit at zero attitude: body +X
 * (forward, away from MAIN) along -Z, body +Y (right) along +X, body +Z
 * (down) along -Y. The origin is the IMU centre, so the unit turns about the
 * point the IMX actually measures. One unit is 10 mm.
 */

const IN = 2.54 // inches to model units

export const DIM = {
  length: 1.2 * IN, // body X, 30.5 mm
  width: 1.0 * IN, // body Y, 25.4 mm
  height: 0.389 * IN, // body Z incl. tabs, 9.9 mm
  tabSpan: 1.414 * IN, // across the mounting tabs (along Y)
  tabT: 0.075 * IN, // tab thickness
  holePitch: 1.214 * IN, // 2x Ø0.125 holes
  hole: 0.125 * IN,
  base: 0.189 * IN, // lower tier height
  connOut: 0.124 * IN, // MAIN connector stands this far off the -X face
  // IMU centre relative to the body's geometric centre, in body axes
  imu: { x: -0.039 * IN, y: 0.14 * IN, zFromBottom: 0.274 * IN },
}

export interface Rug3 {
  group: THREE.Group
  anchors: { x: THREE.Object3D; y: THREE.Object3D; z: THREE.Object3D; connector: THREE.Object3D }
  dispose(): void
}

const AXIS = { x: '#d95926', y: '#199e70', z: '#3987e5' }

/** The lid: the circled axis mark and MAIN by the connector edge, as printed. */
function lidTexture(w: number, h: number): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = Math.round((1024 * h) / w)
  const g = c.getContext('2d')!
  const W = c.width
  const H = c.height
  const ink = 'rgba(238, 241, 236, 0.8)'
  const faint = 'rgba(238, 241, 236, 0.26)'
  const mono = '"Spline Sans Mono Variable", "Spline Sans Mono", monospace'
  g.fillStyle = '#202622'
  g.fillRect(0, 0, W, H)

  const cx = W / 2
  const cy = H * 0.47
  const R = W * 0.34
  g.strokeStyle = faint
  g.lineWidth = 6
  g.beginPath()
  g.arc(cx, cy, R, 0, Math.PI * 2)
  g.stroke()

  g.fillStyle = ink
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `600 ${W * 0.07}px ${mono}`
  g.fillText('IMX-5', cx, H * 0.075)
  g.font = `600 ${W * 0.06}px ${mono}`
  g.fillText('MAIN', cx, H * 0.925) // canvas bottom is the -X (connector) edge

  const L = R * 0.62
  const arrow = (dx: number, dy: number, color: string, label: string) => {
    g.strokeStyle = color
    g.fillStyle = color
    g.lineWidth = W * 0.022
    g.lineCap = 'round'
    g.beginPath()
    g.moveTo(cx, cy)
    g.lineTo(cx + dx * L, cy + dy * L)
    g.stroke()
    const a = Math.atan2(dy, dx)
    const tx = cx + dx * (L + W * 0.03)
    const ty = cy + dy * (L + W * 0.03)
    const s = W * 0.075
    g.beginPath()
    g.moveTo(tx, ty)
    g.lineTo(tx - Math.cos(a - 0.45) * s, ty - Math.sin(a - 0.45) * s)
    g.lineTo(tx - Math.cos(a + 0.45) * s, ty - Math.sin(a + 0.45) * s)
    g.closePath()
    g.fill()
    g.fillStyle = ink
    g.font = `600 ${W * 0.075}px ${mono}`
    g.fillText(label, cx + dx * (L + W * 0.15), cy + dy * (L + W * 0.15))
  }
  arrow(0, -1, AXIS.x, 'X') // canvas up is body +X
  arrow(1, 0, AXIS.y, 'Y')
  // Z points down into the lid: a circled cross
  g.strokeStyle = AXIS.z
  g.lineWidth = W * 0.018
  g.beginPath()
  g.arc(cx, cy, W * 0.05, 0, Math.PI * 2)
  g.stroke()
  const k = W * 0.032
  g.beginPath()
  g.moveTo(cx - k, cy - k)
  g.lineTo(cx + k, cy + k)
  g.moveTo(cx + k, cy - k)
  g.lineTo(cx - k, cy + k)
  g.stroke()

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

function axisArrow(dir: THREE.Vector3, length: number, color: string) {
  const g = new THREE.Group()
  const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false })
  const head = 0.36
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, length - head, 12), mat)
  shaft.position.y = (length - head) / 2
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.12, head, 18), mat)
  cone.position.y = length - head / 2
  g.add(shaft, cone)
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  const tip = new THREE.Object3D()
  tip.position.copy(dir).multiplyScalar(length)
  return { arrow: g, tip }
}

export function buildRug3(): Rug3 {
  const d = DIM
  const group = new THREE.Group()
  const disposables: { dispose(): void }[] = []
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x)

  // anodised aluminium, near black with a green cast to sit in the Sage world
  const metal = keep(new THREE.MeshStandardMaterial({ color: 0x2b312d, metalness: 0.74, roughness: 0.36 }))
  const dark = keep(new THREE.MeshStandardMaterial({ color: 0x121513, metalness: 0.4, roughness: 0.6 }))
  const plastic = keep(new THREE.MeshStandardMaterial({ color: 0x0c0e0d, metalness: 0.1, roughness: 0.5 }))

  // everything hangs off `body`, placed so the IMU centre sits at the origin.
  // three.js: x = body Y, y = -body Z (up), z = -body X
  const body = new THREE.Group()
  body.position.set(-d.imu.y, -(d.imu.zFromBottom - d.height / 2), d.imu.x)
  group.add(body)
  const bottom = -d.height / 2

  // lower tier with the mounting tabs, then the lid block on top
  const base = new THREE.Mesh(keep(new RoundedBoxGeometry(d.width, d.base, d.length, 3, 0.1)), metal)
  base.position.y = bottom + d.base / 2
  body.add(base)
  const lidH = d.height - d.base
  const lidBlock = new THREE.Mesh(keep(new RoundedBoxGeometry(d.width - 0.12, lidH + 0.04, d.length - 0.12, 4, 0.16)), metal)
  lidBlock.position.y = bottom + d.base + lidH / 2 - 0.02
  body.add(lidBlock)

  // tabs: rounded ears along ±Y at mid-length, each with its hole and locating pin hole
  const tabLen = 0.62 * IN * 0.5
  const tabGeo = keep(new RoundedBoxGeometry(d.tabSpan, d.tabT, tabLen, 3, 0.09))
  const tabs = new THREE.Mesh(tabGeo, metal)
  tabs.position.y = bottom + d.tabT / 2
  body.add(tabs)
  const holeGeo = keep(new THREE.CylinderGeometry(d.hole / 2, d.hole / 2, d.tabT + 0.02, 24))
  const pinGeo = keep(new THREE.CylinderGeometry(0.08, 0.08, d.tabT + 0.02, 16))
  for (const s of [-1, 1]) {
    const hole = new THREE.Mesh(holeGeo, dark)
    hole.position.set((s * d.holePitch) / 2, bottom + d.tabT / 2, 0)
    const pin = new THREE.Mesh(pinGeo, dark)
    pin.position.set(s * (d.holePitch / 2 - 0.42), bottom + d.tabT / 2, s * 0.22)
    body.add(hole, pin)
  }

  // the printed lid
  const tex = keep(lidTexture(d.width - 0.4, d.length - 0.4))
  const lid = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(d.width - 0.4, d.length - 0.4)),
    keep(new THREE.MeshStandardMaterial({ map: tex, metalness: 0.3, roughness: 0.62 })),
  )
  lid.rotation.x = -Math.PI / 2 // canvas up lands on -Z, body +X
  lid.position.y = d.height / 2 + 0.023
  body.add(lid)

  // MAIN: a Harwin Gecko 12-way receptacle on the -X face (+X points away from it)
  const conn = new THREE.Group()
  conn.position.set(0, bottom + d.base * 0.62, d.length / 2 + d.connOut / 2)
  const shroud = new THREE.Mesh(keep(new RoundedBoxGeometry(0.98, 0.4, d.connOut, 2, 0.05)), plastic)
  const mouth = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.78, 0.22)), dark)
  mouth.position.z = d.connOut / 2 + 0.002
  conn.add(shroud, mouth)
  const latchGeo = keep(new RoundedBoxGeometry(0.16, 0.3, d.connOut + 0.06, 2, 0.04))
  for (const s of [-1, 1]) {
    const latch = new THREE.Mesh(latchGeo, metal)
    latch.position.x = s * 0.6
    conn.add(latch)
  }
  body.add(conn)
  const connector = new THREE.Object3D()
  connector.position.set(0, 0, d.connOut / 2 + 0.05)
  conn.add(connector)

  // body axes from the IMU centre
  const ax = axisArrow(new THREE.Vector3(0, 0, -1), d.length / 2 + 2.1, AXIS.x)
  const ay = axisArrow(new THREE.Vector3(1, 0, 0), d.tabSpan / 2 + 1.7, AXIS.y)
  const az = axisArrow(new THREE.Vector3(0, -1, 0), d.height / 2 + 1.7, AXIS.z)
  for (const a of [ax, ay, az]) {
    group.add(a.arrow, a.tip)
    a.arrow.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        keep(o.geometry)
        keep(o.material as THREE.Material)
      }
    })
  }
  const origin = new THREE.Mesh(
    keep(new THREE.SphereGeometry(0.07, 16, 12)),
    keep(new THREE.MeshBasicMaterial({ color: 0xeef1ec, toneMapped: false })),
  )
  group.add(origin)

  return {
    group,
    anchors: { x: ax.tip, y: ay.tip, z: az.tip, connector },
    dispose: () => disposables.forEach((x) => x.dispose()),
  }
}

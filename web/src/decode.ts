/*
 * Status words and config fields, decoded per the SDK's data_sets.h
 * (eInsStatusFlags, eHdwStatusFlags, eGenFaultCodes, eSensorConfig,
 * eSystemConfigBits, ePlatformConfig, eMagCalState).
 */

export type Level = 'good' | 'warning' | 'serious' | 'critical' | 'neutral'

export interface Solution {
  code: number
  name: string
  detail: string
  level: Level
}

const SOLUTIONS: Record<number, Omit<Solution, 'code'>> = {
  0: { name: 'Off', detail: 'Filter is not running.', level: 'critical' },
  1: { name: 'Aligning', detail: 'Filter is aligning; hold the unit still.', level: 'warning' },
  3: { name: 'NAV', detail: 'Navigation mode: full INS solution within spec.', level: 'good' },
  4: { name: 'NAV · high variance', detail: 'Navigation mode, attitude uncertainty above threshold.', level: 'warning' },
  5: { name: 'AHRS', detail: 'Attitude and heading are good; no position or velocity.', level: 'good' },
  6: { name: 'AHRS · high variance', detail: 'AHRS mode, attitude uncertainty above threshold.', level: 'warning' },
  7: { name: 'VRS', detail: 'Roll and pitch are good; heading is not earth-referenced.', level: 'warning' },
  8: { name: 'VRS · high variance', detail: 'No earth-referenced heading, and roll/pitch uncertainty is high.', level: 'serious' },
}

export function solution(insStatus: number): Solution {
  const code = (insStatus >>> 16) & 0xf
  return { code, ...(SOLUTIONS[code] ?? { name: `Mode ${code}`, detail: 'Unknown solution state.', level: 'neutral' }) }
}

export interface Flag {
  bit: number
  label: string
  level: Level
}

/** eInsStatusFlags bits that can be set on this unit, with what they mean for the operator. */
export const INS_FLAGS: Flag[] = [
  { bit: 0x00000001, label: 'Heading coarse', level: 'warning' },
  { bit: 0x00000010, label: 'Heading fine', level: 'good' },
  { bit: 0x00000002, label: 'Velocity coarse', level: 'neutral' },
  { bit: 0x00000020, label: 'Velocity fine', level: 'good' },
  { bit: 0x00000004, label: 'Position coarse', level: 'neutral' },
  { bit: 0x00000040, label: 'Position fine', level: 'good' },
  { bit: 0x00000080, label: 'GPS aiding heading', level: 'good' },
  { bit: 0x00000100, label: 'GPS aiding position', level: 'good' },
  { bit: 0x00004000, label: 'GPS aiding velocity', level: 'good' },
  { bit: 0x00000800, label: 'Mag aiding heading', level: 'good' },
  { bit: 0x00001000, label: 'Nav mode', level: 'neutral' },
  { bit: 0x00002000, label: 'Stationary mode', level: 'neutral' },
  { bit: 0x00400000, label: 'Mag recalibrating', level: 'warning' },
  { bit: 0x00800000, label: 'Mag interference / bad cal', level: 'serious' },
  { bit: 0x40000000, label: 'RTOS task overrun', level: 'serious' },
  { bit: 0x80000000, label: 'General fault', level: 'serious' },
]

export const HDW_FLAGS: Flag[] = [
  { bit: 0x00000001, label: 'Gyro motion', level: 'neutral' },
  { bit: 0x00000002, label: 'Accel motion', level: 'neutral' },
  { bit: 0x00000004, label: 'Gyro fault rejected', level: 'serious' },
  { bit: 0x00000008, label: 'Accel fault rejected', level: 'serious' },
  { bit: 0x00000100, label: 'Gyro saturated', level: 'critical' },
  { bit: 0x00000200, label: 'Accel saturated', level: 'critical' },
  { bit: 0x00000400, label: 'Mag saturated', level: 'serious' },
  { bit: 0x00000800, label: 'Baro saturated', level: 'serious' },
  { bit: 0x00001000, label: 'Reset required', level: 'critical' },
  { bit: 0x00004000, label: 'Mag recal complete', level: 'good' },
  { bit: 0x00008000, label: 'Flash write pending', level: 'neutral' },
  { bit: 0x00010000, label: 'Comms TX limited', level: 'warning' },
  { bit: 0x00020000, label: 'Comms RX overrun', level: 'warning' },
  { bit: 0x04000000, label: 'Temperature out of range', level: 'critical' },
  { bit: 0x80000000, label: 'Critical system fault', level: 'critical' },
]

export const setFlags = (word: number, flags: Flag[]) => flags.filter((f) => (word & f.bit) >>> 0 !== 0)

export function bit(hdwStatus: number): { label: string; level: Level } {
  switch ((hdwStatus >>> 24) & 0x3) {
    case 1:
      return { label: 'Running', level: 'neutral' }
    case 2:
      return { label: 'Passed', level: 'good' }
    case 3:
      return { label: 'Failed', level: 'critical' }
    default:
      return { label: 'Not run', level: 'neutral' }
  }
}

export const parseErrors = (hdwStatus: number) => (hdwStatus >>> 20) & 0xf

export function resetCause(hdwStatus: number) {
  return ['—', 'Backup mode', 'Watchdog', 'Software', 'Hardware (NRST)'][(hdwStatus >>> 28) & 0x7] ?? 'Unknown'
}

export const GEN_FAULTS: [number, string][] = [
  [0x00000001, 'INS state overrun (UVW)'],
  [0x00000002, 'INS state overrun (latitude)'],
  [0x00000004, 'INS state overrun (altitude)'],
  [0x00000010, 'Unhandled interrupt'],
  [0x00000020, 'GNSS critical fault'],
  [0x00000040, 'GNSS TX limited'],
  [0x00000080, 'GNSS RX overrun'],
  [0x00000100, 'Sensor init failed'],
  [0x00000200, 'SPI init failed'],
  [0x00000400, 'SPI config failed'],
  [0x00000800, 'GNSS1 init failed'],
  [0x00001000, 'GNSS2 init failed'],
  [0x00002000, 'Flash has invalid values'],
  [0x00004000, 'Flash checksum failure'],
  [0x00008000, 'Flash write failure'],
  [0x00010000, 'System fault (general)'],
  [0x00020000, 'System fault (critical)'],
  [0x00040000, 'Sensor saturation (latched)'],
  [0x00080000, 'EKF states invalid'],
]

export const genFaults = (code: number) => GEN_FAULTS.filter(([b]) => (code & b) >>> 0 !== 0).map(([, s]) => s)

// ---- configuration ----------------------------------------------------------------

export const gyroRange = (sensorConfig: number) => [250, 500, 1000, 2000, 4000][sensorConfig & 0x7] ?? 0
export const accelRange = (sensorConfig: number) => [2, 4, 8, 16][(sensorConfig >>> 4) & 0x3] ?? 0

export const DYNAMIC_MODELS = [
  'Portable',
  'Fixed position',
  'Stationary',
  'Pedestrian',
  'Ground vehicle',
  'Marine',
  'Airborne <1g',
  'Airborne <2g',
  'Airborne <4g',
  'Wrist',
  'Indoor',
]

export const PLATFORMS: Record<number, string> = {
  0: 'IMX-5 module',
  8: 'RUG-3 · G0 (no GNSS)',
  9: 'RUG-3 · G1 (one GNSS)',
  10: 'RUG-3 · G2 (dual GNSS)',
  11: 'EVB-2 · G2',
  16: 'IG-2',
  22: 'RUG-4 · G2',
  23: 'IG-2.1',
}
export const platform = (platformConfig: number) => PLATFORMS[platformConfig & 0x3f] ?? `Type ${platformConfig & 0x3f}`

const RUG3_PRESETS = [
  'Presets off',
  'S0 RS-232 (pins 7/9) · CAN (11/12)',
  'S0 TTL (7/9) · CAN (11/12)',
  'S0 TTL (7/9) · S2 TTL (8/10)',
  'S0 RS-232 (7/9) · S1 RS-232 (8/10)',
  'S1 RS-485 (7/8/9/10)',
  'SPI (7/8/9/10)',
  'S1 RS-232 (8/10)',
  'CAN (11/12)',
  'S2 TTL (8/10)',
]
export const rug3Preset = (platformConfig: number) => RUG3_PRESETS[(platformConfig >>> 8) & 0xff] ?? '—'

export const SYS_CFG: [number, string][] = [
  [0x00000002, 'Continuous mag cal'],
  [0x00000004, 'Auto mag recal'],
  [0x00000800, 'WMM declination'],
  [0x00001000, 'Mag fusion off'],
  [0x00002000, 'Baro fusion off'],
  [0x00004000, 'GPS1 fusion off'],
  [0x00008000, 'GPS2 fusion off'],
  [0x00010000, 'Auto ZUPT off'],
  [0x00020000, 'Auto ZARU off'],
  [0x00040000, 'EKF off'],
  [0x00100000, 'Wheel fusion off'],
]
export const sysCfg = (bits: number) => SYS_CFG.filter(([b]) => (bits & b) >>> 0 !== 0).map(([, s]) => s)

export const MAG_CAL_STATE: Record<number, string> = {
  0: 'Idle',
  1: 'Multi-axis requested',
  2: 'Single-axis requested',
  101: 'Aborted',
  200: 'Recalibrating',
  201: 'Complete',
  202: 'Mode not supported',
}

export const hex = (v: number, digits = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(digits, '0')

# Inertial Sense RUG-3-IMX-5: integration guide

What this unit outputs, how well, in which frames and on which clock, and what you need to fuse it with a moving
camera. This covers **this unit only**: P/N IS-RUG-3.0-G0, firmware 2.7.0, SDK 2.7.1.

## 1. What it is

A rugged aluminium case around an Inertial Sense IMX-5 module: **three redundant IMUs** (gyro + accelerometer,
fused into one output), a 3-axis **magnetometer**, a **barometer**, and an onboard filter that computes attitude.

It has **no GNSS receiver**, so it is an **IMU + AHRS**: it measures rotation and specific force, and estimates
roll, pitch and heading. It does **not** estimate position or velocity. The `lla`, `ned` and `uvw` fields that
appear in its messages are placeholders on this unit; ignore them.

## 2. What it outputs

All on one USB link, streamed at a period you request. Field names are the SDK's (`src/data_sets.h`).

| Message | Contents | Units | Rate on this unit | Use it for |
|---|---|---|---|---|
| `DID_IMU_RAW` | gyro `pqr[3]`, accel `acc[3]`, average of the 3 IMUs | rad/s, m/s² | **1000 Hz** (measured over USB: 1.00 ms spacing) | high-rate rotation (stabilisation, rolling shutter), VIO |
| `DID_PIMU` | delta angle `theta[3]`, delta velocity `vel[3]` over `dt` | rad, m/s | one per filter update (now 71 Hz) | VIO / preintegration: nothing lost between samples |
| `DID_IMU` | gyro and accel, anti-aliased down to the filter rate | rad/s, m/s² | one per filter update (now 71 Hz) | lower-rate logging |
| `DID_INS_2` | attitude quaternion `qn2b` (w, x, y, z) | — | **143 Hz** now, 200 Hz max | ready-made attitude |
| `DID_INS_1` | same attitude as Euler `theta[3]` (roll, pitch, yaw) | rad | same as INS_2 | display, logging |
| `DID_MAGNETOMETER` | field `mag[3]` | normalised: ≈1 when calibrated | 50 Hz | heading (after calibration) |
| `DID_BAROMETER` | pressure, baro altitude, temperature | kPa, m, °C | 50 Hz | altitude trend |
| `DID_INL2_NED_SIGMA` | the filter's 1σ attitude and gyro-bias uncertainty | rad, rad/s | as requested | trust weighting |
| `DID_STROBE_IN_TIME` | IMX timestamp of each pulse on the strobe pin | ms | per pulse | camera sync (§5) |
| `DID_SYS_PARAMS` | `insStatus`, `hdwStatus`, IMU temperature, faults | — | as requested | health |

Rates you can set: the IMU samples at 1 kHz (`startupImuDtMs` = 1). The filter output period is
`startupNavDtMs` (7 ms now; **5 ms = 200 Hz is the minimum without GNSS**), and it updates at twice that period,
which is why `DID_IMU` and `DID_PIMU` arrive at 71 Hz today (100 Hz at 5 ms). For anything faster, use
`DID_IMU_RAW`.

## 3. How good it is

From the IMX-5 datasheet (9/21/2026). Typical values.

| | Gyroscope | Accelerometer |
|---|---|---|
| Range | ±4000 °/s (**set to ±2000** here) | ±16 g |
| Bias instability (in-run) | < 2.0 °/h | < 27 µg |
| Random walk | ARW 0.23 °/√h | VRW 0.020 m/s/√h |
| Noise density | 5 mdps/√Hz | 60 µg/√Hz |
| Bias error over −40…85 °C (RMS) | 0.3 °/s | 3 mg (X, Y), 7 mg (Z) |
| Bandwidth | 539 Hz | 416 Hz |
| Axis alignment error | 0.03° | 0.03° |
| Resolution | 0.0076 °/s | 122 µg |

| Attitude (no GNSS) | |
|---|---|
| Roll, pitch | **0.1° RMS** static: gravity is the reference, so this holds without GNSS |
| Heading, magnetometer | **1.0° RMS** static, **only after magnetometer calibration** in a clean magnetic environment |
| Heading, uncalibrated | not earth-referenced: integrated gyro, drifts (this unit today, see §8) |
| Startup to first output | 0.8 s |

Magnetometer: ±2500 µT, 20 nT/√Hz. Barometer: 30–125 kPa, 0.18 Pa/√Hz, 5 Hz bandwidth.

### Barometer and height

The barometer measures **pressure**, not height. `DID_BAROMETER.mslBar` is **pressure altitude**: the standard
atmosphere with sea-level pressure fixed at 1013.25 hPa. On this unit it read 56.04 m where that formula gives
56.00 m from the same pressure, so it is not your real altitude. The `humidity` field is 0; this unit doesn't measure it.

Measured on this unit, sitting still indoors (50 Hz, 20 s):

| | |
|---|---|
| Raw noise, 1σ | 2 Pa ≈ **16 cm** per sample |
| Smoothed (~0.5 s) | **2–4 cm** |
| Drift | 12 cm in 20 s (room air, temperature) |

What that means in use:

- **Relative height over seconds to minutes: yes**, to a few centimetres once smoothed. Zero it, then watch it
  change (the dashboard's *Barometer · height* card does this).
- **Absolute altitude: only with the local sea-level pressure (QNH)**, and still a few metres. Weather moves
  pressure by about 1 hPa an hour, which is about 8 m.
- It is sensitive to airflow on the case (prop wash, wind) and to temperature (the sensor read 32 °C inside the case).
- Without GNSS the filter runs in AHRS mode and outputs no position, so it doesn't fuse barometric altitude into a
  height estimate for you; do it in your own estimator.

### Noise model for your estimator

The same numbers in the units Kalibr, OpenVINS, VINS-Fusion and similar expect. The bias random walks are **not
published**; measure them with an Allan variance of a 2–3 h static log from this unit: the dashboard's *Noise Lab*
records one with `./imu-bench imx --raw-mult 1` and writes the `imu.yaml` (or use `allan_variance_ros`).

```yaml
# imu.yaml (Kalibr format). Noise densities from the datasheet; random walks are starting guesses, not specs.
update_rate: 1000.0                  # DID_IMU_RAW at 1 kHz
gyroscope_noise_density: 8.7e-5      # rad/s/√Hz     (5 mdps/√Hz; the ARW gives 6.7e-5)
accelerometer_noise_density: 5.9e-4  # m/s²/√Hz      (60 µg/√Hz; the VRW gives 3.3e-4)
gyroscope_random_walk: 1.0e-5        # rad/s²/√Hz    measure it
accelerometer_random_walk: 1.0e-4    # m/s³/√Hz      measure it
```

For reference, the bias instabilities are 9.7e-6 rad/s (gyro) and 2.6e-4 m/s² (accel). Datasheet densities are
measured static; in calibration under real motion they are commonly inflated by a small factor.

## 4. Frames and geometry

**Body frame**, printed on the lid: **+X forward, pointing away from the MAIN connector; +Y right; +Z down**
(right-handed, FRD). Every vector output is in this frame. `insRotation`, `insOffset` and the `sensorConfig`
rotation bits are all zero, so output frame = body frame. Keep it that way and put your camera extrinsics in your
estimator, not in the IMX.

**Navigation frame:** NED. `qn2b` rotates body vectors into NED (v_ned = q ⊗ v_body ⊗ q*); Euler angles are
ZYX (yaw, then pitch, then roll). Verified on this unit: at pitch −20.6°, `acc` = [−3.45, −0.04, −9.17].

**Sign of gravity:** the accelerometer reads **Z ≈ −9.81 m/s² when level and still**: it measures specific force,
the push of the support, in a Z-down frame.

**IMU centre** (from drawing IS-RUG-3.0-G0), relative to the centre of the case's footprint:

| Axis | Offset |
|---|---|
| X | 0.99 mm toward the connector (−X) |
| Y | 3.56 mm toward +Y |
| Z | 6.96 mm above the mounting face |

Use this as the IMU origin for your camera–IMU translation, or let the calibration estimate it.

**ROS (REP-103)** uses FLU body and ENU. From this unit: body vectors (x, −y, −z); attitude
q_enu_flu = q_enu_ned ⊗ qn2b ⊗ q_frd_flu.

## 5. Time and synchronisation

**One clock.** `time` in the IMU messages and `timeOfWeek` in the INS messages are both seconds since the IMX
booted. With no GNSS there is no absolute time and no PPS. The clock is ±0.6 ppm typical, ±2 ppm max:
up to 7.2 ms of drift per hour against your computer, so estimate offset *and* drift.

**Delays inside the sensor:** about 4 ms of signal latency on the IMU (filter group delay: 4.1 ms gyro,
5.3 ms accel, at 1 kHz). Timestamps are set by the IMX (1 µs RMS accuracy), so USB transport delay and its
jitter do not touch them; they only matter when you map IMX time onto host time.

**Three ways to put camera frames and IMU samples on one clock**, best first:

| Method | Wiring | How | Precision |
|---|---|---|---|
| **Strobe out → host GPIO** | MAIN pin 2 → a Jetson GPIO (3.3 V) | Set `ioConfig` G9 = `STROBE_OUTPUT_NAV` (0x20). The IMX pulses the pin at each navigation update, i.e. each `DID_PIMU` sample. Timestamp the edges on the Jetson (GPIO interrupt), pair them with the IMX sample times, and fit IMX time → host time. Camera frames are already on the host clock. | µs-level (GPIO latency) |
| **Camera strobe → strobe in** | camera exposure/flash output → MAIN pin 2 | Set G9 = `STROBE_INPUT` (0x10). Each exposure produces `DID_STROBE_IN_TIME` with the IMX time and a counter. Frames land on the IMX clock. | 1 ms (timestamp field is in ms) |
| **Software** | none | Map IMX time to host receive time (minimum-delay filter plus drift fit), then let the calibration estimate the residual camera–IMU offset (Kalibr's `timeshift_cam_imu`, VIO `td`). | ~1 ms after estimation |

Pin 2 is the only strobe pin on this connector, so it is one method or the other. It is 3.3 V logic behind a
3 kΩ resistor, and **must not be held low at power-up** (that switches the IMX into SPI mode).

## 6. Calibration

| What | Who | Notes |
|---|---|---|
| IMU bias, scale, cross-axis, g-sensitivity, −40…85 °C temperature compensation | **Factory** | Nothing to do. |
| Gyro bias that remains | the filter, continuously | Faster when still. `DID_SYS_CMD` = 5 (zero motion) tells it the unit is still for 2 s. A VIO estimates its own biases anyway. |
| Magnetometer hard and soft iron | **you**, in the final mounting | Only needed for heading. Multi-axis: `DID_MAG_CAL.state` = 1, then rotate through all orientations until done (dashboard *Calibrate*, or `cltool -magRecal1`). The dashboard's ellipsoid fit checks the result. |
| Magnetic declination | **you** | `magDeclination` (rad) is 0 now, so heading is magnetic. |
| Camera–IMU extrinsics and time offset | **you** | Kalibr (camera–IMU) with the §3 noise model, after the Allan variance. The dashboard's *Camera* panel gives a starting rotation and time shift by matching the IMU's horizon to the image. |
| Mounting misalignment | optional | Prefer the calibrated extrinsic over `insRotation`. |

## 7. Interfaces

| | |
|---|---|
| Link | **USB** (CDC-ACM, `/dev/ttyACM*`, no driver needed on Linux). Recommended: full rate, no level shifting. |
| Serial | Ser0 on pins 7/9 is **RS-232**, max **500 kbps** (it is set to 921600 now; drop to 460800 if you use it). For 3.3 V TTL to a Jetson header, switch the RUG-3 preset to 2. Never put RS-232 levels on a Jetson pin. |
| Protocol | ISB binary (what the SDK and this repo use); NMEA also available |
| Power | 4.5–20 V on pin 3 |
| Connector | 12-pin Harwin Gecko, G125-MV11205L1P; mating cable G125-FC11205L0-0150L |
| Case | 30.5 × 25.4 × 9.9 mm, 14 g, IP40 (no liquid protection), −40 to 85 °C, 2× Ø3.18 mm holes on 30.84 mm centres |

| Pin | Signal | Pin | Signal |
|---|---|---|---|
| 1 | GND | 2 | G9: strobe in/out (§5) |
| 3 | VIN 4.5–20 V | 4 | USB D+ |
| 5 | n/c on this unit | 6 | USB D− |
| 7 | Ser0 TX (RS-232) | 8 | unused |
| 9 | Ser0 RX (RS-232) | 10 | unused |
| 11, 12 | CAN (disabled in the current config) | | |

Viewed on the case (not the cable), the top row reads 11 9 7 5 3 1 and the bottom row 12 10 8 6 4 2.

## 8. This unit, today

- **Heading is not north-referenced.** The filter reports VRS (roll and pitch good, yaw relative) because the
  magnetometer has never been calibrated. Calibrate it in place (§6) if you need heading.
- **A latched sensor-saturation fault** from some past knock sets the general-fault flag. Nothing is saturated
  now; clear it with the dashboard's *Clear* (writes 0 to `genFaultCode`).
- **cltool's `-magRecal` numbers are off by one** in its help text: `-magRecal1` is multi-axis, `-magRecal2`
  single-axis.
- **The SDK's ROS 2 driver does not compile against SDK 2.7.1.** Build your own node on the SDK, or start from
  this repo's bridge.
- **End of life:** IMX-5 support ends 31 Dec 2027. The IMX-6 (RUG-4-IMX-6) is the pin-compatible successor.

## Sources

- IMX-5 datasheet: <https://docs.inertialsense.com/datasheets/IMX-5_IMU_AHRS_GNSS-INS_Datasheet.pdf>
- RUG-3-IMX-5 drawing and pinout: <https://docs.inertialsense.com/dimensions/IS-RUG-3.0-G0_Dimensions_and_Pinout_RUG-3-IMX-5.pdf>
- IMX-5 end-of-life notice: <http://docs.inertialsense.com/datasheets/IMX-5_EOL_Notice_v3_1.pdf>
- User manual (time sync, magnetometer, IMU/INS configuration): <https://docs.inertialsense.com/>
- SDK 2.7.1 headers, `sdk/src/data_sets.h` (message layouts, status bits, config fields)
- Measured on this unit (rates, frames, signs, units) with the bridge in this repo

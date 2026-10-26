<div align="center">

# imu-bench

**Plug in any IMU and see it think.** One small server turns an Inertial Sense IMX, a PX4 or ArduPilot flight
controller, an Arduino with an MPU-6050, or any ROS 2 IMU topic into the same live 3D dashboard, a replayable
recording, or standard ROS 2 topics.

[![CI](https://github.com/Kronbii/imu-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/Kronbii/imu-bench/actions/workflows/ci.yml)
[![Live demo](https://img.shields.io/badge/live_demo-open-b7d3a8?labelColor=0b0d0c)](https://kronbii.github.io/imu-bench/)
![Python 3.8+](https://img.shields.io/badge/python-3.8%2B-b7d3a8?labelColor=0b0d0c)
![License: MIT](https://img.shields.io/badge/license-MIT-b7d3a8?labelColor=0b0d0c)

<img src="docs/media/hero.webp" alt="The imu-bench dashboard: an Inertial Sense RUG-3 turning in 3D over a contour-line terrain with axis callouts, live roll, pitch and yaw readouts, an attitude indicator and a heading card." width="100%">

<sub>The dashboard, recorded frame by frame from its built-in simulator. <a href="https://kronbii.github.io/imu-bench/">Open the live demo</a>: it runs in your browser, no hardware or install.</sub>

</div>

## What you get

<table>
<tr>
<td width="50%" valign="top">

**The sensor, in 3D.** The device turns in real time by its own attitude quaternion, modelled as what it is: a
RUG-3 enclosure drawn from its datasheet, a quadrotor for flight controllers, a breakout board for everything else.
Leader-line callouts carry live body rates; a chase camera keeps every axis in view.

</td>
<td width="50%"><img src="docs/media/quad.webp" alt="A quadrotor model tilting and turning on the 3D plate, with nose, right and down axes and a motor callout."></td>
</tr>
<tr>
<td width="50%"><img src="docs/media/signals.webp" alt="Four live strip charts: tilt, angular rate, specific force and magnetic field, each with X, Y and Z traces."></td>
<td width="50%" valign="top">

**The raw signals.** Tilt, angular rate, specific force and magnetic field as live strip charts, with a crosshair
that reads every axis at one instant, 5 to 60 s windows, pause, and CSV export of what's on screen.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Unplug it, plug it back.** The bench follows a USB sensor across replugs, whatever `/dev/ttyACM*` it comes back
as, detects the unplug within a quarter of a second, and picks the stream back up on its own.

</td>
<td width="50%"><img src="docs/media/unplug.webp" alt="The 3D plate going dim under a 'Plug in the sensor' notice when the sensor disconnects, then coming back to life."></td>
</tr>
<tr>
<td width="50%"><img src="docs/media/board.webp" alt="A generic IMU breakout board with a pin header turning on the 3D plate."></td>
<td width="50%" valign="top">

**Any sensor that can print a line.** JSON or CSV over serial, UDP, TCP or stdin, in any units and axis order.
A sensor that only reports gyro and accelerometer gets its attitude from a built-in Madgwick filter.

</td>
</tr>
</table>

Also: barometric height (zero it, enter your QNH, watch the noise live), health decoded from each device's status
words, magnetometer coverage plots for checking a calibration, the device's identity, configuration and
capabilities, record and replay, and a ROS 2 publisher.

<table>
<tr>
<td width="33%"><img src="docs/media/health.webp" alt="Health: solution state, heading source, magnetometer calibration, built-in test, latched faults, filter bias estimates, environment and measured stream rates."></td>
<td width="33%"><img src="docs/media/calibrate.webp" alt="Calibrate: magnetometer samples projected on three planes against a reference circle, with field statistics and a recalibration procedure."></td>
<td width="33%"><img src="docs/media/device.webp" alt="Device: identity, flash configuration decoded, capabilities, an event log, and datasheet numbers."></td>
</tr>
<tr>
<td align="center"><sub>Health, decoded</sub></td>
<td align="center"><sub>Magnetometer coverage</sub></td>
<td align="center"><sub>The device</sub></td>
</tr>
</table>

## Supported sensors

| Driver | Devices | Link | Attitude from | Tested with |
|---|---|---|---|---|
| `imx` | Inertial Sense IMX-5 / IMX-6: RUG-3, RUG-4, bare modules | USB, serial (vendor SDK) | the device's EKF | RUG-3-IMX-5, firmware 2.7.0, on hardware |
| `mavlink` | PX4, ArduPilot, and other MAVLink autopilots | UDP, TCP, serial | the autopilot's estimator | PX4 1.18 SITL (SIH quadrotor) |
| `lines` | Arduino / ESP32 with MPU-6050, BNO055, ICM-20948, ...; phone apps; scripts | serial, UDP, TCP, stdin | the sensor, or fused here | synthetic CSV and JSON streams |
| `ros2` | any `sensor_msgs/Imu` topic | ROS 2 | the message, or fused here | ROS 2 Jazzy, round trip |
| `sim` | synthetic motion: IMX, AHRS or raw-IMU flavours | — | the simulator, or fused here | — |
| `replay` | any recording | file | as recorded | — |

Adding a sensor means writing one driver that emits [a handful of plain JSON messages](docs/protocol.md).

## Quick start

```bash
git clone --recursive https://github.com/Kronbii/imu-bench.git && cd imu-bench
./scripts/setup.sh                 # vendor SDK, C++ bridge, dashboard (Node 20+ for the dashboard build)

./imu-bench sim                    # no hardware: open http://127.0.0.1:8765
./imu-bench imx                    # an Inertial Sense unit on USB, found automatically
./imu-bench mavlink                # PX4 / ArduPilot on UDP 14550 (pip install pymavlink)
./imu-bench lines /dev/ttyUSB0@115200 --gyro-unit dps --acc-unit g --name MPU-6050
./imu-bench ros2 --topic /imu/data # after sourcing ROS 2
```

Every driver takes the same extras: `--record run.ndjson`, `--fusion on|off|auto`, `--ros2-publish`, `--host 0.0.0.0`,
`--no-web`. `./imu-bench <driver> -h` lists the rest. Only the dashboard build needs Node; the server is Python 3.8+
with no dependencies (pymavlink for MAVLink, a sourced ROS 2 for ROS 2).

## How it fits together

```mermaid
flowchart LR
  A["Inertial Sense IMX<br/>USB, vendor SDK"] -->|imx_bridge, C++| D
  B["PX4 / ArduPilot<br/>MAVLink"] --> D
  C["Arduino, ESP32, scripts<br/>JSON / CSV lines"] --> D
  R["ROS 2<br/>sensor_msgs/Imu"] --> D
  D["driver<br/>to bench messages<br/>FRD, NED, SI"] --> F{"attitude<br/>reported?"}
  F -- no --> M["Madgwick fusion"] --> H
  F -- yes --> H["hub"]
  H --> W["dashboard<br/>Server-Sent Events"]
  H --> Q["recording<br/>NDJSON"]
  H --> P["ROS 2 topics<br/>Imu, MagneticField, FluidPressure"]
```

Every source becomes the same messages: `device`, `att`, `imu`, `mag`, `baro`, `status`, `link`, in SI units with
an FRD body and a NED world (the conventions of aerospace and PX4). The Inertial Sense driver runs the vendor
SDK in a small C++ bridge and keeps the device's own data alongside, so its panels can decode every status bit.
[docs/protocol.md](docs/protocol.md) has the full format.

## Fusion

Sensors that report only gyro and accelerometer get attitude from a 6-axis Madgwick filter, plus a slow
tilt-compensated heading loop when a magnetometer is present. The heading loop is kept apart from tilt, so a
badly calibrated magnetometer can only ever disturb yaw.

On synthetic hand-held motion with a 0.17 °/s gyro bias and sensor noise (the test suite), the filter holds tilt to
**0.06° mean, 0.22° worst**, and heading to **0.5°** with a magnetometer. Without one, heading is relative and
drifts, and the dashboard says so.

## ROS 2

```bash
./imu-bench imx --ros2-publish        # /imu/data, /imu/mag, /imu/pressure, frame imu_link
./imu-bench ros2 --topic /camera/imu  # and the other way: any Imu topic into the dashboard
```

ROS uses FLU/ENU (REP-103); the bench converts at that boundary and nowhere else. Publishing and then subscribing
to the same topic returns the original attitude to within 0.001°.

## Inertial Sense IMX-5

The project started on a RUG-3-IMX-5, and that support goes deepest:

- The vendor **SDK 2.7.1** is a submodule in `sdk/`, with `tools/cltool` (command line) and `tools/evaltool`
  (the vendor GUI, fetched on first run) ready to use.
- The `imx` driver finds the unit on USB itself, survives replugs, refuses ports that don't speak the vendor's ISB
  protocol (Betaflight boards share the USB IDs), and can stream the raw IMU at 1 kHz (`--raw-mult 1`).
- The dashboard decodes every bit of the unit's status words, its flash configuration and its EKF's bias
  estimates, and can start a magnetometer recalibration.
- [docs/inertial-sense-imx5.md](docs/inertial-sense-imx5.md) is an integration guide: outputs and rates, accuracy, a
  noise model for camera–IMU calibration, frames and the IMU's position in the case, timing and camera sync, pinout.

## On an NVIDIA Jetson

Everything runs on a Jetson. `./scripts/setup.sh --udev` builds the SDK and bridge with the distro `cmake` and
adds a `/dev/imx5` link. Build the dashboard on any machine and copy `web/dist/` across if the Jetson has no Node.
`--host 0.0.0.0` lets a laptop watch a headless Jetson; `--ros2-publish` hands the stream to the rest of the robot.

## Project layout

```
imubench/   the server: drivers, protocol, fusion, hub, HTTP, ROS 2       imu-bench   launcher, no install needed
bridge/     C++ bridge on the Inertial Sense SDK                          sdk/        Inertial Sense SDK 2.7.1 (submodule)
web/        the dashboard (React, three.js), and the in-browser demo      tools/      cltool and EvalTool launchers
docs/       protocol, IMX-5 guide, media                                   examples/   Arduino MPU-6050 sketch, UDP sender
tests/      protocol, fusion, parsing, IMX and MAVLink decoding           scripts/    setup, udev rule
```

## Development

```bash
python3 -m unittest discover -s tests   # 19 tests: maths, fusion accuracy, parsers, IMX and MAVLink decoding
cd web && npm run dev                   # dashboard with hot reload on :5173, against a running ./imu-bench
```

CI runs the tests on Python 3.8 and 3.12, builds the dashboard, and compiles the SDK and bridge. Every push to
`main` redeploys the [live demo](https://kronbii.github.io/imu-bench/).

The dashboard's look follows [ramikronbi.com](https://ramikronbi.com). MIT licensed; the Inertial Sense SDK is MIT
under its own copyright.

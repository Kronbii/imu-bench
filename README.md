# IMX-5 bench

A test bench for the Inertial Sense **RUG-3-IMX-5** (P/N IS-RUG-3.0-G0): the vendor SDK and tools, a small bridge
that streams the sensor as JSON lines, and a live dashboard. Built on a laptop, meant to move to an NVIDIA Jetson.

**Start here:** [docs/datasheet.md](docs/datasheet.md), the integration guide (outputs, accuracy, frames, timing
and camera sync, calibration, pinout).

```
IMX-5 ──USB──▶ bridge/imx_bridge ──JSON lines──▶ server/serve.py ──SSE──▶ browser (web/)
       ISB      SDK ISComm parser                 stdlib Python            React + three.js
```

## Get it

```bash
git clone --recursive https://github.com/Kronbii/inertial-sense-IMX-RUG5-simulator.git
cd inertial-sense-IMX-RUG5-simulator
./scripts/setup.sh            # SDK, cltool, bridge, dashboard  (add --udev for the udev rule, asks for sudo)
```

Already cloned without `--recursive`? `git submodule update --init --recursive`.

## Vendor tools

The Inertial Sense SDK **2.7.1** (matching the unit's firmware 2.7.0) is a submodule in [`sdk/`](sdk). Its two
tools run from this repo:

| | |
|---|---|
| `tools/cltool` | Command-line tool: stream, get/set config, log, firmware update. Built from `sdk/` on first use. |
| `tools/evaltool` | EvalTool, the vendor GUI. Downloaded from the 2.7.1 release on first use (157 MB AppImage, checksum-verified, kept out of git). Linux x86-64 only. |

```bash
tools/cltool -c /dev/ttyACM0 -get DID_DEV_INFO,DID_FLASH_CONFIG   # read identity and config
tools/cltool -c /dev/ttyACM0 -did 97 3                            # stream raw IMU (97) and PIMU (3)
tools/cltool -c /dev/ttyACM0 -magRecal1                           # multi-axis mag calibration (1, not 0)
tools/evaltool
```

Only one program can own the serial port: stop the dashboard server before using either tool.

## Dashboard

```bash
python3 server/serve.py           # http://127.0.0.1:8765
```

It finds the sensor by itself and follows it across unplug and replug, whatever `/dev/ttyACM*` it comes back as.
While nothing is connected the page says so, and it picks the stream back up when the unit returns.

| Option | |
|---|---|
| `--port /dev/ttyTHS1` | A fixed port, e.g. a Jetson UART. `--port '/dev/ttyACM*'` searches a glob. Default `auto`. |
| `--host 0.0.0.0` | Viewable from another machine. Anyone on that network can then send the commands below. |
| `--record runs/desk.ndjson` / `--replay runs/desk.ndjson` | Record the live stream / play it back, looping |
| `--sim` | Synthetic, self-consistent motion; no sensor needed |

In the page: the RUG-3 in 3D (modelled from its drawing, turned about the IMU centre), horizon and heading
instruments, live charts with hover readout and CSV export, every status bit decoded, magnetometer coverage plots
with the recalibration procedure, and the unit's identity, configuration and datasheet numbers.
`cd web && npm run dev` serves it with hot reload on :5173.

## Bridge

[`bridge/imx_bridge.cpp`](bridge/imx_bridge.cpp) is a small C++ program on the SDK's `ISComm` layer. It prints one
JSON object per data set, using the SDK's field names, and is usable on its own:

```bash
bridge/build/imx_bridge | your-program                 # INS 143 Hz, IMU 71 Hz, mag + baro 50 Hz, status
bridge/build/imx_bridge --raw-mult 1 | your-program    # plus DID_IMU_RAW at 1 kHz ("imuraw")
```

It finds the port the same way as the server, detects unplugging within ~250 ms, and checks that a port speaks
ISB before trusting it: Betaflight and other STM32 boards share the same USB IDs. It never writes flash or saves
persistent streams. Commands on stdin: `magrecal multi|single|abort`, `zeromotion`, `clearfault`, `reset`, `info`.

## On a Jetson

- `./scripts/setup.sh --udev` builds everything (distro `cmake` ≥ 3.16) and adds `/dev/imx5`. Edit
  `scripts/99-imx5.rules` for another unit: it matches this one's USB serial.
- No Node on the Jetson? Build `web/` elsewhere and copy `web/dist/`; the server only serves files. The server is
  Python 3.8+, standard library only.
- EvalTool has no ARM build; `tools/cltool` builds fine.
- Use USB. Serial port 0 is RS-232 at 921600 baud, above its 500 kbps limit (see the guide, §7).

## Layout

```
bridge/    C++ bridge on the SDK            server/   dashboard server, simulator
web/       dashboard (React, three.js)      docs/     integration guide
sdk/       Inertial Sense SDK 2.7.1         tools/    cltool and EvalTool launchers
scripts/   setup, udev rule
```

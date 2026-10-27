# The imuctl stream

Every driver turns its device's protocol into the same small set of messages. The hub, the recorder, the ROS 2
publisher and the dashboard only ever see these, so a new sensor needs a driver and nothing else.

One message is one JSON object with a type `t`. On the wire to the browser they travel as Server-Sent Events, each
event a JSON array of messages (`GET /stream`); in a recording (`--record`) they are one per line (NDJSON).

## Conventions

| | |
|---|---|
| Units | SI: rad, rad/s, m/s², kPa, m, °C. Magnetometer in the unit it names. |
| Body frame | **FRD**: x forward, y right, z down |
| World frame | **NED**: north, east, down |
| Attitude | quaternion `[w, x, y, z]` rotating body vectors into NED; Euler angles ZYX (roll, pitch, yaw) |
| Time | `time` in seconds on the **sensor's** clock. Streams from one device share it; different devices don't. |
| Gravity | a still, level sensor reads `acc ≈ [0, 0, −9.81]`: specific force, the push of the support |

These are the conventions of aerospace, PX4 and the Inertial Sense SDK. ROS (REP-103) uses FLU/ENU; the ROS 2
driver and publisher convert at that boundary and nowhere else.

## Messages

| `t` | Fields | Notes |
|---|---|---|
| `device` | `vendor`, `name`, `model`, `form`, `caps[]`, `driver`, optional `serial`, `firmware`, `hardware`, `fusion` | `name` is short (IMX-5, PX4). `form` picks the 3D model: `rug3`, `board`, `quad`. `caps` lists what the device provides and accepts (below). Sent on connect and whenever it changes. |
| `link` | `up`, `port`, optional `dev`, `why` | `why` when down: `searching`, `unplugged`, `no data`, `not answering`, `no heartbeat`, ... |
| `src` | `mode` (`device`, `sim`, `replay`, `demo`), `driver`, `detail` | Where the stream comes from. |
| `att` | `time`, `q[4]`, `euler[3]`, `source` (`sensor`, `fusion`), optional `sigma[3]` | `sigma`: 1σ roll, pitch, yaw in rad, when the device estimates it. |
| `imu` | `time`, `gyro[3]` rad/s, `acc[3]` m/s² | Body frame. |
| `mag` | `time`, `mag[3]`, `unit` (`norm`, `uT`, `gauss`), optional `cal` | `norm` is ≈ 1 for the local field once calibrated. `cal: true` when imuctl applied a hard/soft-iron correction. |
| `baro` | `time`, `pressure` kPa, optional `alt` m, `temp` °C | |
| `status` | `mode`, `level`, optional `detail`, `temp`, `flags[]`, `x{}` | `level`: `good`, `warning`, `serious`, `critical`, `neutral`. `flags`: `{label, level}`. `x`: device-specific raw words. |
| `log` | `msg` | Shown in the dashboard's event list. |
| `magcal` | `applied`, optional `center[3]`, `matrix[9]` | The hard/soft-iron correction in force: `m_cal = W (m − c)`, `W` row-major. Sent when it changes. |
| `imx.*` | SDK field names | Inertial Sense extras for the IMX panels: `imx.dev`, `imx.cfg`, `imx.sys`, `imx.sigma`, `imx.inl2`, `imx.magobs`, `imx.magcal`. |

### Capabilities

`attitude`, `imu`, `mag`, `baro`, `status`, `sigma` say what the device streams. `cmd:<name>` says which dashboard
commands it accepts (`cmd:magrecal`, `cmd:zeromotion`, `cmd:clearfault`, `cmd:reset`). `panel:imx` turns on the
Inertial Sense panels. When fusion runs, `attitude` is added and `fusion` names the filter.

## Example

```json
{"t":"device","vendor":"Inertial Sense","name":"IMX-5","model":"RUG-3-IMX-5","form":"rug3","caps":["attitude","imu","mag","baro","status"],"driver":"imx","serial":"520920","firmware":"2.7.0"}
{"t":"link","up":true,"port":"/dev/serial/by-id/usb-STMicroelectronics_STM32_Virtual_ComPort_20883973534B-if00","dev":"/dev/ttyACM0"}
{"t":"att","time":956.1069,"q":[0.7759,-0.1089,-0.1425,-0.6048],"euler":[0.0036,-0.3605,-1.3248],"source":"sensor"}
{"t":"imu","time":956.1139,"gyro":[0.00017,0.00033,-0.00206],"acc":[-3.455,-0.035,-9.175]}
{"t":"mag","time":956.1169,"mag":[-0.604,-0.564,1.237],"unit":"norm"}
{"t":"status","mode":"VRS","level":"warning","detail":"Roll and pitch good; heading not north-referenced."}
```

## HTTP

| | |
|---|---|
| `GET /stream` | Server-Sent Events; each event is a JSON array of messages. A late joiner first gets the latest `src`, `link`, `device`, `status`, `magcal` and `imx.*`. |
| `POST /api/cmd` | `{"cmd": "magrecal multi"}`. Only commands the running driver lists are accepted. |
| `POST /api/magcal` | `{"center": [3], "matrix": [9]}`: correct the magnetometer from now on, before fusion, recording and ROS 2. Saved to the `--magcal` file when one is given. |
| `DELETE /api/magcal` | Remove the correction. |
| `GET /api/info` | `{"driver": ..., "commands": [...]}` |

## Writing a driver

A driver is a class in `src/imuctl/drivers/` with a `name`, a `help` line, `add_args(parser)` for its options and a
`run()` loop that calls `self.emit(message)`; `self.link(up, port, why)` reports the connection. Set
`provides_attitude = False` if the device never reports attitude, and fusion will supply it. Register it in
`src/imuctl/drivers/__init__.py`. `drivers/lines.py` is the smallest complete example.

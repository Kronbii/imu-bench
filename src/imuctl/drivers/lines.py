"""
Any sensor that can print a line: an Arduino with an MPU-6050, an ESP32 with
a BNO055, a phone app, a script. JSON or CSV, over serial, UDP, TCP or stdin.

JSON lines may be imuctl messages ({"t": "imu", ...}) or shorthand:

  {"gyro": [gx, gy, gz], "acc": [ax, ay, az], "mag": [mx, my, mz], "time": 12.345}
  {"q": [w, x, y, z]}         {"euler": [roll, pitch, yaw]}

CSV lines are numbers in the order of --fields, or of a header line
(e.g. "time,gx,gy,gz,ax,ay,az"). Units and axes are fixed with --gyro-unit,
--acc-unit, --mag-unit, --euler-unit and --axes; without a timestamp the host
clock is used.
"""

import json
import math
import re
import time

from .. import transports
from ..protocol import axis_map, euler_to_quat, q_enu_flu_to_ned_frd, quat_to_euler
from .base import Driver

GYRO = {"rad": 1.0, "dps": math.pi / 180, "mrad": 1e-3}
ACC = {"ms2": 1.0, "g": 9.80665, "mg": 9.80665e-3}
EULER = {"rad": 1.0, "deg": math.pi / 180}
FIELDS = ("time", "gx", "gy", "gz", "ax", "ay", "az", "mx", "my", "mz", "qw", "qx", "qy", "qz", "roll", "pitch", "yaw")
AUTO_FIELDS = {
    6: "gx,gy,gz,ax,ay,az",
    7: "time,gx,gy,gz,ax,ay,az",
    9: "gx,gy,gz,ax,ay,az,mx,my,mz",
    10: "time,gx,gy,gz,ax,ay,az,mx,my,mz",
}
ALIASES = {"gyr": "gyro", "g": "gyro", "gyroscope": "gyro", "a": "acc", "accel": "acc", "accelerometer": "acc",
           "m": "mag", "magnetometer": "mag", "quat": "q", "quaternion": "q", "rpy": "euler",
           "ts": "time", "t_s": "time", "timestamp": "time"}
NUMBER = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$")


class LineParser:
    def __init__(self, args):
        self.gyro_k = GYRO[args.gyro_unit]
        self.acc_k = ACC[args.acc_unit]
        self.euler_k = EULER[args.euler_unit]
        self.mag_unit = args.mag_unit
        self.time_k = args.time_scale
        self.axes = axis_map(args.axes)
        self.ros = args.frame == "flu"
        self.fields = None if args.fields == "auto" else args.fields.split(",")
        self.t0 = time.monotonic()

    def vec(self, v, k=1.0):
        v = [float(x) * k for x in v]
        if self.ros:
            v = [v[0], -v[1], -v[2]]
        return self.axes(v)

    def parse(self, line):
        """One line in, a list of imuctl messages out (possibly empty)."""
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except ValueError:
                return []
            return self.from_json(obj) if isinstance(obj, dict) else []
        cells = [c for c in re.split(r"[,\s;]+", line) if c]
        if not all(NUMBER.match(c) for c in cells):
            names = [c.lower() for c in cells]
            if all(n in FIELDS for n in names):  # a CSV header names the columns
                self.fields = names
            return []
        fields = self.fields or AUTO_FIELDS.get(len(cells), "").split(",")
        if len(fields) != len(cells):
            return []
        row = dict(zip(fields, (float(c) for c in cells)))
        obj = {}
        if "time" in row:
            obj["time"] = row["time"]
        if all(k in row for k in ("gx", "gy", "gz", "ax", "ay", "az")):
            obj["gyro"] = [row["gx"], row["gy"], row["gz"]]
            obj["acc"] = [row["ax"], row["ay"], row["az"]]
        if all(k in row for k in ("mx", "my", "mz")):
            obj["mag"] = [row["mx"], row["my"], row["mz"]]
        if all(k in row for k in ("qw", "qx", "qy", "qz")):
            obj["q"] = [row["qw"], row["qx"], row["qy"], row["qz"]]
        if all(k in row for k in ("roll", "pitch", "yaw")):
            obj["euler"] = [row["roll"], row["pitch"], row["yaw"]]
        return self.from_json(obj)

    def from_json(self, obj):
        if obj.get("t") in ("imu", "att", "mag", "baro", "status", "device", "log"):
            msg = dict(obj)  # already a imuctl message: SI, FRD/NED
            if msg["t"] in ("imu", "att", "mag", "baro") and "time" not in msg:
                msg["time"] = time.monotonic() - self.t0
            return [msg]
        obj = {ALIASES.get(k.lower(), k.lower()): v for k, v in obj.items()}
        t = float(obj["time"]) * self.time_k if "time" in obj else time.monotonic() - self.t0
        out = []
        if "gyro" in obj and "acc" in obj:
            out.append({"t": "imu", "time": t, "gyro": self.vec(obj["gyro"], self.gyro_k), "acc": self.vec(obj["acc"], self.acc_k)})
        if "mag" in obj:
            out.append({"t": "mag", "time": t, "mag": self.vec(obj["mag"]), "unit": self.mag_unit})
        if "q" in obj:
            q = [float(x) for x in obj["q"]]
            if self.ros:
                q = q_enu_flu_to_ned_frd(q)
            out.append({"t": "att", "time": t, "q": q, "euler": quat_to_euler(q), "source": "sensor"})
        elif "euler" in obj:
            e = [float(x) * self.euler_k for x in obj["euler"]]
            out.append({"t": "att", "time": t, "q": euler_to_quat(*e), "euler": e, "source": "sensor"})
        if "pressure" in obj:
            out.append({"t": "baro", "time": t, "pressure": float(obj["pressure"])})
        return out


class LinesDriver(Driver):
    name = "lines"
    help = "any sensor that prints JSON or CSV lines (serial, UDP, TCP, stdin)"
    provides_attitude = False  # unless the lines carry q/euler; fusion fills in otherwise

    @classmethod
    def add_args(cls, p):
        p.add_argument("url", nargs="?", default="stdin",
                       help="stdin | /dev/ttyUSB0[@115200] | serial:PATH[@BAUD] | udp:PORT | tcp:HOST:PORT")
        p.add_argument("--fields", default="auto", help="CSV column order, e.g. time,gx,gy,gz,ax,ay,az (auto: by count or header)")
        p.add_argument("--gyro-unit", choices=sorted(GYRO), default="rad")
        p.add_argument("--acc-unit", choices=sorted(ACC), default="ms2")
        p.add_argument("--mag-unit", choices=["norm", "uT", "gauss"], default="uT")
        p.add_argument("--euler-unit", choices=sorted(EULER), default="rad")
        p.add_argument("--time-scale", type=float, default=1.0, help="multiply incoming time by this to get seconds (1e-3 for ms)")
        p.add_argument("--axes", default="x,y,z", help="sensor axes as FRD body axes, e.g. x,-y,-z")
        p.add_argument("--frame", choices=["frd", "flu"], default="frd",
                       help="flu: vectors are FLU and orientation ENU (ROS REP-103); converted to FRD/NED")
        p.add_argument("--name", default="IMU", help="short name shown on the dashboard, e.g. MPU-6050")
        p.add_argument("--vendor", default="", help="e.g. InvenSense")
        p.add_argument("--form", choices=["board", "quad", "rug3"], default="board", help="3D model to show")

    def run(self):
        a = self.args
        parser = LineParser(a)
        self.emit({"t": "src", "mode": "device", "driver": self.name, "detail": a.url})
        self.emit({"t": "device", "vendor": a.vendor or "Line source", "name": a.name, "model": a.name, "form": a.form,
                   "driver": "lines", "caps": ["imu", "mag"]})
        def on_state(up, why):
            if not up:
                self.link(False, a.url, why)

        last = None
        for line in transports.lines(a.url, self.stopped, on_state):
            if line is None:  # idle tick: two quiet seconds means the sensor has gone
                if last is not None and time.monotonic() - last > 2.0:
                    self.link(False, a.url, "no data")
                    last = None
                continue
            msgs = parser.parse(line)
            if msgs:
                self.link(True, a.url)
                last = time.monotonic()
            for m in msgs:
                self.emit(m)

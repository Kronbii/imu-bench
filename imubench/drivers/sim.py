"""
Synthetic sensors, for working without hardware. The motion is a slow
hand-held wobble; gyro, accelerometer and magnetometer are derived from it
consistently, so every readout in the dashboard agrees with the others.

  --emulate imx    an IMX-5 in a RUG-3, with the IMX panels populated (default)
  --emulate ahrs   a generic sensor that reports its own attitude
  --emulate raw    gyro, accelerometer and magnetometer only: fusion supplies attitude
"""

import math
import random
import time

from ..protocol import euler_to_quat, qconj, rotate
from .base import Driver

G = 9.80665
D2R = math.pi / 180
MAG_INC = 48 * D2R  # a mid-latitude field
FIELD = [math.cos(MAG_INC), 0.0, math.sin(MAG_INC)]


def attitude(t):
    r = (16 * math.sin(0.31 * t) + 5 * math.sin(1.27 * t + 0.4)) * D2R
    p = (11 * math.sin(0.23 * t + 1.0) + 3.5 * math.sin(0.93 * t)) * D2R
    y = (35 * math.sin(0.06 * t) + 22 * math.sin(0.17 * t + 2.0)) * D2R
    return r, p, y


def body_rates(t):
    r, p, y = attitude(t)
    r2, p2, y2 = attitude(t + 1e-4)
    dr, dp, dy = (r2 - r) / 1e-4, (p2 - p) / 1e-4, (y2 - y) / 1e-4
    return [
        dr - dy * math.sin(p),
        dp * math.cos(r) + dy * math.sin(r) * math.cos(p),
        -dp * math.sin(r) + dy * math.cos(r) * math.cos(p),
    ]


PROFILES = {
    "imx": {"vendor": "Inertial Sense", "name": "IMX-5", "model": "RUG-3-IMX-5", "form": "rug3",
            "caps": ["attitude", "imu", "mag", "baro", "status", "sigma", "panel:imx", "cmd:magrecal", "cmd:zeromotion", "cmd:clearfault", "cmd:reset"]},
    "ahrs": {"vendor": "Simulated", "name": "AHRS", "model": "Generic AHRS", "form": "board",
             "caps": ["attitude", "imu", "mag", "baro", "status"]},
    "raw": {"vendor": "Simulated", "name": "IMU", "model": "6+3-axis IMU", "form": "board",
            "caps": ["imu", "mag"]},
}


class SimDriver(Driver):
    name = "sim"
    help = "synthetic motion, no hardware"
    commands = ("magrecal multi", "magrecal single", "magrecal abort", "zeromotion", "clearfault", "reset", "info")

    @classmethod
    def add_args(cls, p):
        p.add_argument("--emulate", choices=sorted(PROFILES), default="imx")
        p.add_argument("--form", choices=["rug3", "board", "quad"], help="3D model to show (default: the profile's)")
        p.add_argument("--rate", type=float, default=143.0, help="attitude/IMU rate, Hz")

    def __init__(self, emit, args):
        super().__init__(emit, args)
        self.provides_attitude = args.emulate != "raw"
        self.recal_until = 0.0
        self.fault = 0x40000 if args.emulate == "imx" else 0

    def command(self, cmd):
        if cmd.startswith("magrecal"):
            self.recal_until = 0.0 if cmd.endswith("abort") else time.monotonic() + 20
        elif cmd == "clearfault":
            self.fault = 0
        self.emit({"t": "log", "msg": f"sim: {cmd}"})
        return True

    def run(self):
        a = self.args
        prof = dict(PROFILES[a.emulate])
        if a.form:
            prof["form"] = a.form
        imx = a.emulate == "imx"
        self.emit({"t": "src", "mode": "sim", "driver": self.name, "detail": f"emulating {a.emulate}"})
        self.emit({"t": "device", **prof, "serial": "SIM", "firmware": "2.7.0" if imx else None, "driver": "sim"})
        self.link(True, "sim")
        if imx:
            self.emit({"t": "imx.dev", "serialNumber": 0, "hardwareType": 3, "hardwareVer": "5.0.5", "firmwareVer": "2.7.0",
                       "buildDate": "sim", "manufacturer": "Simulator", "addInfo": "P8 I2"})
            self.emit({"t": "imx.cfg", "sensorConfig": 0x33, "dynamicModel": 8, "startupImuDtMs": 1, "startupNavDtMs": 7,
                       "startupGPSDtMs": 200, "sysCfgBits": 0x0010C000, "platformConfig": 0x007C0108, "ioConfig": 0x46,
                       "ser0BaudRate": 921600, "ser1BaudRate": 921600, "ser2BaudRate": 921600, "magDeclination": 0,
                       "insRotation": [0, 0, 0], "insOffset": [0, 0, 0]})

        dt = 1.0 / a.rate
        t0 = time.monotonic()
        k = 0
        rnd = random.gauss
        while not self.stopped():
            now = time.monotonic()
            t = now - t0
            r, p, y = attitude(t)
            q = euler_to_quat(r, p, y)
            pqr = [w + rnd(0, 0.002) for w in body_rates(t)]
            recal = now < self.recal_until

            if self.provides_attitude:
                self.emit({"t": "att", "time": round(t, 4), "q": q, "euler": [r, p, y], "source": "sensor",
                           "sigma": [1.0e-4, 1.0e-4, 5.2e-3] if imx else None})
            if k % 2 == 0 or not imx:
                acc = [v + rnd(0, 0.02) for v in rotate(qconj(q), [0.0, 0.0, -G])]
                self.emit({"t": "imu", "time": round(t, 4), "gyro": pqr, "acc": acc})
            if k % 3 == 0:
                mag = [v + rnd(0, 0.004) for v in rotate(qconj(q), FIELD)]
                self.emit({"t": "mag", "time": round(t, 4), "mag": mag, "unit": "norm"})
                if a.emulate != "raw":
                    self.emit({"t": "baro", "time": round(t, 4), "pressure": 100.67 + rnd(0, 0.002),
                               "alt": 54.9 + rnd(0, 0.15), "temp": 29.6})
            if k % 14 == 0 and a.emulate != "raw":
                self._status(t, recal, imx, y, pqr)
            k += 1
            time.sleep(max(0.0, t0 + k * dt - time.monotonic()))

    def _status(self, t, recal, imx, yaw, pqr):
        moving = max(abs(w) for w in pqr) > 0.05
        if not imx:
            self.emit({"t": "status", "mode": "AHRS", "level": "good", "detail": "Simulated attitude.", "temp": 27.0})
            return
        ins = (5 << 16) | 0x800 | 0x10 | (0x00400000 if recal else 0) | (0x80000000 if self.fault else 0)
        hdw = 0x02000000 | (0x3 if moving else 0)
        self.emit({"t": "status", "mode": "AHRS", "level": "good", "detail": "Attitude and heading good.",
                   "temp": 26.5, "x": {"insStatus": ins, "hdwStatus": hdw}})
        self.emit({"t": "imx.sys", "insStatus": ins, "hdwStatus": hdw, "imuTemp": 26.5 + 0.2 * math.sin(t / 60),
                   "baroTemp": 29.6, "mcuTemp": 0, "sysStatus": 0, "imuSamplePeriodMs": 1, "navOutputPeriodMs": 7,
                   "navUpdatePeriodMs": 14, "genFaultCode": self.fault, "upTime": round(t, 3)})
        self.emit({"t": "imx.inl2", "biasPqr": [3e-4, -4.6e-4, -1.4e-3], "biasAcc": [0, 0, 0], "biasBaro": 0,
                   "magDec": 0.0, "magInc": MAG_INC})
        self.emit({"t": "imx.sigma", "StdAttNed": [1.0e-4, 1.0e-4, 5.2e-3], "StdVelNed": [0.2] * 3,
                   "StdGyrBias": [1.4e-5, 1.4e-5, 1.6e-5], "StdAccBias": [0.01] * 3, "StdMagDeclination": 0.2})
        self.emit({"t": "imx.magobs", "Ncal_samples": 0, "calibrated": 1, "auto_recal": 0, "outlier": 0, "magHdg": yaw,
                   "insHdg": yaw, "magInsHdgDelta": random.gauss(0, 0.01), "nis": abs(random.gauss(0, 0.3)),
                   "nis_threshold": 5, "Tcal": 0, "bias_cal": [0, 0, 0]})
        left = self.recal_until - time.monotonic()
        self.emit({"t": "imx.magcal", "state": 200 if recal else 0,
                   "progress": max(0.0, min(100.0, 100 * (1 - left / 20))) if recal else 0, "declination": 0.0})

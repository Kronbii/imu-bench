"""
Synthetic IMX-5 stream in the bridge's message format, for working on the
dashboard without the sensor. The motion is a slow hand-held wobble; the IMU,
magnetometer and status words are derived from it consistently (ZYX Euler,
NED, qn2b = body-to-NED as the SDK defines it), so the readouts agree with
each other the way the real unit's do.
"""

import json
import math
import random
import time

G = 9.80665
D2R = math.pi / 180

# Beirut-ish field, normalized like the IMX reports it (≈1 when calibrated)
MAG_INC = 48 * D2R
MAG_DEC = 4.5 * D2R

# eInsStatusFlags / eHdwStatusFlags (data_sets.h)
INS_HDG_FINE = 0x10
INS_MAG_AIDING_HEADING = 0x800
INS_SOLUTION_AHRS = 5 << 16
INS_MAG_RECALIBRATING = 0x00400000
HDW_MOTION_GYR = 0x1
HDW_MOTION_ACC = 0x2
HDW_BIT_PASSED = 0x02000000


def euler_to_quat(r, p, y):
    cr, sr = math.cos(r / 2), math.sin(r / 2)
    cp, sp = math.cos(p / 2), math.sin(p / 2)
    cy, sy = math.cos(y / 2), math.sin(y / 2)
    return [
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
    ]


def ned_to_body(v, r, p, y):
    """Rotate a NED vector into the body frame (ZYX)."""
    cr, sr, cp, sp, cy, sy = math.cos(r), math.sin(r), math.cos(p), math.sin(p), math.cos(y), math.sin(y)
    n, e, d = v
    return [
        cp * cy * n + cp * sy * e - sp * d,
        (sr * sp * cy - cr * sy) * n + (sr * sp * sy + cr * cy) * e + sr * cp * d,
        (cr * sp * cy + sr * sy) * n + (cr * sp * sy - sr * cy) * e + cr * cp * d,
    ]


def attitude(t):
    """Roll, pitch, yaw (rad) of the wobble at time t."""
    r = (16 * math.sin(0.31 * t) + 5 * math.sin(1.27 * t + 0.4)) * D2R
    p = (11 * math.sin(0.23 * t + 1.0) + 3.5 * math.sin(0.93 * t)) * D2R
    y = (35 * math.sin(0.06 * t) + 22 * math.sin(0.17 * t + 2.0)) * D2R
    return r, p, y


class Simulator:
    def __init__(self, emit):
        self.emit = emit
        self.t0 = time.monotonic()
        self.recal_until = 0.0
        self.fault = 0

    def send(self, kind, **fields):
        self.emit(json.dumps({"t": kind, **fields}, separators=(",", ":")))

    def command(self, text):
        if text.startswith("magrecal") and not text.endswith("abort"):
            self.recal_until = time.monotonic() + 20
        elif text == "magrecal abort":
            self.recal_until = 0
        elif text == "clearfault":
            self.fault = 0
        self.send("log", msg=f"sim: {text}")
        return True

    def run(self):
        self.send("link", up=True, port="sim")
        self.send("dev", serialNumber=0, hardwareType=3, hardwareVer="5.0.5", firmwareVer="2.7.0",
                  buildDate="sim", manufacturer="Simulator", addInfo="P8 I2")
        self.send("cfg", sensorConfig=0x33, dynamicModel=8, startupImuDtMs=1, startupNavDtMs=7,
                  startupGPSDtMs=200, sysCfgBits=0x0010C000, platformConfig=0x007C0108, ioConfig=0x46,
                  ser0BaudRate=921600, ser1BaudRate=921600, ser2BaudRate=921600, magDeclination=0,
                  insRotation=[0, 0, 0], insOffset=[0, 0, 0])

        nav_dt = 0.007
        k = 0
        rnd = random.gauss
        while True:
            now = time.monotonic()
            t = now - self.t0
            r, p, y = attitude(t)
            r2, p2, y2 = attitude(t + 1e-3)
            dr, dp, dy = (r2 - r) / 1e-3, (p2 - p) / 1e-3, (y2 - y) / 1e-3
            # Euler rates to body rates
            pqr = [
                dr - dy * math.sin(p) + rnd(0, 0.002),
                dp * math.cos(r) + dy * math.sin(r) * math.cos(p) + rnd(0, 0.002),
                -dp * math.sin(r) + dy * math.cos(r) * math.cos(p) + rnd(0, 0.002),
            ]
            recal = now < self.recal_until
            moving = max(abs(v) for v in pqr) > 0.05
            ins = INS_SOLUTION_AHRS | INS_MAG_AIDING_HEADING | INS_HDG_FINE | (INS_MAG_RECALIBRATING if recal else 0)
            hdw = HDW_BIT_PASSED | ((HDW_MOTION_GYR | HDW_MOTION_ACC) if moving else 0)

            self.send("ins1", week=0, timeOfWeek=round(t, 4), insStatus=ins, hdwStatus=hdw,
                      theta=[r, p, y], uvw=[0, 0, 0], lla=[0, 0, 0], ned=[0, 0, 0])
            self.send("ins2", timeOfWeek=round(t, 4), insStatus=ins, hdwStatus=hdw, qn2b=euler_to_quat(r, p, y))

            if k % 2 == 0:
                acc = [v + rnd(0, 0.02) for v in ned_to_body([0, 0, -G], r, p, y)]
                self.send("imu", time=round(t, 4), status=0x3F, pqr=pqr, acc=acc)
            if k % 3 == 0:
                field = [math.cos(MAG_INC) * math.cos(MAG_DEC), math.cos(MAG_INC) * math.sin(MAG_DEC), math.sin(MAG_INC)]
                mag = [v + rnd(0, 0.004) for v in ned_to_body(field, r, p, y)]
                self.send("mag", time=round(t, 4), mag=mag)
                self.send("baro", time=round(t, 4), bar=100.67 + rnd(0, 0.002), mslBar=54.9 + rnd(0, 0.15),
                          barTemp=29.6, humidity=0)
            if k % 14 == 0:
                self.send("sys", insStatus=ins, hdwStatus=hdw, imuTemp=26.5 + 0.2 * math.sin(t / 60), baroTemp=29.6,
                          mcuTemp=0, sysStatus=0, imuSamplePeriodMs=1, navOutputPeriodMs=7, navUpdatePeriodMs=14,
                          genFaultCode=self.fault, upTime=round(t, 3))
                self.send("inl2", biasPqr=[3e-4, -4.6e-4, -1.4e-3], biasAcc=[0, 0, 0], biasBaro=0,
                          magDec=MAG_DEC, magInc=MAG_INC)
                self.send("magobs", Ncal_samples=0, calibrated=1, auto_recal=0, outlier=0, magHdg=y, insHdg=y,
                          magInsHdgDelta=rnd(0, 0.01), nis=abs(rnd(0, 0.3)), nis_threshold=5, Tcal=0,
                          bias_cal=[0, 0, 0])
                left = self.recal_until - now
                self.send("magcal", state=200 if recal else 0,
                          progress=max(0.0, min(100.0, 100 * (1 - left / 20))) if recal else 0, declination=MAG_DEC)
            if k % 20 == 0:
                self.send("sigma", StdAttNed=[1.0e-4, 1.0e-4, 5.2e-3], StdVelNed=[0.2, 0.2, 0.2],
                          StdGyrBias=[1.4e-5, 1.4e-5, 1.6e-5], StdAccBias=[0.01, 0.01, 0.01], StdMagDeclination=0.2)
            k += 1
            time.sleep(max(0.0, self.t0 + k * nav_dt - time.monotonic()))

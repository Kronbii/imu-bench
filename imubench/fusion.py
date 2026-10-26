"""
Attitude for sensors that only send gyro and accelerometer: a Madgwick
gradient-descent filter (S. Madgwick, 2010, the 6-axis form), plus an
optional slow heading loop that turns yaw toward the tilt-compensated
magnetometer. The heading loop is deliberately separate from tilt so a bad
magnetometer can only ever disturb yaw.

The filter runs in Madgwick's own frames (FLU body, NWU world, gravity +z) and
converts at the edges; in and out it speaks the bench's FRD body / NED.
"""

import math

from .protocol import euler_to_quat, qmul, qnorm, quat_to_euler, rotate

_X = [0.0, 1.0, 0.0, 0.0]  # 180 degrees about x: FRD<->FLU and NED<->NWU


def _swap(q):
    """FRD-to-NED <-> FLU-to-NWU; the same 180-degree flip on both sides."""
    return qmul(qmul(_X, q), _X)


def tilt_from_acc(acc):
    """Roll and pitch from specific force in FRD (reads [0, 0, -g] when level)."""
    ax, ay, az = acc
    return math.atan2(-ay, -az), math.atan2(ax, math.hypot(ay, az))


class Madgwick:
    def __init__(self, beta=0.05, mag_gain=0.3, use_mag=True):
        self.beta = beta  # gyro-vs-gravity trust; larger converges faster and is noisier
        self.mag_gain = mag_gain  # rad/s of yaw correction per rad of heading error
        self.use_mag = use_mag
        self.q = None  # FLU body to NWU
        self.t = None
        self.mag = None
        self.started = None

    def reset(self):
        self.q = self.t = self.started = None

    def set_mag(self, mag):
        if self.use_mag and any(mag):
            self.mag = mag

    def _init(self, acc, t):
        roll, pitch = tilt_from_acc(acc)
        q = euler_to_quat(roll, pitch, 0.0)
        if self.mag is not None:
            q = self._yaw_toward_mag(q, 1.0)
        self.q = _swap(q)
        self.t = self.started = t

    @staticmethod
    def _mag_heading_error(q_ned_frd, mag):
        """Angle by which the estimate's north differs from magnetic north."""
        m = rotate(q_ned_frd, mag)
        return math.atan2(m[1], m[0])

    def _yaw_toward_mag(self, q, fraction):
        err = self._mag_heading_error(q, self.mag)
        a = -err * fraction / 2
        return qnorm(qmul([math.cos(a), 0.0, 0.0, math.sin(a)], q))  # about NED down

    def update(self, t, gyro, acc):
        """One sample in FRD (rad/s, m/s^2). Returns the attitude quaternion, FRD to NED."""
        # first sample, a gap, or a clock that went backwards: start again from gravity
        if self.q is None or self.t is None or t < self.t or t - self.t > 0.5:
            self._init(acc, t)
            return _swap(self.q)
        dt = t - self.t
        if dt <= 0:
            return _swap(self.q)
        self.t = t

        gx, gy, gz = gyro[0], -gyro[1], -gyro[2]  # FRD -> FLU
        ax, ay, az = acc[0], -acc[1], -acc[2]
        q0, q1, q2, q3 = self.q

        # rate of change from the gyro
        d0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz)
        d1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy)
        d2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx)
        d3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx)

        n = math.sqrt(ax * ax + ay * ay + az * az)
        # skip the gravity step under strong linear acceleration (or no reading)
        if n > 0 and abs(n - 9.80665) < 3.0:
            ax, ay, az = ax / n, ay / n, az / n
            _2q0, _2q1, _2q2, _2q3 = 2 * q0, 2 * q1, 2 * q2, 2 * q3
            _4q0, _4q1, _4q2 = 4 * q0, 4 * q1, 4 * q2
            _8q1, _8q2 = 8 * q1, 8 * q2
            q0q0, q1q1, q2q2, q3q3 = q0 * q0, q1 * q1, q2 * q2, q3 * q3
            s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay
            s1 = _4q1 * q3q3 - _2q3 * ax + 4 * q0q0 * q1 - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az
            s2 = 4 * q0q0 * q2 + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az
            s3 = 4 * q1q1 * q3 - _2q1 * ax + 4 * q2q2 * q3 - _2q2 * ay
            sn = math.sqrt(s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3)
            if sn > 0:
                d0 -= self.beta * s0 / sn
                d1 -= self.beta * s1 / sn
                d2 -= self.beta * s2 / sn
                d3 -= self.beta * s3 / sn

        self.q = qnorm([q0 + d0 * dt, q1 + d1 * dt, q2 + d2 * dt, q3 + d3 * dt])
        out = _swap(self.q)

        if self.mag is not None:
            # converge hard for the first two seconds, then only nudge
            gain = 3.0 if t - self.started < 2.0 else self.mag_gain
            out = self._yaw_toward_mag(out, min(1.0, gain * dt))
            self.q = _swap(out)
        return out


class FusionStage:
    """Turns a stream with imu (and maybe mag) but no attitude into one with attitude."""

    def __init__(self, emit, beta=0.05, use_mag=True, max_rate=200.0):
        self.emit = emit
        self.filter = Madgwick(beta=beta, use_mag=use_mag)
        self.min_dt = 1.0 / max_rate
        self.last_out = None

    def __call__(self, msg):
        kind = msg.get("t")
        if kind == "mag":
            self.filter.set_mag(msg["mag"])
        elif kind == "imu":
            q = self.filter.update(msg["time"], msg["gyro"], msg["acc"])
            t = msg["time"]
            # 0.8: sample-time jitter must not drop every other sample at the limit rate
            if self.last_out is None or t - self.last_out >= 0.8 * self.min_dt or t < self.last_out:
                self.last_out = t
                self.emit({"t": "att", "time": t, "q": q, "euler": quat_to_euler(q), "source": "fusion"})
        elif kind == "link" and not msg.get("up"):
            self.filter.reset()

"""
The imuctl stream: one JSON object per message, the same whatever the
sensor. Drivers translate their device's protocol into these; the hub, the
recorder, ROS 2 and the dashboard only ever see these. Full description:
docs/protocol.md.

Conventions, everywhere: SI units; body frame FRD (x forward, y right,
z down); navigation frame NED; quaternions [w, x, y, z] rotating body
vectors into NED; Euler angles ZYX (roll, pitch, yaw) in radians; `time` in
seconds on the sensor's own clock.
"""

import json
import math

# message types and the fields a consumer can rely on
TYPES = {
    "device": "vendor, model, name, form, caps[] (+ serial, firmware, hardware, driver)",
    "link": "up, port, dev, why",
    "src": "mode (device|sim|replay), driver, detail",
    "att": "time, q[4], euler[3], source (sensor|fusion), sigma[3]?",
    "imu": "time, gyro[3] rad/s, acc[3] m/s^2",
    "mag": "time, mag[3], unit (norm|uT|gauss)",
    "baro": "time, pressure kPa, alt m?, temp degC?",
    "status": "mode, level (good|warning|serious|critical|neutral), detail?, temp?, flags[]?, x{}?",
    "log": "msg",
}

LEVELS = ("good", "warning", "serious", "critical", "neutral")


def dumps(msg):
    """Compact JSON with "t" first, so the hub can read the type without parsing."""
    t = msg.get("t")
    body = {"t": t, **{k: v for k, v in msg.items() if k != "t"}}
    return json.dumps(body, separators=(",", ":"), allow_nan=False, default=_default)


def _default(v):
    if isinstance(v, float) and not math.isfinite(v):
        return None
    raise TypeError(f"not JSON serialisable: {type(v).__name__}")


def clean(v):
    """NaN and inf are not JSON; replace them with None, recursively."""
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    return v


# ---- quaternion helpers (w, x, y, z), body to NED ------------------------------------


def qmul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return [
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ]


def qnorm(q):
    n = math.sqrt(sum(c * c for c in q)) or 1.0
    return [c / n for c in q]


def qconj(q):
    return [q[0], -q[1], -q[2], -q[3]]


def euler_to_quat(roll, pitch, yaw):
    cr, sr = math.cos(roll / 2), math.sin(roll / 2)
    cp, sp = math.cos(pitch / 2), math.sin(pitch / 2)
    cy, sy = math.cos(yaw / 2), math.sin(yaw / 2)
    return [
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
    ]


def quat_to_euler(q):
    w, x, y, z = q
    roll = math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
    pitch = math.asin(max(-1.0, min(1.0, 2 * (w * y - z * x))))
    yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
    return [roll, pitch, yaw]


def rotate(q, v):
    """Rotate vector v by quaternion q (body to NED for our quaternions)."""
    p = qmul(qmul(q, [0.0, *v]), qconj(q))
    return p[1:]


# ROS (REP-103) is FLU body / ENU world. Both swaps are 180-degree rotations.
Q_NED_ENU = [0.0, math.sqrt(0.5), math.sqrt(0.5), 0.0]  # takes ENU vectors to NED
Q_FLU_FRD = [0.0, 1.0, 0.0, 0.0]  # takes FRD vectors to FLU


def frd_to_flu(v):
    return [v[0], -v[1], -v[2]]


def q_ned_frd_to_enu_flu(q):
    """Our attitude (FRD body to NED) as ROS orientation (FLU body to ENU)."""
    return qmul(qmul(qconj(Q_NED_ENU), q), qconj(Q_FLU_FRD))


def q_enu_flu_to_ned_frd(q):
    return qmul(qmul(Q_NED_ENU, q), Q_FLU_FRD)


def axis_map(spec):
    """Parse an axis remap like "x,-y,-z" into a function from sensor to FRD body axes."""
    parts = [p.strip().lower() for p in spec.split(",")]
    if len(parts) != 3:
        raise ValueError(f"--axes wants three entries like x,-y,-z, got {spec!r}")
    picks = []
    for p in parts:
        sign = -1.0 if p.startswith("-") else 1.0
        name = p.lstrip("+-")
        if name not in "xyz" or len(name) != 1:
            raise ValueError(f"bad axis {p!r} in {spec!r}")
        picks.append(("xyz".index(name), sign))
    if sorted(i for i, _ in picks) != [0, 1, 2]:
        raise ValueError(f"--axes must use each of x, y, z once: {spec!r}")
    return lambda v: [v[i] * s for i, s in picks]

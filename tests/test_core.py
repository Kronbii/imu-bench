"""Protocol maths, fusion accuracy, line parsing and the IMX mapping. Run: python3 -m unittest"""

import math
import random
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from imuctl.drivers.imx import ImxMapper  # noqa: E402
from imuctl.drivers.lines import LineParser  # noqa: E402
from imuctl.drivers.sim import FIELD, attitude, body_rates  # noqa: E402
from imuctl.fusion import Madgwick, tilt_from_acc  # noqa: E402
from imuctl.protocol import (  # noqa: E402
    axis_map,
    dumps,
    euler_to_quat,
    q_enu_flu_to_ned_frd,
    q_ned_frd_to_enu_flu,
    qconj,
    qmul,
    quat_to_euler,
    rotate,
)

D = math.pi / 180


def angle_between(q1, q2):
    d = qmul(qconj(q1), q2)
    return 2 * math.acos(min(1.0, abs(d[0])))


class Protocol(unittest.TestCase):
    def test_euler_quat_round_trip(self):
        for e in ([0.1, -0.2, 0.3], [-1.0, 0.5, 3.0], [0.0, 1.4, -2.5]):
            self.assertTrue(all(abs(a - b) < 1e-9 for a, b in zip(e, quat_to_euler(euler_to_quat(*e)))))

    def test_gravity_reads_minus_g_on_z_when_level(self):
        # FRD body, NED world: a still, level sensor feels the table push up, i.e. -z
        acc = rotate(qconj(euler_to_quat(0, 0, 0.7)), [0, 0, -9.80665])
        self.assertAlmostEqual(acc[2], -9.80665)
        # nose down 20 degrees: x reads g*sin(pitch), as the IMX-5 does
        acc = rotate(qconj(euler_to_quat(0, -20 * D, 0)), [0, 0, -9.80665])
        self.assertAlmostEqual(acc[0], 9.80665 * math.sin(-20 * D), places=6)

    def test_ros_conversion_round_trip_and_heading(self):
        q = euler_to_quat(0.2, -0.3, 1.1)
        self.assertLess(angle_between(q, q_enu_flu_to_ned_frd(q_ned_frd_to_enu_flu(q))), 1e-9)
        # facing north in NED is facing +y (north) in ENU: ROS yaw = 90 deg
        ros = q_ned_frd_to_enu_flu(euler_to_quat(0, 0, 0))
        self.assertAlmostEqual(quat_to_euler(ros)[2], math.pi / 2, places=9)

    def test_axis_map(self):
        self.assertEqual(axis_map("x,-y,-z")([1, 2, 3]), [1, -2, -3])
        self.assertEqual(axis_map("-y,x,z")([1, 2, 3]), [-2, 1, 3])
        with self.assertRaises(ValueError):
            axis_map("x,x,z")

    def test_dumps_puts_type_first_and_refuses_nan(self):
        self.assertTrue(dumps({"time": 1, "t": "imu"}).startswith('{"t":"imu"'))
        with self.assertRaises(ValueError):
            dumps({"t": "imu", "v": float("nan")})


class Fusion(unittest.TestCase):
    def run_filter(self, use_mag, seconds=40):
        random.seed(3)
        f = Madgwick(beta=0.05, use_mag=use_mag)
        tilt, yaw = [], []
        dt = 0.005
        for k in range(int(seconds / dt)):
            t = k * dt
            r, p, y = attitude(t)
            q = euler_to_quat(r, p, y)
            gyro = [w + random.gauss(0, 0.002) + 0.003 for w in body_rates(t)]  # noise and a 0.17 deg/s bias
            acc = [a + random.gauss(0, 0.03) for a in rotate(qconj(q), [0, 0, -9.80665])]
            if use_mag:
                f.set_mag([m + random.gauss(0, 0.005) for m in rotate(qconj(q), FIELD)])
            est = quat_to_euler(f.update(t, gyro, acc))
            if t > 10:
                tilt.append(max(abs(est[0] - r), abs(est[1] - p)))
                yaw.append(abs((est[2] - y + math.pi) % (2 * math.pi) - math.pi))
        return sum(tilt) / len(tilt), max(tilt), sum(yaw) / len(yaw)

    def test_tilt_tracks_truth(self):
        mean, worst, _ = self.run_filter(use_mag=False)
        self.assertLess(mean, 0.3 * D)
        self.assertLess(worst, 1.0 * D)

    def test_magnetometer_fixes_heading(self):
        _, _, yaw = self.run_filter(use_mag=True)
        self.assertLess(yaw, 2.0 * D)

    def test_tilt_from_acc_matches_imx_sample(self):
        roll, pitch = tilt_from_acc([-3.45, -0.04, -9.17])  # a real IMX-5 reading at about -20.6 deg pitch
        self.assertAlmostEqual(pitch / D, -20.6, delta=0.1)
        self.assertAlmostEqual(roll / D, 0.25, delta=0.1)


def line_args(**kw):
    base = dict(gyro_unit="rad", acc_unit="ms2", euler_unit="rad", mag_unit="uT", time_scale=1.0,
                axes="x,y,z", frame="frd", fields="auto")
    base.update(kw)
    return types.SimpleNamespace(**base)


class Lines(unittest.TestCase):
    def test_csv_header_and_units(self):
        p = LineParser(line_args(gyro_unit="dps", acc_unit="g"))
        self.assertEqual(p.parse("time,gx,gy,gz,ax,ay,az"), [])
        imu = p.parse("1.5,90,0,0,0,0,-1")[0]
        self.assertEqual(imu["t"], "imu")
        self.assertAlmostEqual(imu["time"], 1.5)
        self.assertAlmostEqual(imu["gyro"][0], math.pi / 2)
        self.assertAlmostEqual(imu["acc"][2], -9.80665)

    def test_csv_by_column_count(self):
        msgs = LineParser(line_args()).parse("0 0 0 0 0 -9.8 20 0 40")
        self.assertEqual([m["t"] for m in msgs], ["imu", "mag"])

    def test_json_shorthand_with_axis_remap(self):
        p = LineParser(line_args(axes="x,-y,-z", time_scale=1e-3))
        imu = p.parse('{"ts": 2000, "gyr": [0.1, 0.2, 0.3], "accel": [0, 0, 9.81]}')[0]
        self.assertAlmostEqual(imu["time"], 2.0)
        self.assertEqual(imu["gyro"], [0.1, -0.2, -0.3])
        self.assertEqual(imu["acc"], [0.0, -0.0, -9.81])

    def test_ros_frame_orientation(self):
        q_ros = q_ned_frd_to_enu_flu(euler_to_quat(0.1, 0.2, 0.3))
        att = LineParser(line_args(frame="flu")).parse('{"q": %s}' % list(q_ros))[0]
        self.assertLess(angle_between(att["q"], euler_to_quat(0.1, 0.2, 0.3)), 1e-9)

    def test_imuctl_messages_pass_through(self):
        m = LineParser(line_args()).parse('{"t": "att", "time": 3, "q": [1, 0, 0, 0]}')[0]
        self.assertEqual(m["q"], [1, 0, 0, 0])

    def test_garbage_is_ignored(self):
        p = LineParser(line_args())
        for line in ("hello", "{not json", "1,2,3", '["list"]'):
            self.assertEqual(p.parse(line), [])


class ImxMapping(unittest.TestCase):
    def test_attitude_status_and_device(self):
        m = ImxMapper()
        out = m.map({"t": "dev", "serialNumber": 520920, "hardwareType": 3, "hardwareVer": "5.0.5", "firmwareVer": "2.7.0"})
        out += m.map({"t": "cfg", "platformConfig": 0x007C0108})
        devices = [o for o in out if o["t"] == "device"]
        self.assertEqual(devices[-1]["model"], "RUG-3-IMX-5")
        self.assertEqual(devices[-1]["form"], "rug3")
        st = m.map({"t": "ins1", "timeOfWeek": 10.0, "insStatus": 0x80470800, "hdwStatus": 0x02F00000,
                    "theta": [0.0, -0.36, -1.32], "uvw": [0, 0, 0], "lla": [0, 0, 0], "ned": [0, 0, 0]})
        self.assertEqual(st[0]["mode"], "VRS")
        att = m.map({"t": "ins2", "timeOfWeek": 10.0, "insStatus": 0, "hdwStatus": 0, "qn2b": [0.776, -0.109, -0.142, -0.605]})[0]
        self.assertEqual(att["euler"], [0.0, -0.36, -1.32])
        self.assertEqual(att["source"], "sensor")

    def test_raw_imu_replaces_nav_rate_imu(self):
        m = ImxMapper()
        self.assertEqual(len(m.map({"t": "imu", "time": 1, "pqr": [0, 0, 0], "acc": [0, 0, -9.8]})), 1)
        self.assertEqual(m.map({"t": "imuraw", "time": 1, "pqr": [0, 0, 0], "acc": [0, 0, -9.8]})[0]["t"], "imu")
        self.assertEqual(m.map({"t": "imu", "time": 2, "pqr": [0, 0, 0], "acc": [0, 0, -9.8]}), [])


class MagCorrection(unittest.TestCase):
    def test_pipeline_applies_saves_and_clears(self):
        import json
        import tempfile

        from imuctl.__main__ import Pipeline
        from imuctl.drivers.sim import HARD_IRON, SOFT_IRON

        out = []
        hub = types.SimpleNamespace(publish=out.append)
        path = Path(tempfile.mkdtemp()) / "magcal.json"
        p = Pipeline(hub, None, str(path))
        # the inverse of the simulator's iron undoes it exactly
        a, b, c, d, e, f, g, h, i = SOFT_IRON
        det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
        inv = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
               (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
               (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]
        p.set_magcal({"center": HARD_IRON, "matrix": inv})
        self.assertTrue(out[-1]["applied"])
        self.assertEqual(json.loads(path.read_text())["center"], HARD_IRON)
        truth = [0.4, -0.3, 0.86]
        raw = [sum(SOFT_IRON[3 * r + k] * truth[k] for k in range(3)) + HARD_IRON[r] for r in range(3)]
        p({"t": "mag", "time": 1.0, "mag": raw, "unit": "norm"})
        self.assertTrue(all(abs(u - v) < 1e-9 for u, v in zip(out[-1]["mag"], truth)))
        # a new process picks it up from the file
        self.assertIsNotNone(Pipeline(types.SimpleNamespace(publish=out.append), None, str(path)).magcal)
        with self.assertRaises(ValueError):
            p.set_magcal({"center": [0, 0], "matrix": [1] * 9})
        p.set_magcal(None)
        p({"t": "mag", "time": 2.0, "mag": raw, "unit": "norm"})
        self.assertEqual(out[-1]["mag"], raw)


if __name__ == "__main__":
    unittest.main()

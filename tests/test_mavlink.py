"""The MAVLink driver against messages encoded by pymavlink itself. Skipped without pymavlink."""

import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

try:
    from pymavlink import mavutil
except ImportError:
    mavutil = None

from imuctl.drivers.mavlink import MavlinkDriver  # noqa: E402


@unittest.skipIf(mavutil is None, "pymavlink not installed")
class Mavlink(unittest.TestCase):
    def setUp(self):
        self.out = []
        self.d = MavlinkDriver(self.out.append, types.SimpleNamespace(url="x", baud=0, rate=100, sysid=1))
        self.d.mav = mavutil
        self.m = mavutil.mavlink

    def decode(self, msg):
        """Pack and unpack, so the driver sees exactly what comes off the wire (base fields only:
        the default dialect may be MAVLink 1, without extensions)."""
        mav = self.m.MAVLink(None, srcSystem=1, srcComponent=1)
        return mav.parse_char(msg.pack(mav))

    def test_quaternion_and_heartbeat(self):
        m = self.m
        self.d._heartbeat(self.decode(m.MAVLink_heartbeat_message(
            m.MAV_TYPE_QUADROTOR, m.MAV_AUTOPILOT_PX4, m.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, 0, m.MAV_STATE_STANDBY, 3)))
        device = next(o for o in self.out if o["t"] == "device")
        self.assertEqual((device["vendor"], device["form"]), ("PX4", "quad"))
        self.d._attitude_quaternion(self.decode(m.MAVLink_attitude_quaternion_message(1500, 0.9, 0.1, 0.2, 0.3, 0, 0, 0)))
        att = self.out[-1]
        self.assertEqual(att["t"], "att")
        self.assertAlmostEqual(att["time"], 1.5)
        self.assertAlmostEqual(att["q"][0], 0.9, places=6)

    def test_highres_imu_units(self):
        m = self.m
        self.d._highres_imu(self.decode(m.MAVLink_highres_imu_message(
            2_000_000, 0.1, 0.2, -9.8, 0.01, 0.02, 0.03, 0.2, 0.0, 0.4, 1013.25, 0, 0, 35.0, 0x7 | 0x38 | 0x1C0 | 0x200 | 0x1000)))
        kinds = {o["t"]: o for o in self.out}
        self.assertAlmostEqual(kinds["imu"]["acc"][2], -9.8, places=5)
        self.assertEqual(kinds["mag"]["unit"], "gauss")
        self.assertAlmostEqual(kinds["baro"]["pressure"], 101.325, places=3)

    def test_scaled_imu_milli_units(self):
        m = self.m
        self.d._scaled_imu(self.decode(m.MAVLink_scaled_imu_message(1000, 0, 0, -1000, 100, 0, 0, 200, 0, 400)))
        imu = next(o for o in self.out if o["t"] == "imu")
        self.assertAlmostEqual(imu["acc"][2], -9.80665, places=4)
        self.assertAlmostEqual(imu["gyro"][0], 0.1)


if __name__ == "__main__":
    unittest.main()

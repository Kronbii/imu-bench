"""
MAVLink autopilots: PX4, ArduPilot, and anything else that speaks MAVLink 1/2
(Betaflight and INAV send a subset). Needs pymavlink (pip install pymavlink;
pyserial too for serial links).

MAVLink uses the same conventions as the bench (FRD body, NED, quaternion
w-x-y-z body to NED), so attitude and IMU pass through with unit scaling only.

  imu-bench mavlink                      # listen on UDP 14550 (PX4 SITL, a GCS link)
  imu-bench mavlink /dev/ttyACM0 --baud 115200
  imu-bench mavlink tcp:127.0.0.1:5760   # ArduPilot SITL
"""

import math
import time

from .base import Driver

MULTIROTORS = {2, 3, 4, 13, 14, 15, 29, 35}  # quad, coax, heli, hexa, octo, tri, dodeca, decarotor
# MAV_SYS_STATUS_SENSOR bits we can report on
SENSOR_BITS = [(1, "Gyro"), (2, "Accelerometer"), (4, "Magnetometer"), (8, "Barometer")]
# HIGHRES_IMU.fields_updated bits
HR_ACC, HR_GYRO, HR_MAG, HR_PRESS, HR_TEMP = 0x7, 0x38, 0x1C0, 0x200, 0x1000


class MavlinkDriver(Driver):
    name = "mavlink"
    help = "MAVLink autopilots (PX4, ArduPilot, ...) over UDP, TCP or serial"

    @classmethod
    def add_args(cls, p):
        p.add_argument("url", nargs="?", default="udpin:0.0.0.0:14550",
                       help="pymavlink connection string: udpin:0.0.0.0:14550, tcp:HOST:PORT, /dev/ttyACM0")
        p.add_argument("--baud", type=int, default=115200)
        p.add_argument("--rate", type=float, default=100.0, help="requested attitude/IMU rate, Hz")
        p.add_argument("--sysid", type=int, default=0, help="vehicle to follow (0: the first that sends a heartbeat)")

    def __init__(self, emit, args):
        super().__init__(emit, args)
        self.sysid = args.sysid
        self.compid = 1
        self.device = None
        self.euler = None
        self.quat_seen = 0.0
        self.last_hb = 0.0
        self.firmware = None

    def run(self):
        try:
            from pymavlink import mavutil
        except ImportError:
            raise RuntimeError("the mavlink driver needs pymavlink: pip install pymavlink pyserial") from None
        self.mav = mavutil
        a = self.args
        self.emit({"t": "src", "mode": "device", "driver": self.name, "detail": a.url})
        self.link(False, a.url, "searching")
        conn = mavutil.mavlink_connection(a.url, baud=a.baud, source_system=255, source_component=190, autoreconnect=True)
        self.conn = conn
        next_hb = 0.0
        requested = False
        while not self.stopped():
            now = time.monotonic()
            if now >= next_hb:  # be a polite ground station
                conn.mav.heartbeat_send(mavutil.mavlink.MAV_TYPE_GCS, mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0, 0)
                next_hb = now + 1.0
            if self.last_hb and now - self.last_hb > 3.0:
                self.link(False, a.url, "no heartbeat")
                self.last_hb = 0.0
                requested = False
            msg = conn.recv_match(blocking=True, timeout=0.2)
            if msg is None:
                continue
            kind = msg.get_type()
            if kind == "BAD_DATA":
                continue
            src = msg.get_srcSystem()
            if kind == "HEARTBEAT":
                if msg.autopilot == mavutil.mavlink.MAV_AUTOPILOT_INVALID:
                    continue  # another ground station
                if not self.sysid:
                    self.sysid = src
                if src != self.sysid:
                    continue
                self.compid = msg.get_srcComponent()
                self.last_hb = now
                self.link(True, a.url)
                if not requested:
                    self._request_streams()
                    requested = True
                self._heartbeat(msg)
                continue
            if src != self.sysid:
                continue
            handler = getattr(self, "_" + kind.lower(), None)
            if handler:
                handler(msg)

    # ---- outgoing -------------------------------------------------------------------

    def _request_streams(self):
        m = self.mav.mavlink
        period = int(1e6 / max(1.0, self.args.rate))
        for msg_id, us in ((m.MAVLINK_MSG_ID_ATTITUDE_QUATERNION, period), (m.MAVLINK_MSG_ID_ATTITUDE, period),
                           (m.MAVLINK_MSG_ID_HIGHRES_IMU, period), (m.MAVLINK_MSG_ID_SCALED_IMU, period),
                           (m.MAVLINK_MSG_ID_SCALED_PRESSURE, 100_000), (m.MAVLINK_MSG_ID_SYS_STATUS, 500_000)):
            self.conn.mav.command_long_send(self.sysid, self.compid, m.MAV_CMD_SET_MESSAGE_INTERVAL, 0, msg_id, us, 0, 0, 0, 0, 0)
        self.conn.mav.command_long_send(self.sysid, self.compid, m.MAV_CMD_REQUEST_MESSAGE, 0,
                                        m.MAVLINK_MSG_ID_AUTOPILOT_VERSION, 0, 0, 0, 0, 0, 0)

    # ---- incoming -------------------------------------------------------------------

    def _enum(self, enum, value, prefix):
        e = self.mav.mavlink.enums.get(enum, {}).get(value)
        return e.name.replace(prefix, "").replace("_", " ").title() if e else str(value)

    def _heartbeat(self, hb):
        m = self.mav.mavlink
        vendor = {m.MAV_AUTOPILOT_PX4: "PX4", m.MAV_AUTOPILOT_ARDUPILOTMEGA: "ArduPilot"}.get(
            hb.autopilot, self._enum("MAV_AUTOPILOT", hb.autopilot, "MAV_AUTOPILOT_"))
        vehicle = self._enum("MAV_TYPE", hb.type, "MAV_TYPE_")
        device = {"t": "device", "vendor": vendor, "name": vendor, "model": f"{vendor} · {vehicle}",
                  "form": "quad" if hb.type in MULTIROTORS else "board", "serial": f"sys {self.sysid}",
                  "firmware": self.firmware, "driver": "mavlink", "caps": ["attitude", "imu", "mag", "baro", "status"]}
        if device != self.device:
            self.device = device
            self.emit(device)
        armed = bool(hb.base_mode & m.MAV_MODE_FLAG_SAFETY_ARMED)
        mode = self.mav.mode_string_v10(hb)
        state = self._enum("MAV_STATE", hb.system_status, "MAV_STATE_")
        level = "critical" if hb.system_status >= m.MAV_STATE_CRITICAL else "warning" if armed else "good"
        self.status = {"t": "status", "mode": f"{'Armed' if armed else 'Disarmed'} · {mode}", "level": level,
                       "detail": f"Vehicle state: {state}."}
        self.emit(dict(self.status, flags=getattr(self, "flags", [])))

    def _autopilot_version(self, v):
        sw = v.flight_sw_version
        self.firmware = f"{(sw >> 24) & 0xFF}.{(sw >> 16) & 0xFF}.{(sw >> 8) & 0xFF}"
        if self.device:
            self.device = dict(self.device, firmware=self.firmware)
            self.emit(self.device)

    def _sys_status(self, s):
        flags = []
        for bit, label in SENSOR_BITS:
            if s.onboard_control_sensors_present & bit and s.onboard_control_sensors_enabled & bit:
                ok = bool(s.onboard_control_sensors_health & bit)
                flags.append({"label": f"{label} {'healthy' if ok else 'unhealthy'}", "level": "good" if ok else "critical"})
        self.flags = flags

    def _attitude_quaternion(self, a):
        self.quat_seen = time.monotonic()
        q = [a.q1, a.q2, a.q3, a.q4]
        msg = {"t": "att", "time": a.time_boot_ms / 1000.0, "q": q, "source": "sensor"}
        if self.euler and abs(self.euler[0] - a.time_boot_ms) < 50:
            msg["euler"] = self.euler[1]
        self.emit(msg)

    def _attitude(self, a):
        euler = [a.roll, a.pitch, a.yaw]
        self.euler = (a.time_boot_ms, euler)
        if time.monotonic() - self.quat_seen > 1.0:  # only when the vehicle sends no quaternion
            from ..protocol import euler_to_quat
            self.emit({"t": "att", "time": a.time_boot_ms / 1000.0, "q": euler_to_quat(*euler), "euler": euler, "source": "sensor"})

    def _highres_imu(self, h):
        t = h.time_usec / 1e6
        upd = h.fields_updated or 0xFFFF
        self.highres = time.monotonic()
        if upd & (HR_ACC | HR_GYRO):
            self.emit({"t": "imu", "time": t, "gyro": [h.xgyro, h.ygyro, h.zgyro], "acc": [h.xacc, h.yacc, h.zacc]})
        if upd & HR_MAG:
            self.emit({"t": "mag", "time": t, "mag": [h.xmag, h.ymag, h.zmag], "unit": "gauss"})
        if upd & HR_PRESS:
            baro = {"t": "baro", "time": t, "pressure": h.abs_pressure / 10.0}
            if math.isfinite(h.pressure_alt):
                baro["alt"] = h.pressure_alt
            if upd & HR_TEMP:
                baro["temp"] = h.temperature
            self.emit(baro)

    def _scaled_imu(self, s):
        if time.monotonic() - getattr(self, "highres", 0.0) < 1.0:
            return  # HIGHRES_IMU is better when the vehicle sends it
        t = s.time_boot_ms / 1000.0
        g = 9.80665e-3
        self.emit({"t": "imu", "time": t, "gyro": [s.xgyro / 1000, s.ygyro / 1000, s.zgyro / 1000],
                   "acc": [s.xacc * g, s.yacc * g, s.zacc * g]})
        self.emit({"t": "mag", "time": t, "mag": [s.xmag / 1000, s.ymag / 1000, s.zmag / 1000], "unit": "gauss"})

    def _scaled_pressure(self, p):
        if time.monotonic() - getattr(self, "highres", 0.0) < 1.0:
            return
        self.emit({"t": "baro", "time": p.time_boot_ms / 1000.0, "pressure": p.press_abs / 10.0, "temp": p.temperature / 100.0})

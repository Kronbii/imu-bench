"""
ROS 2, both ways (needs a sourced ROS 2, e.g. `source /opt/ros/jazzy/setup.bash`).

  imuctl ros2 --topic /imu/data         any sensor_msgs/Imu topic in
  imuctl <driver> --ros2-publish        any driver out, as sensor_msgs/Imu,
                                           MagneticField and FluidPressure

ROS follows REP-103: FLU body, ENU world. imuctl is FRD / NED, so vectors
and orientation are converted at this boundary and nowhere else.
"""

import math
import threading

from .drivers.base import Driver
from .protocol import frd_to_flu, q_enu_flu_to_ned_frd, q_ned_frd_to_enu_flu, quat_to_euler

flu_to_frd = frd_to_flu  # the same 180-degree flip about x, either way

TESLA = {"gauss": 1e-4, "uT": 1e-6}


def _rclpy():
    try:
        import rclpy
        from sensor_msgs.msg import FluidPressure, Imu, MagneticField
    except ImportError:
        raise RuntimeError("ROS 2 not found: source /opt/ros/<distro>/setup.bash first") from None
    return rclpy, Imu, MagneticField, FluidPressure


class Ros2Driver(Driver):
    name = "ros2"
    help = "any ROS 2 sensor_msgs/Imu topic (plus optional MagneticField, FluidPressure)"
    provides_attitude = False  # an Imu message with orientation_covariance[0] == -1 has none

    @classmethod
    def add_args(cls, p):
        p.add_argument("--topic", default="/imu/data", help="sensor_msgs/Imu topic")
        p.add_argument("--mag-topic", default="", help="sensor_msgs/MagneticField topic (optional)")
        p.add_argument("--pressure-topic", default="", help="sensor_msgs/FluidPressure topic (optional)")
        p.add_argument("--name", default="ROS 2 IMU")

    def run(self):
        rclpy, Imu, MagneticField, FluidPressure = _rclpy()
        a = self.args
        rclpy.init()
        node = rclpy.create_node("imuctl_in")
        self.emit({"t": "src", "mode": "device", "driver": self.name, "detail": a.topic})
        self.emit({"t": "device", "vendor": "ROS 2", "name": a.name, "model": a.topic, "form": "board",
                   "driver": "ros2", "caps": ["imu", "mag", "baro"]})
        self.link(False, a.topic, "searching")
        stamp = lambda h: h.stamp.sec + h.stamp.nanosec * 1e-9  # noqa: E731

        def on_imu(m):
            t = stamp(m.header)
            self.link(True, a.topic)
            w, v, ac = m.angular_velocity, m.linear_acceleration, m.orientation
            self.emit({"t": "imu", "time": t, "gyro": flu_to_frd([w.x, w.y, w.z]), "acc": flu_to_frd([v.x, v.y, v.z])})
            if m.orientation_covariance[0] != -1 and (ac.w or ac.x or ac.y or ac.z):
                q = q_enu_flu_to_ned_frd([ac.w, ac.x, ac.y, ac.z])
                self.emit({"t": "att", "time": t, "q": q, "euler": quat_to_euler(q), "source": "sensor"})

        def on_mag(m):
            f = m.magnetic_field
            self.emit({"t": "mag", "time": stamp(m.header), "mag": [c * 1e6 for c in flu_to_frd([f.x, f.y, f.z])], "unit": "uT"})

        def on_pressure(m):
            self.emit({"t": "baro", "time": stamp(m.header), "pressure": m.fluid_pressure / 1000.0})

        node.create_subscription(Imu, a.topic, on_imu, 50)
        if a.mag_topic:
            node.create_subscription(MagneticField, a.mag_topic, on_mag, 50)
        if a.pressure_topic:
            node.create_subscription(FluidPressure, a.pressure_topic, on_pressure, 50)
        while not self.stopped() and rclpy.ok():
            rclpy.spin_once(node, timeout_sec=0.25)
        node.destroy_node()
        rclpy.shutdown()


class Ros2Publisher:
    """A hub tap that republishes the imuctl stream as standard ROS 2 messages."""

    def __init__(self, prefix="/imu", frame_id="imu_link"):
        rclpy, Imu, MagneticField, FluidPressure = _rclpy()
        self.Imu, self.MagneticField, self.FluidPressure = Imu, MagneticField, FluidPressure
        if not rclpy.ok():
            rclpy.init()
        self.node = rclpy.create_node("imuctl")
        self.frame_id = frame_id
        self.pub_imu = self.node.create_publisher(Imu, f"{prefix}/data", 50)
        self.pub_mag = self.node.create_publisher(MagneticField, f"{prefix}/mag", 50)
        self.pub_pressure = self.node.create_publisher(FluidPressure, f"{prefix}/pressure", 10)
        self.att = None
        self.lock = threading.Lock()

    def _header(self, msg):
        msg.header.stamp = self.node.get_clock().now().to_msg()  # host time: ROS consumers expect it
        msg.header.frame_id = self.frame_id
        return msg

    def __call__(self, m):
        kind = m.get("t")
        with self.lock:
            if kind == "att":
                self.att = m
            elif kind == "imu":
                out = self._header(self.Imu())
                gx, gy, gz = frd_to_flu(m["gyro"])
                ax, ay, az = frd_to_flu(m["acc"])
                out.angular_velocity.x, out.angular_velocity.y, out.angular_velocity.z = gx, gy, gz
                out.linear_acceleration.x, out.linear_acceleration.y, out.linear_acceleration.z = ax, ay, az
                if self.att:
                    w, x, y, z = q_ned_frd_to_enu_flu(self.att["q"])
                    out.orientation.w, out.orientation.x, out.orientation.y, out.orientation.z = w, x, y, z
                    s = self.att.get("sigma")
                    if s:
                        out.orientation_covariance = [s[0] ** 2, 0.0, 0.0, 0.0, s[1] ** 2, 0.0, 0.0, 0.0, s[2] ** 2]
                else:
                    out.orientation_covariance[0] = -1.0  # REP-145: no orientation
                self.pub_imu.publish(out)
            elif kind == "mag" and m.get("unit") in TESLA:
                out = self._header(self.MagneticField())
                k = TESLA[m["unit"]]
                out.magnetic_field.x, out.magnetic_field.y, out.magnetic_field.z = (c * k for c in frd_to_flu(m["mag"]))
                self.pub_mag.publish(out)
            elif kind == "baro" and math.isfinite(m.get("pressure") or float("nan")):
                out = self._header(self.FluidPressure())
                out.fluid_pressure = m["pressure"] * 1000.0
                self.pub_pressure.publish(out)

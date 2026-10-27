"""Sensor drivers, by command name."""

from .imx import ImxDriver
from .lines import LinesDriver
from .mavlink import MavlinkDriver
from .replay import ReplayDriver
from .sim import SimDriver


def _ros2():
    from ..ros2 import Ros2Driver  # imports rclpy lazily, inside run()
    return Ros2Driver


DRIVERS = {
    "imx": ImxDriver,
    "mavlink": MavlinkDriver,
    "lines": LinesDriver,
    "ros2": _ros2(),
    "sim": SimDriver,
    "replay": ReplayDriver,
}

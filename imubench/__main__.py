"""
imu-bench: stream any IMU or AHRS to a live dashboard, a recording, or ROS 2.

  imu-bench imx                         Inertial Sense IMX-5/IMX-6 via the vendor SDK
  imu-bench mavlink [udpin:0.0.0.0:14550]   PX4, ArduPilot and other MAVLink autopilots
  imu-bench lines /dev/ttyUSB0@115200   anything that prints JSON or CSV lines
  imu-bench ros2 --topic /imu/data      any ROS 2 sensor_msgs/Imu topic
  imu-bench sim [--emulate raw]         synthetic motion
  imu-bench replay runs/desk.ndjson     a recording

Common options go after the driver: --http, --host, --record, --fusion,
--ros2-publish, --no-web. `imu-bench <driver> -h` lists the driver's own.
"""

import argparse
import signal
import sys
import threading
import time

from .drivers import DRIVERS
from .fusion import FusionStage
from .hub import Hub, Recorder


def common_args():
    p = argparse.ArgumentParser(add_help=False)
    g = p.add_argument_group("common")
    g.add_argument("--http", type=int, default=8765, help="dashboard port (default 8765)")
    g.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to open the dashboard to the network")
    g.add_argument("--no-web", action="store_true", help="no dashboard: just record and/or publish")
    g.add_argument("--record", metavar="FILE", help="append everything to an NDJSON file")
    g.add_argument("--fusion", choices=["auto", "on", "off"], default="auto",
                   help="Madgwick attitude from gyro+accel; auto = only when the device reports none")
    g.add_argument("--beta", type=float, default=0.05, help="Madgwick gain (default 0.05)")
    g.add_argument("--no-fusion-mag", action="store_true", help="keep the magnetometer out of fused heading")
    g.add_argument("--ros2-publish", action="store_true", help="also publish sensor_msgs/Imu, MagneticField, FluidPressure")
    g.add_argument("--ros2-prefix", default="/imu", help="topic prefix (default /imu: /imu/data, /imu/mag, /imu/pressure)")
    g.add_argument("--ros2-frame", default="imu_link", help="header frame_id")
    return p


def build_parser():
    ap = argparse.ArgumentParser(prog="imu-bench", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="driver", metavar="DRIVER", required=True)
    parent = common_args()
    for name, cls in DRIVERS.items():
        sp = sub.add_parser(name, help=cls.help, parents=[parent], description=cls.__doc__ or cls.help,
                            formatter_class=argparse.RawDescriptionHelpFormatter)
        cls.add_args(sp)
    return ap


class Pipeline:
    """Driver output -> (fusion) -> hub, with the device's caps kept truthful."""

    def __init__(self, hub, fusion):
        self.hub = hub
        self.fusion = fusion
        self.sensor_att = 0.0

    def __call__(self, msg):
        kind = msg.get("t")
        if kind == "att" and msg.get("source") == "sensor":
            self.sensor_att = time.monotonic()
        if self.fusion and kind == "device":
            caps = sorted(set(msg.get("caps") or []) | {"attitude"})
            msg = dict(msg, caps=caps, fusion="madgwick")
        self.hub.publish(msg)
        # a sensor that reports its own attitude wins over fusion
        if self.fusion and time.monotonic() - self.sensor_att > 1.0:
            self.fusion(msg)


def main(argv=None):
    args = build_parser().parse_args(argv)
    hub = Hub()
    cls = DRIVERS[args.driver]

    fusion = None
    pipeline = Pipeline(hub, None)
    driver = cls(pipeline, args)
    if hasattr(driver, "load"):
        driver.load()  # replay learns from the file whether it carries attitude
    want = args.fusion == "on" or (args.fusion == "auto" and not driver.provides_attitude)
    if want:
        fusion = FusionStage(hub.publish, beta=args.beta, use_mag=not args.no_fusion_mag)
        pipeline.fusion = fusion

    if args.record:
        hub.add_tap(Recorder(args.record))
    if args.ros2_publish:
        from .ros2 import Ros2Publisher
        hub.add_tap(Ros2Publisher(args.ros2_prefix, args.ros2_frame))

    driver.start()
    done = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: done.set())

    server = None
    if not args.no_web:
        from .web import serve
        server = serve(hub, driver, args.host, args.http)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        host = "127.0.0.1" if args.host in ("0.0.0.0", "") else args.host
        print(f"imu-bench {args.driver}: dashboard on http://{host}:{args.http}"
              + (" (fusion on)" if fusion else ""), flush=True)
    else:
        print(f"imu-bench {args.driver}: running" + (" (fusion on)" if fusion else ""), flush=True)
    try:
        while not done.wait(0.5):
            pass
    except KeyboardInterrupt:
        pass
    driver.stop()
    if server:
        server.shutdown()
    sys.exit(0)


if __name__ == "__main__":
    main()

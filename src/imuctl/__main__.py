"""
imuctl, the Universal IMU Control Dashboard: stream any IMU or AHRS live in 3D,
to a recording, or to ROS 2.

  imuctl imx                         Inertial Sense IMX-5/IMX-6 via the vendor SDK
  imuctl mavlink [udpin:0.0.0.0:14550]   PX4, ArduPilot and other MAVLink autopilots
  imuctl lines /dev/ttyUSB0@115200   anything that prints JSON or CSV lines
  imuctl ros2 --topic /imu/data      any ROS 2 sensor_msgs/Imu topic
  imuctl sim [--emulate raw]         synthetic motion
  imuctl replay runs/desk.ndjson     a recording

Common options go after the driver: --http, --host, --record, --fusion,
--ros2-publish, --no-web. `imuctl <driver> -h` lists the driver's own.
"""

import argparse
import json
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
    g.add_argument("--magcal", metavar="FILE", help="hard/soft-iron correction (JSON from the dashboard's fit); "
                   "applied to the magnetometer before fusion, and saved here when the dashboard applies a new one")
    g.add_argument("--ros2-publish", action="store_true", help="also publish sensor_msgs/Imu, MagneticField, FluidPressure")
    g.add_argument("--ros2-prefix", default="/imu", help="topic prefix (default /imu: /imu/data, /imu/mag, /imu/pressure)")
    g.add_argument("--ros2-frame", default="imu_link", help="header frame_id")
    return p


def build_parser():
    ap = argparse.ArgumentParser(prog="imuctl", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="driver", metavar="DRIVER", required=True)
    parent = common_args()
    for name, cls in DRIVERS.items():
        sp = sub.add_parser(name, help=cls.help, parents=[parent], description=cls.__doc__ or cls.help,
                            formatter_class=argparse.RawDescriptionHelpFormatter)
        cls.add_args(sp)
    return ap


class Pipeline:
    """Driver output -> (magnetometer correction) -> (fusion) -> hub, with the device's caps kept truthful."""

    def __init__(self, hub, fusion, magcal_file=None):
        self.hub = hub
        self.fusion = fusion
        self.sensor_att = 0.0
        self.magcal = None  # {"center": [3], "matrix": [9] row-major}: m_cal = W (m - c)
        self.magcal_file = magcal_file
        if magcal_file:
            try:
                with open(magcal_file) as f:
                    self.set_magcal(json.load(f), save=False)
            except FileNotFoundError:
                pass

    def set_magcal(self, cal, save=True):
        """Install (or with None, remove) a hard/soft-iron correction. Raises ValueError on a malformed one."""
        if cal is not None:
            c, w = cal.get("center"), cal.get("matrix")
            if not (isinstance(c, list) and len(c) == 3 and isinstance(w, list) and len(w) == 9):
                raise ValueError("want center[3] and matrix[9]")
            cal = {"center": [float(v) for v in c], "matrix": [float(v) for v in w]}
        self.magcal = cal
        if save and self.magcal_file:
            with open(self.magcal_file, "w") as f:
                json.dump(cal, f, indent=2)
        self.hub.publish({"t": "magcal", "applied": cal is not None, **(cal or {})})

    def __call__(self, msg):
        kind = msg.get("t")
        if kind == "att" and msg.get("source") == "sensor":
            self.sensor_att = time.monotonic()
        if kind == "mag" and self.magcal:
            c, w = self.magcal["center"], self.magcal["matrix"]
            d = [msg["mag"][i] - c[i] for i in range(3)]
            msg = dict(msg, mag=[w[3 * i] * d[0] + w[3 * i + 1] * d[1] + w[3 * i + 2] * d[2] for i in range(3)], cal=True)
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
    pipeline = Pipeline(hub, None, args.magcal)
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
        server = serve(hub, driver, args.host, args.http, pipeline)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        host = "127.0.0.1" if args.host in ("0.0.0.0", "") else args.host
        print(f"imuctl {args.driver}: dashboard on http://{host}:{args.http}"
              + (" (fusion on)" if fusion else ""), flush=True)
    else:
        print(f"imuctl {args.driver}: running" + (" (fusion on)" if fusion else ""), flush=True)
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

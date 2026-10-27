"""Plays a recording made with --record (or raw imx_bridge output) at its own pace, looping."""

import json
import time
from pathlib import Path

from .base import Driver
from .imx import ImxMapper

LEGACY = {"ins1", "ins2", "dev", "cfg", "sys", "magobs", "magcal", "sigma", "inl2", "imuraw"}
PACE = ("att", "imu")


class ReplayDriver(Driver):
    name = "replay"
    help = "play back a recording (.ndjson)"

    @classmethod
    def add_args(cls, p):
        p.add_argument("file", help="recording made with --record, or saved imx_bridge output")
        p.add_argument("--speed", type=float, default=1.0, help="playback speed; 0 = as fast as possible")
        p.add_argument("--once", action="store_true", help="stop at the end instead of looping")

    def load(self):
        if getattr(self, "_rows", None) is None:
            rows = [json.loads(line) for line in Path(self.args.file).read_text().splitlines() if line.strip()]
            if any(r.get("t") in LEGACY for r in rows[:200]):
                mapper = ImxMapper()
                rows = [out for r in rows for out in mapper.map(r)]
            self.provides_attitude = any(r.get("t") == "att" for r in rows)
            self._rows = rows
        return self._rows

    def run(self):
        rows = self.load()
        name = Path(self.args.file).name
        self.emit({"t": "src", "mode": "replay", "driver": self.name, "detail": name})
        pace = next((k for k in PACE if any(r.get("t") == k for r in rows)), None)
        while not self.stopped():
            self.link(True, name)
            t0_dev = t0_wall = None
            for msg in rows:
                if self.stopped():
                    return
                if msg.get("t") == pace and self.args.speed > 0:
                    t = msg["time"]
                    if t0_dev is None or t < t0_dev:
                        t0_dev, t0_wall = t, time.monotonic()
                    wait = (t - t0_dev) / self.args.speed - (time.monotonic() - t0_wall)
                    if wait > 0:
                        time.sleep(wait)
                if msg.get("t") != "link":
                    self.emit(msg)
            if self.args.once:
                self.link(False, name, "replay finished")
                return
            self.emit({"t": "log", "msg": "replay looped"})

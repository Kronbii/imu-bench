"""The hub: every message from the driver goes through here to every consumer."""

import queue
import threading
from pathlib import Path

from .protocol import clean, dumps

# kept for browsers that connect later, so they are complete straight away
STICKY = {"src", "link", "device", "status", "magcal", "imx.dev", "imx.cfg", "imx.sys", "imx.magobs", "imx.magcal", "imx.sigma", "imx.inl2"}
# live readings that must not outlive the device they came from
LIVE = {"status", "imx.sys", "imx.magobs", "imx.magcal", "imx.sigma", "imx.inl2"}


class Hub:
    def __init__(self):
        self.lock = threading.Lock()
        self.clients = set()
        self.latest = {}
        self.taps = []  # callables that see every message as a dict (recorder, ROS 2, fusion)

    def add_tap(self, fn):
        self.taps.append(fn)

    def publish(self, msg):
        msg = clean(msg)
        line = dumps(msg)
        kind = msg.get("t")
        with self.lock:
            if kind in STICKY:
                self.latest[kind] = line
            if kind == "link" and not msg.get("up"):
                for k in LIVE:
                    self.latest.pop(k, None)
            for q in self.clients:
                try:
                    q.put_nowait(line)
                except queue.Full:
                    pass  # a stalled browser drops data rather than holding the others back
        for tap in self.taps:
            tap(msg)

    def subscribe(self):
        q = queue.Queue(maxsize=8000)
        with self.lock:
            self.clients.add(q)
            snapshot = list(self.latest.values())
        return q, snapshot

    def unsubscribe(self, q):
        with self.lock:
            self.clients.discard(q)


class Recorder:
    """Appends every message to an NDJSON file that `imuctl replay` can play back."""

    SKIP = {"log"}

    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.f = open(path, "a", buffering=1)

    def __call__(self, msg):
        if msg.get("t") not in self.SKIP:
            self.f.write(dumps(msg) + "\n")

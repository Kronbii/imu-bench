#!/usr/bin/env python3
"""
Serves the IMX-5 dashboard and streams the sensor to it.

The bridge (bridge/build/imx_bridge) talks to the IMX through the Inertial
Sense SDK and prints one JSON object per data set. This server runs it, fans
those lines out to browsers over Server-Sent Events (/stream), forwards
whitelisted commands to it (POST /api/cmd), and serves the built web app.
Standard library only, so it runs as-is on a Jetson.

  python3 server/serve.py                      # live, finds the unit itself, http://127.0.0.1:8765
  python3 server/serve.py --port /dev/ttyTHS0 --baud 921600 --host 0.0.0.0
  python3 server/serve.py --record runs/desk.ndjson
  python3 server/serve.py --replay runs/desk.ndjson
  python3 server/serve.py --sim
"""

import argparse
import json
import mimetypes
import queue
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sim import Simulator  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "web" / "dist"
BRIDGE = ROOT / "bridge" / "build" / "imx_bridge"

COMMANDS = {
    "magrecal multi",
    "magrecal single",
    "magrecal abort",
    "zeromotion",
    "clearfault",
    "reset",
    "info",
}


def message(fields):
    # compact, so Hub.publish can read the type from the fixed '{"t":"' prefix
    return json.dumps(fields, separators=(",", ":"))


class Hub:
    """Fans stream lines out to every SSE client.

    The slow, stateful messages (device info, config, status) are kept so a
    browser that joins late is complete straight away.
    """

    STICKY = ("src", "link", "dev", "cfg", "sys", "magobs", "magcal", "sigma", "inl2")
    # live readings a late joiner must not see once the unit is gone; identity and config stay
    LIVE = ("sys", "magobs", "magcal", "sigma", "inl2")

    def __init__(self):
        self.lock = threading.Lock()
        self.clients = set()
        self.latest = {}

    def publish(self, line):
        kind = line[6 : line.find('"', 6)] if line.startswith('{"t":"') else ""
        with self.lock:
            if kind in self.STICKY:
                self.latest[kind] = line
            if kind == "link" and '"up":false' in line:
                for k in self.LIVE:
                    self.latest.pop(k, None)
            for q in self.clients:
                try:
                    q.put_nowait(line)
                except queue.Full:
                    pass  # a stalled browser drops data rather than holding the others back

    def subscribe(self):
        q = queue.Queue(maxsize=4000)
        with self.lock:
            self.clients.add(q)
            snapshot = list(self.latest.values())
        return q, snapshot

    def unsubscribe(self, q):
        with self.lock:
            self.clients.discard(q)


class BridgeSource:
    """Runs the SDK bridge and restarts it if it exits."""

    def __init__(self, hub, port, baud, record):
        self.hub, self.port, self.baud = hub, port, baud
        if record:
            Path(record).parent.mkdir(parents=True, exist_ok=True)
        self.record = open(record, "a", buffering=1) if record else None
        self.proc = None
        self.lock = threading.Lock()

    def start(self):
        if not BRIDGE.exists():
            sys.exit(f"bridge not built: {BRIDGE}\n  run ./scripts/setup.sh (or cmake -S bridge -B bridge/build && cmake --build bridge/build)")
        self.hub.publish(message({"t": "src", "mode": "device", "detail": self.port}))
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while True:
            cmd = [str(BRIDGE), "--port", self.port, "--baud", str(self.baud)]
            with self.lock:
                self.proc = subprocess.Popen(
                    cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1
                )
            for line in self.proc.stdout:
                line = line.strip()
                if not line:
                    continue
                self.hub.publish(line)
                if self.record:
                    self.record.write(line + "\n")
            code = self.proc.wait()
            self.hub.publish(message({"t": "log", "msg": f"bridge exited ({code}); restarting"}))
            time.sleep(1)

    def command(self, text):
        with self.lock:
            if self.proc and self.proc.poll() is None:
                self.proc.stdin.write(text + "\n")
                self.proc.stdin.flush()
                return True
        return False


class ReplaySource:
    """Plays a recorded NDJSON stream back at its own pace, looping."""

    def __init__(self, hub, path):
        self.hub, self.path = hub, Path(path)

    def start(self):
        self.hub.publish(message({"t": "src", "mode": "replay", "detail": self.path.name}))
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        lines = [l.strip() for l in self.path.read_text().splitlines() if l.strip()]
        while True:
            t0_dev = t0_wall = None
            for line in lines:
                msg = json.loads(line)
                # INS time of week paces playback; everything between two INS samples goes out together
                if msg["t"] == "ins1":
                    if t0_dev is None:
                        t0_dev, t0_wall = msg["timeOfWeek"], time.monotonic()
                    wait = (msg["timeOfWeek"] - t0_dev) - (time.monotonic() - t0_wall)
                    if wait > 0:
                        time.sleep(wait)
                self.hub.publish(line)
            self.hub.publish(message({"t": "log", "msg": "replay looped"}))

    def command(self, text):
        self.hub.publish(message({"t": "log", "msg": f"replay: '{text}' ignored"}))
        return True


class SimSource:
    def __init__(self, hub):
        self.hub = hub
        self.sim = Simulator(hub.publish)

    def start(self):
        self.hub.publish(message({"t": "src", "mode": "sim", "detail": "synthetic motion"}))
        threading.Thread(target=self.sim.run, daemon=True).start()

    def command(self, text):
        return self.sim.command(text)


def make_handler(hub, source):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/stream":
                return self._stream()
            return self._static(path)

        def do_POST(self):
            if self.path != "/api/cmd":
                return self._send(404, b"not found")
            try:
                n = int(self.headers.get("Content-Length", 0))
                cmd = json.loads(self.rfile.read(n) or b"{}").get("cmd", "")
            except (ValueError, AttributeError):
                return self._send(400, b"bad request")
            if cmd not in COMMANDS:
                return self._send(400, b"unknown command")
            ok = source.command(cmd)
            return self._send(200 if ok else 503, b"ok" if ok else b"bridge not running")

        def _send(self, code, body, ctype="text/plain"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _static(self, path):
            if not DIST.exists():
                msg = b"web/dist not built. Run: cd web && npm install && npm run build"
                return self._send(503, msg)
            target = (DIST / path.lstrip("/")).resolve()
            inside = str(target).startswith(str(DIST.resolve()) + "/")  # Path.is_relative_to needs 3.9; JetPack 5 has 3.8
            if not inside or not target.is_file():
                target = DIST / "index.html"  # single-page app
            body = target.read_bytes()
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            if "/assets/" in str(target):
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.end_headers()
            self.wfile.write(body)

        def _stream(self):
            q, snapshot = hub.subscribe()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            try:
                self._write_batch(snapshot)
                while True:
                    try:
                        batch = [q.get(timeout=1.0)]
                    except queue.Empty:
                        self.wfile.write(b": idle\n\n")
                        self.wfile.flush()
                        continue
                    # ~50 Hz batches: one event per frame-ish instead of one per sample
                    time.sleep(0.02)
                    while True:
                        try:
                            batch.append(q.get_nowait())
                        except queue.Empty:
                            break
                    self._write_batch(batch)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            finally:
                hub.unsubscribe(q)

        def _write_batch(self, lines):
            if lines:
                self.wfile.write(b"data: [" + ",".join(lines).encode() + b"]\n\n")
                self.wfile.flush()

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", default="auto", help="IMX serial device, or 'auto' to find it and follow it across replugs")
    ap.add_argument("--baud", type=int, default=921600)
    ap.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to view from another machine")
    ap.add_argument("--http", type=int, default=8765, help="HTTP port")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--sim", action="store_true", help="synthetic data, no device")
    mode.add_argument("--replay", metavar="FILE", help="play back a recorded .ndjson")
    ap.add_argument("--record", metavar="FILE", help="append the live stream to an .ndjson file")
    args = ap.parse_args()

    hub = Hub()
    if args.sim:
        source = SimSource(hub)
    elif args.replay:
        source = ReplaySource(hub, args.replay)
    else:
        source = BridgeSource(hub, args.port, args.baud, args.record)
    source.start()

    server = ThreadingHTTPServer((args.host, args.http), make_handler(hub, source))
    server.daemon_threads = True
    print(f"IMX-5 dashboard on http://{args.host}:{args.http}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

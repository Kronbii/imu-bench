"""HTTP: the dashboard's files, the stream over Server-Sent Events, and commands."""

import json
import mimetypes
import queue
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DIST = Path(__file__).resolve().parents[1] / "web" / "dist"


def make_handler(hub, driver):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/stream":
                return self._stream()
            if path == "/api/info":
                body = json.dumps({"driver": driver.name, "commands": list(driver.commands)}).encode()
                return self._send(200, body, "application/json")
            return self._static(path)

        def do_POST(self):
            if self.path != "/api/cmd":
                return self._send(404, b"not found")
            try:
                n = int(self.headers.get("Content-Length", 0))
                cmd = json.loads(self.rfile.read(n) or b"{}").get("cmd", "")
            except (ValueError, AttributeError):
                return self._send(400, b"bad request")
            if cmd not in driver.commands:
                return self._send(400, b"not a command this driver accepts")
            ok = driver.command(cmd)
            return self._send(200 if ok else 503, b"ok" if ok else b"device not connected")

        def _send(self, code, body, ctype="text/plain"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _static(self, path):
            if not DIST.exists():
                return self._send(503, b"web/dist not built. Run: cd web && npm ci && npm run build")
            root = DIST.resolve()
            target = (root / path.lstrip("/")).resolve()
            inside = str(target).startswith(str(root) + "/")  # Path.is_relative_to needs 3.9; JetPack 5 has 3.8
            if not inside or not target.is_file():
                target = root / "index.html"  # single-page app
            body = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            if "/assets/" in str(target):
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            else:
                self.send_header("Cache-Control", "no-cache")  # a rebuilt page is picked up on reload
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
                    time.sleep(0.02)  # ~50 batches a second rather than one event per sample
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


def serve(hub, driver, host, port):
    server = ThreadingHTTPServer((host, port), make_handler(hub, driver))
    server.daemon_threads = True
    return server

"""
Byte sources for the line driver, standard library only: a serial port (via
termios, no pyserial), UDP, a TCP client, or stdin. Each yields chunks of
bytes and reconnects on its own; serial ports may come and go (USB replug).

  stdin
  serial:/dev/ttyUSB0@115200     (or just /dev/ttyUSB0, default 115200)
  udp:5005                       (listen on 0.0.0.0:5005)
  tcp:192.168.1.20:3333          (connect, retry until it answers)
"""

import os
import select
import socket
import sys
import time

try:
    import termios
except ImportError:  # not on Windows; the serial transport is POSIX-only
    termios = None


def parse_url(url):
    if url in ("-", "stdin"):
        return "stdin", {}
    if url.startswith("udp:"):
        return "udp", {"port": int(url[4:])}
    if url.startswith("tcp:"):
        host, _, port = url[4:].rpartition(":")
        return "tcp", {"host": host or "127.0.0.1", "port": int(port)}
    path = url[7:] if url.startswith("serial:") else url
    path, _, baud = path.partition("@")
    return "serial", {"path": path, "baud": int(baud) if baud else 115200}


def open_serial(path, baud):
    if termios is None:
        raise OSError("serial needs a POSIX system")
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        attrs = termios.tcgetattr(fd)
        speed = getattr(termios, f"B{baud}")
        attrs[0] = 0  # iflag: raw
        attrs[1] = 0  # oflag
        attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
        attrs[3] = 0  # lflag: no echo, no canonical mode
        attrs[4] = attrs[5] = speed
        attrs[6][termios.VMIN] = 0
        attrs[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        termios.tcflush(fd, termios.TCIFLUSH)
    except Exception:
        os.close(fd)
        raise
    return fd


def chunks(url, stop, on_state=lambda up, why: None):
    """Yield byte chunks from `url` until stop() is true, reconnecting as needed.

    An empty chunk is yielded every 0.25 s of silence, so callers can time out.
    """
    kind, opt = parse_url(url)
    if kind == "stdin":
        fd = sys.stdin.buffer.fileno()
        on_state(True, None)
        while not stop():
            r, _, _ = select.select([fd], [], [], 0.25)
            if not r:
                yield b""
                continue
            data = os.read(fd, 65536)
            if not data:
                on_state(False, "stdin closed")
                return
            yield data
        return

    if kind == "udp":
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("0.0.0.0", opt["port"]))
        sock.settimeout(0.25)
        on_state(True, None)
        while not stop():
            try:
                yield sock.recv(65536) + b"\n"  # a datagram is a complete line
            except socket.timeout:
                yield b""
        return

    while not stop():
        try:
            if kind == "tcp":
                conn = socket.create_connection((opt["host"], opt["port"]), timeout=2)
                conn.settimeout(0.25)
                read = lambda: conn.recv(65536)  # noqa: E731
                close = conn.close
                fileno = conn.fileno()
            else:
                fd = open_serial(opt["path"], opt["baud"])
                read = lambda: os.read(fd, 65536)  # noqa: E731
                close = lambda: os.close(fd)  # noqa: E731
                fileno = fd
        except (OSError, AttributeError, ValueError) as e:
            on_state(False, "searching" if isinstance(e, FileNotFoundError) else str(e))
            time.sleep(0.5)
            continue
        on_state(True, None)
        try:
            while not stop():
                r, _, _ = select.select([fileno], [], [], 0.25)
                if not r:
                    if kind == "serial" and not os.path.exists(opt["path"]):
                        raise OSError("unplugged")
                    yield b""
                    continue
                data = read()
                if not data:
                    raise OSError("closed")
                yield data
        except (OSError, socket.timeout) as e:
            on_state(False, "unplugged" if str(e) == "unplugged" else str(e) or "disconnected")
        finally:
            close()
        time.sleep(0.3)


def lines(url, stop, on_state=lambda up, why: None):
    """Yield decoded text lines from `url`, and None on each idle tick."""
    buf = b""
    for data in chunks(url, stop, on_state):
        if not data:
            yield None
            continue
        buf += data
        *done, buf = buf.split(b"\n")
        for raw in done:
            raw = raw.strip()
            if raw:
                yield raw.decode("utf-8", "replace")
        if len(buf) > 1 << 16:  # no newline in 64 KiB: not a line protocol
            buf = b""

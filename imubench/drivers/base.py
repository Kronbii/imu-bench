import threading


class Driver:
    """A sensor source. Subclasses translate one protocol into bench messages."""

    name = ""
    help = ""
    # commands accepted from the dashboard (POST /api/cmd); anything else is refused
    commands = ()
    # False when the device never reports attitude, so fusion is on by default
    provides_attitude = True

    def __init__(self, emit, args):
        self.emit = emit
        self.args = args
        self._stop = threading.Event()
        self._link = None

    @classmethod
    def add_args(cls, parser):
        pass

    def start(self):
        threading.Thread(target=self._guarded, name=f"driver-{self.name}", daemon=True).start()

    def _guarded(self):
        try:
            self.run()
        except Exception as e:  # keep the server up and say why
            self.emit({"t": "log", "msg": f"{self.name} driver stopped: {e}"})
            self.link(False, "", str(e))
            raise

    def run(self):
        raise NotImplementedError

    def stop(self):
        self._stop.set()

    def stopped(self):
        return self._stop.is_set()

    def command(self, cmd):
        return False

    def link(self, up, port, why=None, dev=None):
        """Emit a link message when the state changes."""
        state = (up, port, None if up else why)
        if state == self._link:
            return
        self._link = state
        msg = {"t": "link", "up": up, "port": port}
        if dev:
            msg["dev"] = dev
        if why and not up:
            msg["why"] = why
        self.emit(msg)

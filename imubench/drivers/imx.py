"""
Inertial Sense IMX-5 / IMX-6 (bare module, RUG-3, RUG-4) over the vendor SDK.

The C++ bridge (bridge/imx_bridge) does the talking and prints the SDK's own
data sets as JSON lines; ImxMapper turns those into bench messages. Anything
IMX-specific that the dashboard's IMX panels want travels alongside as
imx.* messages with the SDK's field names.
"""

import json
import subprocess
import time
from pathlib import Path

from .base import Driver

ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "bridge" / "build" / "imx_bridge"

# insStatus bits 16-19 (data_sets.h, eInsStatusFlags)
SOLUTIONS = {
    0: ("Off", "critical", "Filter is not running."),
    1: ("Aligning", "warning", "Aligning; hold the unit still."),
    3: ("NAV", "good", "Full INS solution."),
    4: ("NAV · high variance", "warning", "Attitude uncertainty above threshold."),
    5: ("AHRS", "good", "Attitude and heading good."),
    6: ("AHRS · high variance", "warning", "Attitude uncertainty above threshold."),
    7: ("VRS", "warning", "Roll and pitch good; heading not north-referenced."),
    8: ("VRS · high variance", "serious", "No north, and roll/pitch uncertainty is high."),
}

CAPS = ["attitude", "imu", "mag", "baro", "status", "sigma", "panel:imx",
        "cmd:magrecal", "cmd:zeromotion", "cmd:clearfault", "cmd:reset"]


class ImxMapper:
    """SDK data sets from the bridge in, bench messages out."""

    def __init__(self):
        self.dev = None
        self.platform = None
        self.theta = None
        self.theta_tow = None
        self.sigma = None
        self.imu_temp = None
        self.raw_imu = False
        self.last_status = 0.0
        self.last_words = None

    def device(self):
        d = self.dev or {}
        hw = str(d.get("hardwareVer", ""))
        name = "IMX-6" if hw.startswith("6") else "IMX-5"
        plat = (self.platform or 0) & 0x3F
        case = {8: "RUG-3", 9: "RUG-3", 10: "RUG-3", 22: "RUG-4"}.get(plat)
        return {
            "t": "device",
            "vendor": "Inertial Sense",
            "name": name,
            "model": f"{case}-{name}" if case else name,
            "form": "rug3" if case else "board",
            "serial": str(d.get("serialNumber", "")),
            "firmware": d.get("firmwareVer"),
            "hardware": hw,
            "driver": "imx",
            "caps": CAPS,
        }

    def map(self, m):
        kind = m.get("t")
        body = {k: v for k, v in m.items() if k != "t"}
        out = []
        if kind in ("link", "log"):
            out.append(m)
        elif kind == "dev":
            self.dev = body
            out += [{"t": "imx.dev", **body}, self.device()]
        elif kind == "cfg":
            self.platform = body.get("platformConfig")
            out += [{"t": "imx.cfg", **body}, self.device()]
        elif kind == "ins1":
            self.theta, self.theta_tow = body["theta"], body["timeOfWeek"]
            out += self._status(body["insStatus"], body["hdwStatus"])
        elif kind == "ins2":
            att = {"t": "att", "time": body["timeOfWeek"], "q": body["qn2b"], "source": "sensor"}
            if self.theta is not None and self.theta_tow == body["timeOfWeek"]:
                att["euler"] = self.theta
            if self.sigma:
                att["sigma"] = self.sigma
            out.append(att)
        elif kind in ("imu", "imuraw"):
            if kind == "imuraw":
                self.raw_imu = True
            elif self.raw_imu:
                return out  # the 1 kHz stream is the IMU stream once it runs
            out.append({"t": "imu", "time": body["time"], "gyro": body["pqr"], "acc": body["acc"]})
        elif kind == "mag":
            out.append({"t": "mag", "time": body["time"], "mag": body["mag"], "unit": "norm"})
        elif kind == "baro":
            out.append({"t": "baro", "time": body["time"], "pressure": body["bar"], "alt": body["mslBar"], "temp": body["barTemp"]})
        elif kind == "sys":
            self.imu_temp = body.get("imuTemp")
            out.append({"t": "imx.sys", **body})
        elif kind == "sigma":
            self.sigma = body["StdAttNed"]
            out.append({"t": "imx.sigma", **body})
        elif kind in ("magobs", "magcal", "inl2"):
            out.append({"t": f"imx.{kind}", **body})
        return out

    def _status(self, ins, hdw):
        """A status message when the words change, or at 10 Hz."""
        now = time.monotonic()
        if (ins, hdw) == self.last_words and now - self.last_status < 0.1:
            return []
        self.last_words = (ins, hdw)
        self.last_status = now
        name, level, detail = SOLUTIONS.get((ins >> 16) & 0xF, ("Unknown", "neutral", ""))
        msg = {"t": "status", "mode": name, "level": level, "detail": detail, "x": {"insStatus": ins, "hdwStatus": hdw}}
        if self.imu_temp is not None:
            msg["temp"] = self.imu_temp
        return [msg]


class ImxDriver(Driver):
    name = "imx"
    help = "Inertial Sense IMX-5/IMX-6 (RUG-3, RUG-4, modules) via the vendor SDK"
    commands = ("magrecal multi", "magrecal single", "magrecal abort", "zeromotion", "clearfault", "reset", "info")

    @classmethod
    def add_args(cls, p):
        p.add_argument("--port", default="auto", help="serial device, a glob, or 'auto' (follows USB replugs)")
        p.add_argument("--baud", type=int, default=921600)
        p.add_argument("--raw-mult", type=int, default=0, metavar="N",
                       help="also stream DID_IMU_RAW every N ms (1 = 1 kHz) and use it as the IMU stream")

    def __init__(self, emit, args):
        super().__init__(emit, args)
        self.proc = None

    def run(self):
        if not BRIDGE.exists():
            raise FileNotFoundError(f"bridge not built ({BRIDGE}); run ./scripts/setup.sh")
        self.emit({"t": "src", "mode": "device", "driver": self.name, "detail": self.args.port})
        while not self.stopped():
            mapper = ImxMapper()
            cmd = [str(BRIDGE), "--port", self.args.port, "--baud", str(self.args.baud)]
            if self.args.raw_mult:
                cmd += ["--raw-mult", str(self.args.raw_mult)]
            self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
            for line in self.proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                for out in mapper.map(msg):
                    self.emit(out)
            code = self.proc.wait()
            if not self.stopped():
                self.emit({"t": "log", "msg": f"bridge exited ({code}); restarting"})
                time.sleep(1)

    def command(self, cmd):
        p = self.proc
        if p and p.poll() is None:
            p.stdin.write(cmd + "\n")
            p.stdin.flush()
            return True
        return False

    def stop(self):
        super().stop()
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

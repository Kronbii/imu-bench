#!/usr/bin/env bash
# Builds everything this repo needs, on the laptop or on a Jetson.
#
#   ./scripts/setup.sh              SDK (sdk/ submodule), cltool, bridge, web dashboard
#   ./scripts/setup.sh --udev       also install the udev rule (asks for sudo)
#
# EvalTool is fetched on its first run (tools/evaltool), x86-64 only. On a Jetson
# use the distro cmake; the SDK's scripts/install_cmake.sh downloads an x86-64 binary.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="$ROOT/sdk"
JOBS="$(nproc 2>/dev/null || echo 4)"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "Inertial Sense SDK 2.7.1 (sdk/ submodule)"
git -C "$ROOT" submodule update --init --recursive
if [ ! -f "$SDK/build/libInertialSenseSDK.a" ]; then
  cmake -S "$SDK" -B "$SDK/build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$SDK/build" -j "$JOBS"
fi

say "cltool"
cmake -S "$SDK/cltool" -B "$SDK/cltool/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$SDK/cltool/build" -j "$JOBS"

say "Bridge"
cmake -S "$ROOT/bridge" -B "$ROOT/bridge/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$ROOT/bridge/build" -j "$JOBS"

if command -v npm >/dev/null 2>&1; then
  say "Dashboard"
  (cd "$ROOT/web" && npm ci && npm run build)
else
  say "npm not found: skipping the dashboard build"
  echo "Build web/ on another machine (npm ci && npm run build) and copy web/dist here; the server only needs the files."
fi

if [ "${1:-}" = "--udev" ]; then
  say "udev rule (sudo)"
  sudo install -m 0644 "$ROOT/scripts/99-imx5.rules" /etc/udev/rules.d/99-imx5.rules
  sudo udevadm control --reload-rules
  sudo udevadm trigger --subsystem-match=tty
  id -nG "$USER" | grep -qw dialout || { sudo usermod -aG dialout "$USER"; echo "Added $USER to dialout: log out and back in."; }
fi

say "Done"
echo "Dashboard:  python3 server/serve.py        → http://127.0.0.1:8765  (--sim without the sensor)"
echo "Tools:      tools/cltool -h                  tools/evaltool"

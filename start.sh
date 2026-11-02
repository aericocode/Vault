#!/usr/bin/env bash
# Vault - one-command launcher for Linux and macOS (start.bat on Windows).
# Starts the local server and opens the viewer in the default browser.
# Flags pass through, e.g. ./start.sh --no-gamify
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is required but was not found."
  echo "  Install Node.js 20 or newer (https://nodejs.org, or your distro's"
  echo "  package, e.g. sudo apt install nodejs), then run ./start.sh again."
  echo
  exit 1
fi

major=$(node -p "process.versions.node.split('.')[0]")
if [ "$major" -lt 20 ]; then
  echo
  echo "  Vault needs Node.js 20 or newer. This is $(node -v)."
  echo "  Install a newer one (https://nodejs.org), then run ./start.sh again."
  echo
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First run: installing dependencies..."
  # onnxruntime-node ships its CPU build in the package; without this its
  # install step also fetches several hundred MB of CUDA add-ons on Linux x64.
  # Set ONNXRUNTIME_NODE_INSTALL yourself to override (for example cuda12).
  if ! ONNXRUNTIME_NODE_INSTALL="${ONNXRUNTIME_NODE_INSTALL:-skip}" npm install; then
    echo
    echo "  npm install failed, see the errors above."
    echo "  On Linux this usually means the build tools are missing:"
    echo "    Ubuntu, Debian, Mint:  sudo apt install build-essential python3"
    echo "    Fedora:                sudo dnf install gcc-c++ make python3"
    echo "    Arch:                  sudo pacman -S base-devel python"
    echo "  Then run ./start.sh again."
    exit 1
  fi
fi

# The port is defined ONCE in config/index.js (MEDIA_TAGGER_PORT overrides it,
# from the shell or from .env). Load .env exactly like the server does, then
# open the browser the same way the packaged app does (lib/platform.js:
# xdg-open on Linux, open on macOS). A missing browser is not an error.
node -e "require('./lib/load-env')();require('./lib/platform').openUrl('http://127.0.0.1:'+require('./config').server.port)" || true

exec node server/index.js "$@"

#!/usr/bin/env bash
# Vault - interactive scan wizard (no flags to remember). scan.bat on Windows.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is required but was not found."
  echo "  Install Node.js 20 or newer (https://nodejs.org, or your distro's"
  echo "  package), then run ./scan.sh again."
  echo
  exit 1
fi

major=$(node -p "process.versions.node.split('.')[0]")
if [ "$major" -lt 20 ]; then
  echo
  echo "  Vault needs Node.js 20 or newer. This is $(node -v)."
  echo
  exit 1
fi

exec node vault.js "$@"

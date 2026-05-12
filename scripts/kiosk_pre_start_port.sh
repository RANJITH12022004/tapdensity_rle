#!/usr/bin/env bash
# Release FLASK_PORT so the bridge can bind after unclean shutdown.
set -uo pipefail
PORT="${FLASK_PORT:-5000}"
if command -v fuser >/dev/null 2>&1; then
  fuser -k -TERM "${PORT}/tcp" >/dev/null 2>&1 || true
  sleep 0.7
fi
exit 0

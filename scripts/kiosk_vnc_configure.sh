#!/usr/bin/env bash
# Allow RealVNC (service mode) to share the kiosk X session on :0.
set -euo pipefail

export DISPLAY="${DISPLAY:-:0}"

# Let local root VNC attach to this X server.
if command -v xhost >/dev/null 2>&1; then
  xhost +local: >/dev/null 2>&1 || true
fi

# Merge startx cookie into ~/.Xauthority (startx often uses /tmp/serverauth.*).
if command -v xauth >/dev/null 2>&1; then
  auth="${XAUTHORITY:-$HOME/.Xauthority}"
  mkdir -p "$(dirname "$auth")"
  touch "$auth"
  for cookie in /tmp/serverauth.*; do
    [ -f "$cookie" ] || continue
    xauth -f "$auth" merge "$cookie" 2>/dev/null || true
  done
  chmod 600 "$auth" 2>/dev/null || true
fi

# RealVNC scans vt2 on Raspberry Pi OS; reload after X is up so it binds to :0.
if command -v vncserver-x11 >/dev/null 2>&1; then
  sudo /usr/bin/vncserver-x11 -service -reload 2>/dev/null || true
fi

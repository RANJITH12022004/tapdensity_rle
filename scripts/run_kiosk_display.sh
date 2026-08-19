#!/usr/bin/env bash
# Start X on tty2 and keep the kiosk UI running (Chromium full-screen).
set -euo pipefail

export DISPLAY=:0
export XAUTHORITY="${XAUTHORITY:-/home/rle/.Xauthority}"

# Switch HDMI away from tty1 login prompt as early as possible.
if command -v chvt >/dev/null 2>&1; then
  chvt 2 2>/dev/null || true
fi

for _ in $(seq 1 30); do
  if curl -sf --connect-timeout 1 "http://127.0.0.1:5000/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

# RealVNC on Raspberry Pi OS expects the console X server on vt2.
exec /usr/bin/startx /home/rle/.xinitrc -- :0 vt2 -keeptty

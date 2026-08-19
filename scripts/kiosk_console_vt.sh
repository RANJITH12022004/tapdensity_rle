#!/usr/bin/env bash
# Keep the physical HDMI console on the kiosk X virtual terminal (vt2 for RealVNC).
set -euo pipefail

KIOSK_VT="${KIOSK_VT:-2}"

switch_vt() {
  if command -v chvt >/dev/null 2>&1; then
    chvt "$KIOSK_VT" 2>/dev/null || true
  elif command -v openvt >/dev/null 2>&1; then
    openvt -f -s -w "$KIOSK_VT" -- true 2>/dev/null || true
  fi
}

# Leave the login tty immediately (blank screen until X/Chromium is ready).
switch_vt

for _ in $(seq 1 240); do
  if [ -S /tmp/.X11-unix/X0 ]; then
    break
  fi
  sleep 0.5
done

switch_vt

# Production: return to kiosk if someone switches away (Ctrl+Alt+F*).
while true; do
  sleep 2
  active="$(fgconsole 2>/dev/null || echo 0)"
  if [ "$active" != "$KIOSK_VT" ]; then
    switch_vt
  fi
done

#!/usr/bin/env bash
# Release FLASK_PORT so app.py / the bridge can bind after unclean shutdown.
# Wait for internal USB so factory settings / members load from the real storage volume.
set -euo pipefail

PORT="${FLASK_PORT:-5000}"
INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"
STORAGE_DIR="${STORAGE_DIR:-$INTERNAL_USB_PATH/storage}"

# Note: USB mount is optional — app falls back to SD-card storage if USB is absent.
# Do not wait for USB here; it causes up to 45 s boot delay when USB is unavailable.

if command -v fuser >/dev/null 2>&1; then
  fuser -k -TERM "${PORT}/tcp" >/dev/null 2>&1 || true
  sleep 0.2
  fuser -k -KILL "${PORT}/tcp" >/dev/null 2>&1 || true
fi

# Orphan app.py / bridge.py (e.g. manual start) can keep port 5000 while systemd restarts fail silently.
pkill -TERM -f '/opt/kiosk/app\.py' 2>/dev/null || true
pkill -TERM -f '/opt/kiosk/venv/bin/python.*app\.py' 2>/dev/null || true
pkill -TERM -f '/opt/kiosk/bridge\.py' 2>/dev/null || true
pkill -TERM -f '/opt/kiosk/venv/bin/python.*bridge\.py' 2>/dev/null || true
sleep 0.2
pkill -KILL -f '/opt/kiosk/app\.py' 2>/dev/null || true
pkill -KILL -f '/opt/kiosk/venv/bin/python.*app\.py' 2>/dev/null || true
pkill -KILL -f '/opt/kiosk/bridge\.py' 2>/dev/null || true
pkill -KILL -f '/opt/kiosk/venv/bin/python.*bridge\.py' 2>/dev/null || true

exit 0

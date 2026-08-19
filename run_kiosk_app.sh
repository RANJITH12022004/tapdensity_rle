#!/usr/bin/env bash
# Launcher used by kiosk-bridge.service to start the Tap Density Flask backend.
# Mirrors the manual flow in /opt/kiosk/start_kiosk.sh (backend only; no Chromium).

set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/kiosk}"
PYTHON="${PYTHON:-/opt/kiosk/venv/bin/python3}"
INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"

cd "$APP_ROOT"

# Internal pendrive: JSON storage, PDF reports, audit DB.
# Only use USB paths if the USB is actually mounted (not just if /media/usb_internal dir exists).
# If USB is absent or write-protected, the app falls back to /opt/kiosk/storage on the SD card.
if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
  export INTERNAL_USB_PATH
  export STORAGE_DIR="${STORAGE_DIR:-$INTERNAL_USB_PATH/storage}"
  export REPORTS_DIR="${REPORTS_DIR:-$INTERNAL_USB_PATH/reports}"
  export AUDIT_DB_DIR="${AUDIT_DB_DIR:-$INTERNAL_USB_PATH/db}"
  export INTERNAL_USB_UUIDS="${INTERNAL_USB_UUIDS:-D444-057C}"
else
  # USB not available — clear env vars so data_service uses SD-card defaults
  unset STORAGE_DIR REPORTS_DIR AUDIT_DB_DIR 2>/dev/null || true
  export STORAGE_DIR="$APP_ROOT/storage"
  export REPORTS_DIR="$APP_ROOT/reports"
  export AUDIT_DB_DIR="$APP_ROOT/db"
fi

if [ -f "$APP_ROOT/config/internal_usb.env" ]; then
  # shellcheck disable=SC1090
  source "$APP_ROOT/config/internal_usb.env"
  export INTERNAL_USB_UUIDS="${INTERNAL_USB_UUIDS:-${INTERNAL_USB_UUID:-}}"
  export INTERNAL_USB_PKNAME="${INTERNAL_USB_PKNAME:-sda}"
  export INTERNAL_USB_PARTITION="${INTERNAL_USB_PARTITION:-/dev/sda1}"
fi

export APP_ROOT PYTHONUNBUFFERED=1
export FLASK_HOST=0.0.0.0
exec "$PYTHON" "$APP_ROOT/bridge.py"

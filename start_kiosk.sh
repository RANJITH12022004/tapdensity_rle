#!/bin/bash
# Start Tap Density backend and optionally Chromium kiosk
# For production: copy project to /opt/kiosk and run this script

APP_ROOT="${APP_ROOT:-/opt/kiosk}"
cd "$APP_ROOT"

PYTHON="${PYTHON:-/opt/kiosk/venv/bin/python3}"
LOG="${KIOSK_LOG:-$HOME/kiosk_bridge.log}"

# Ensure internal USB is mounted and project dirs exist
/bin/bash "$APP_ROOT/scripts/kiosk_mount_internal_usb.sh" 2>/dev/null || true

INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"
if [ -d "$INTERNAL_USB_PATH" ]; then
  export INTERNAL_USB_PATH
  export STORAGE_DIR="${STORAGE_DIR:-$INTERNAL_USB_PATH/storage}"
  export REPORTS_DIR="${REPORTS_DIR:-$INTERNAL_USB_PATH/reports}"
  export AUDIT_DB_DIR="${AUDIT_DB_DIR:-$INTERNAL_USB_PATH/db}"
  export INTERNAL_USB_UUIDS="${INTERNAL_USB_UUIDS:-D444-057C}"
fi

# Start Flask backend (app.py)
nohup env APP_ROOT="$APP_ROOT" PYTHONUNBUFFERED=1 "$PYTHON" "$APP_ROOT/bridge.py" >> "$LOG" 2>&1 &

# Give backend a moment to start
sleep 2

# Display is managed by kiosk-display.service; manual start uses systemd.
if command -v systemctl >/dev/null 2>&1; then
  nohup env KIOSK_URL="${KIOSK_URL:-http://127.0.0.1:5000/}" \
    systemctl start kiosk-display.service >> "$LOG" 2>&1 &
fi

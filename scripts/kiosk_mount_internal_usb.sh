#!/usr/bin/env bash
# Ensure internal pendrive (sda1) is mounted at /media/usb_internal and project dirs exist.
set -euo pipefail

INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"
STORAGE_DIR="${STORAGE_DIR:-$INTERNAL_USB_PATH/storage}"
REPORTS_DIR="${REPORTS_DIR:-$INTERNAL_USB_PATH/reports}"
AUDIT_DB_DIR="${AUDIT_DB_DIR:-$INTERNAL_USB_PATH/db}"

if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
  mkdir -p "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR"
  APP_ROOT="${APP_ROOT:-/opt/kiosk}"
  if [ -x "$APP_ROOT/scripts/migrate_storage_to_internal_usb.sh" ]; then
    if [ ! -f "$STORAGE_DIR/members.json" ] && [ -f "$APP_ROOT/storage/members.json" ]; then
      /bin/bash "$APP_ROOT/scripts/migrate_storage_to_internal_usb.sh" || true
    fi
  fi
  exit 0
fi

# fstab entry should mount this during local-fs.target; retry briefly if udev is still settling.
if command -v mount >/dev/null 2>&1; then
  mount "$INTERNAL_USB_PATH" 2>/dev/null || true
fi

for _i in $(seq 1 5); do
  if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
    mkdir -p "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR"
    APP_ROOT="${APP_ROOT:-/opt/kiosk}"
    if [ -x "$APP_ROOT/scripts/migrate_storage_to_internal_usb.sh" ]; then
      if [ ! -f "$STORAGE_DIR/members.json" ] && [ -f "$APP_ROOT/storage/members.json" ]; then
        /bin/bash "$APP_ROOT/scripts/migrate_storage_to_internal_usb.sh" || true
      fi
    fi
    exit 0
  fi
  sleep 0.4
done

echo "kiosk_mount_internal_usb: WARNING $INTERNAL_USB_PATH not mounted — app will use SD-card storage as fallback" >&2
# Do NOT exit 1 here: the app must start regardless; data_service falls back to /opt/kiosk/storage on the SD card.
exit 0

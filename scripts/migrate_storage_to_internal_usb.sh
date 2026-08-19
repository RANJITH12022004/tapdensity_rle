#!/bin/bash
# Copy JSON storage, reports, and audit DB from OS SD card to internal USB when USB is empty or older.
set -euo pipefail

INTERNAL="${INTERNAL_USB_PATH:-/media/usb_internal}"
APP_ROOT="${APP_ROOT:-/opt/kiosk}"
STORAGE_DIR="${STORAGE_DIR:-$INTERNAL/storage}"
REPORTS_DIR="${REPORTS_DIR:-$INTERNAL/reports}"
AUDIT_DB_DIR="${AUDIT_DB_DIR:-$INTERNAL/db}"

if ! mountpoint -q "$INTERNAL" 2>/dev/null; then
  echo "migrate_storage: $INTERNAL not mounted — skip" >&2
  exit 0
fi

mkdir -p "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR"

copy_if_newer() {
  local src="$1" dest="$2"
  if [ ! -e "$src" ]; then
    return 0
  fi
  if [ ! -e "$dest" ] || [ "$src" -nt "$dest" ] || [ "$(stat -c%s "$src" 2>/dev/null || echo 0)" -gt "$(stat -c%s "$dest" 2>/dev/null || echo 0)" ]; then
    cp -a "$src" "$dest"
    echo "  copied $(basename "$src")"
  fi
}

echo "Migrating kiosk data from $APP_ROOT to $INTERNAL ..."

for src_db in "$APP_ROOT/db/audit_log.db" "$INTERNAL/db/audit_log.db"; do
  :
done
if [ -f "$APP_ROOT/db/audit_log.db" ]; then
  dest_db="$AUDIT_DB_DIR/audit_log.db"
  src_size="$(stat -c%s "$APP_ROOT/db/audit_log.db" 2>/dev/null || echo 0)"
  dest_size="$(stat -c%s "$dest_db" 2>/dev/null || echo 0)"
  if [ ! -f "$dest_db" ] || [ "$src_size" -gt "$dest_size" ]; then
    cp -a "$APP_ROOT/db/audit_log.db" "$dest_db"
    echo "  copied audit_log.db ($src_size bytes)"
  fi
fi

for f in "$APP_ROOT/reports/"*; do
  [ -e "$f" ] || continue
  copy_if_newer "$f" "$REPORTS_DIR/$(basename "$f")"
done

for f in "$APP_ROOT/storage/"*; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  case "$base" in
    _smoke_*|*.tmp|*.bak) continue ;;
  esac
  if [ -f "$f" ]; then
    copy_if_newer "$f" "$STORAGE_DIR/$base"
  fi
done

echo "Done. Data directory: $STORAGE_DIR"

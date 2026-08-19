#!/usr/bin/env bash
# Lightweight health check: restart API or display if they died.
set -uo pipefail

API_URL="${KIOSK_URL:-http://127.0.0.1:5000/}"
LOG_TAG="kiosk-watchdog"

log() { echo "$LOG_TAG: $*" >&2; }

api_ok() {
  curl -sf --connect-timeout 2 --max-time 4 "$API_URL" >/dev/null 2>&1
}

display_ok() {
  pgrep -f '/usr/lib/xorg/Xorg :0' >/dev/null 2>&1 \
    && pgrep -f '/usr/lib/chromium/chromium.*--app=' >/dev/null 2>&1
}

if ! api_ok; then
  log "API down — restarting kiosk-bridge.service"
  systemctl restart kiosk-bridge.service || true
  sleep 3
fi

if ! display_ok; then
  log "Display down — restarting kiosk-display.service"
  systemctl restart kiosk-display.service || true
fi

exit 0

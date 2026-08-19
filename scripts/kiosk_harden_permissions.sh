#!/usr/bin/env bash
# Ensure kiosk scripts stay executable (survives folder replace / git checkout).
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/kiosk}"
chmod +x \
  "$APP_ROOT/run_kiosk_app.sh" \
  "$APP_ROOT/run_hardness_bridge.sh" \
  "$APP_ROOT/start_kiosk.sh" \
  "$APP_ROOT/scripts/kiosk_vnc_configure.sh" \
  "$APP_ROOT/scripts/"*.sh 2>/dev/null || true

#!/usr/bin/env bash
# After logout: exit the bridge so systemd (Restart=always) brings up a fresh process.
# Invoked detached from POST /api/data/auth/logout (reason=user or inactivity).

set -euo pipefail

sleep 2

pkill -TERM -f '/opt/kiosk/bridge\.py' 2>/dev/null || true
pkill -TERM -f '/opt/kiosk/venv/bin/python.*bridge\.py' 2>/dev/null || true

exit 0

#!/usr/bin/env bash
# One-shot installer: run after copying/replacing /opt/kiosk on the Pi.
#   sudo /opt/kiosk/scripts/install_kiosk_system.sh
#
# Installs systemd units, USB fstab, display profile, permissions, and enables services.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/kiosk}"
KIOSK_USER="${KIOSK_USER:-rle}"
KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $APP_ROOT/scripts/install_kiosk_system.sh" >&2
  exit 1
fi

echo "==> Hardening script permissions"
/bin/bash "$APP_ROOT/scripts/kiosk_harden_permissions.sh"

echo "==> Internal USB mount (fstab + directories)"
INTERNAL_USB_UUID=""
if [ -f "$APP_ROOT/config/internal_usb.env" ]; then
  # shellcheck disable=SC1090
  source "$APP_ROOT/config/internal_usb.env"
fi
if setup_out="$(/bin/bash "$APP_ROOT/scripts/kiosk_setup_internal_usb.sh" 2>&1)"; then
  echo "$setup_out"
  detected="$(echo "$setup_out" | awk -F= '/^INTERNAL_USB_UUID=/{print $2}')"
  [ -n "$detected" ] && INTERNAL_USB_UUID="$detected"
else
  echo "$setup_out" >&2
  echo "WARN: internal USB setup failed — API will use SD-card fallback paths" >&2
fi
if [ -z "$INTERNAL_USB_UUID" ]; then
  INTERNAL_USB_UUID="D444-057C"
fi

echo "==> Installing systemd units"
mkdir -p "$APP_ROOT/config"
cat >"$APP_ROOT/config/internal_usb.env" <<EOF
INTERNAL_USB_UUID=${INTERNAL_USB_UUID}
INTERNAL_USB_PKNAME=sda
INTERNAL_USB_PARTITION=/dev/sda1
EOF
chmod 644 "$APP_ROOT/config/internal_usb.env"
sed -e "s/INTERNAL_USB_UUIDS=.*/INTERNAL_USB_UUIDS=${INTERNAL_USB_UUID}/" \
    "$APP_ROOT/kiosk-bridge.service" > "/tmp/kiosk-bridge.service"
cp /tmp/kiosk-bridge.service /etc/systemd/system/kiosk-bridge.service
cp "$APP_ROOT/kiosk-display.service" /etc/systemd/system/kiosk-display.service
cp "$APP_ROOT/kiosk-console-vt.service" /etc/systemd/system/kiosk-console-vt.service
cp "$APP_ROOT/kiosk-watchdog.service" /etc/systemd/system/kiosk-watchdog.service
cp "$APP_ROOT/kiosk-watchdog.timer" /etc/systemd/system/kiosk-watchdog.timer

if [ -f "$APP_ROOT/config/99-kiosk-internal-usb.rules" ]; then
  sed "s/ID_FS_UUID}==\"[^\"]*\"/ID_FS_UUID}==\"${INTERNAL_USB_UUID}\"/" \
    "$APP_ROOT/config/99-kiosk-internal-usb.rules" > /tmp/99-kiosk-internal-usb.rules
  cp /tmp/99-kiosk-internal-usb.rules /etc/udev/rules.d/99-kiosk-internal-usb.rules
  udevadm control --reload-rules 2>/dev/null || true
fi
cp "$APP_ROOT/kiosk-internal-usb-mount.service" /etc/systemd/system/kiosk-internal-usb-mount.service

echo "==> User session files ($KIOSK_USER)"
install -o "$KIOSK_USER" -g "$KIOSK_USER" -m 0755 "$APP_ROOT/config/xinitrc" "$KIOSK_HOME/.xinitrc"
install -o "$KIOSK_USER" -g "$KIOSK_USER" -m 0644 /dev/null "$KIOSK_HOME/.bash_profile"
cat >"$KIOSK_HOME/.bash_profile" <<'EOF'
# Display is managed by kiosk-display.service (see /opt/kiosk/scripts/install_kiosk_system.sh).
EOF
chown "$KIOSK_USER:$KIOSK_USER" "$KIOSK_HOME/.bash_profile"

mkdir -p "$KIOSK_HOME/.config/kanshi"
install -o "$KIOSK_USER" -g "$KIOSK_USER" -m 0644 "$APP_ROOT/config/kanshi-config" "$KIOSK_HOME/.config/kanshi/config"

if [ -f "$KIOSK_HOME/.config/labwc/rc.xml" ]; then
  sed -i 's/mapToOutput="HDMI-A-1"/mapToOutput="HDMI-A-2"/g' "$KIOSK_HOME/.config/labwc/rc.xml" || true
fi

echo "==> Disabling console login prompts (kiosk owns tty2; no terminal login on HDMI)"
GETTY_DROPIN="/etc/systemd/system/getty@tty1.service.d"
mkdir -p "$GETTY_DROPIN"
for conf in autologin.conf override.conf; do
  if [ -f "$GETTY_DROPIN/$conf" ]; then
    mv "$GETTY_DROPIN/$conf" "$GETTY_DROPIN/${conf}.disabled"
  fi
done
GETTY_DROPIN_T2="/etc/systemd/system/getty@tty2.service.d"
mkdir -p "$GETTY_DROPIN_T2"
for conf in autologin.conf override.conf; do
  if [ -f "$GETTY_DROPIN_T2/$conf" ]; then
    mv "$GETTY_DROPIN_T2/$conf" "$GETTY_DROPIN_T2/${conf}.disabled"
  fi
done
for tty in 1 2 3 4 5 6; do
  systemctl stop "getty@${tty}.service" 2>/dev/null || true
  systemctl disable "getty@${tty}.service" 2>/dev/null || true
  if ! systemctl mask "getty@${tty}.service" 2>/dev/null; then
    echo "WARN: could not mask getty@${tty}.service" >&2
  fi
done
systemctl daemon-reload

echo "==> RealVNC: share kiosk X display :0"
if [ -f "$APP_ROOT/config/vnc-config.custom" ]; then
  cp "$APP_ROOT/config/vnc-config.custom" /etc/vnc/config.custom
  chmod 644 /etc/vnc/config.custom
fi
if [ -f "$APP_ROOT/config/sudoers-kiosk-vnc" ]; then
  install -m 0440 "$APP_ROOT/config/sudoers-kiosk-vnc" /etc/sudoers.d/kiosk-vnc
fi
# Console desktop (LightDM) conflicts with kiosk-owned :0 — keep disabled.
systemctl disable --now lightdm.service 2>/dev/null || true

echo "==> Enabling services"
systemctl daemon-reload
systemctl enable kiosk-bridge.service kiosk-display.service kiosk-console-vt.service kiosk-watchdog.timer kiosk-internal-usb-mount.service
systemctl restart kiosk-bridge.service
systemctl restart kiosk-display.service
systemctl restart kiosk-console-vt.service
systemctl start kiosk-watchdog.timer

echo "==> Status"
systemctl --no-pager is-active kiosk-bridge.service kiosk-display.service || true
systemctl --no-pager is-enabled kiosk-watchdog.timer || true
findmnt /media/usb_internal 2>/dev/null || echo "(usb_internal not mounted)"
echo "Done. Reboot recommended: sudo reboot"

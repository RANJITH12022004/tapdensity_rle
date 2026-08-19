#!/usr/bin/env bash
# Configure fstab + mount point for the internal pendrive (sda1 by default).
set -euo pipefail

MOUNT_POINT="${INTERNAL_USB_PATH:-/media/usb_internal}"
DEVICE="${INTERNAL_USB_DEVICE:-}"
if [ -z "$DEVICE" ]; then
  for candidate in \
    /dev/disk/by-partlabel/EVMUSB2PD \
    /dev/disk/by-label/EVMUSB2PD \
    /dev/sda1 \
    /dev/disk/by-id/usb-*-0:0-part1; do
    if [ -e "$candidate" ]; then
      DEVICE="$candidate"
      break
    fi
  done
fi

if [ ! -e "$DEVICE" ]; then
  echo "kiosk_setup_internal_usb: WARN no internal USB partition found (skipping fstab update)" >&2
  exit 0
fi

UUID="$(blkid -o value -s UUID "$DEVICE")"
if [ -z "$UUID" ]; then
  echo "kiosk_setup_internal_usb: could not read UUID for $DEVICE" >&2
  exit 1
fi

sudo mkdir -p "$MOUNT_POINT"
sudo chown "${SUDO_USER:-rle}:${SUDO_USER:-rle}" "$MOUNT_POINT" 2>/dev/null || true

FSTAB_MARKER="# kiosk-internal-usb"
FSTAB_LINE="UUID=${UUID}  ${MOUNT_POINT}  vfat  defaults,nofail,uid=1000,gid=1000,dmask=0022,fmask=0133,errors=remount-ro,x-systemd.device-timeout=3  0  2"

if [ -f /etc/fstab ]; then
  sudo cp /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"
  sudo sed -i "\|${MOUNT_POINT}|d" /etc/fstab
  echo "$FSTAB_MARKER" | sudo tee -a /etc/fstab >/dev/null
  echo "$FSTAB_LINE" | sudo tee -a /etc/fstab >/dev/null
fi

sudo mount "$MOUNT_POINT" 2>/dev/null || sudo mount "$DEVICE" "$MOUNT_POINT"
mkdir -p "$MOUNT_POINT/storage" "$MOUNT_POINT/reports" "$MOUNT_POINT/db"

echo "INTERNAL_USB_UUID=$UUID"
echo "Mounted $(findmnt -n -o SOURCE "$MOUNT_POINT") at $MOUNT_POINT"

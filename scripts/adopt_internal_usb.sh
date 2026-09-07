#!/usr/bin/env bash
# Adopt / remount ANY new internal kiosk pendrive in one command.
#
# Usage:
#   sudo mount-internal-usb
#   sudo /opt/kiosk/scripts/adopt_internal_usb.sh
#   sudo /opt/kiosk/scripts/adopt_internal_usb.sh /dev/sdb1   # optional device
#
# What it does:
#   1) Finds the USB partition (arg, or EVMUSB2PD label, or first sd*1)
#   2) Writes UUID into /opt/kiosk/config/internal_usb.env
#   3) Updates /etc/fstab
#   4) Reclaims the stick if udisks mounted it under /media/<user>/...
#   5) Mounts it at /media/usb_internal
#   6) Creates storage/reports/db and migrates SD data if needed
#   7) Restarts kiosk-bridge so the app uses the USB paths
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/kiosk}"
MOUNT_POINT="${INTERNAL_USB_PATH:-/media/usb_internal}"
OWNER_USER="${SUDO_USER:-rle}"
OWNER_GROUP="${SUDO_USER:-rle}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $(basename "$0")" >&2
  exit 1
fi

resolve_device() {
  local candidate=""
  if [ -n "${1:-}" ]; then
    candidate="$1"
    if [ -b "$candidate" ]; then
      readlink -f "$candidate"
      return 0
    fi
    echo "Device not found: $candidate" >&2
    exit 1
  fi

  for candidate in \
      /dev/disk/by-label/EVMUSB2PD \
      /dev/disk/by-partlabel/EVMUSB2PD \
      /dev/sda1 \
      /dev/sdb1 \
      /dev/sdc1; do
    if [ -e "$candidate" ] && [ -b "$candidate" ] || [ -L "$candidate" ]; then
      if [ -b "$candidate" ] || [ -e "$candidate" ]; then
        local real
        real="$(readlink -f "$candidate" 2>/dev/null || echo "$candidate")"
        if [ -b "$real" ]; then
          # Never adopt the OS SD/eMMC.
          case "$real" in
            /dev/mmcblk*) continue ;;
          esac
          echo "$real"
          return 0
        fi
      fi
    fi
  done

  # Fallback: first USB disk partition from lsblk.
  local path=""
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    case "$path" in
      /dev/sd*[0-9]|/dev/vd*[0-9])
        echo "$path"
        return 0
        ;;
    esac
  done < <(lsblk -nr -o PATH,TYPE,TRAN 2>/dev/null | awk '$2=="part" && $3=="usb" {print $1}')

  return 1
}

DEVICE="$(resolve_device "${1:-}" || true)"
if [ -z "${DEVICE:-}" ] || [ ! -b "$DEVICE" ]; then
  echo "No internal USB partition found. Plug the stick in and retry." >&2
  exit 1
fi

# Parent disk name (sda from /dev/sda1)
PKNAME="$(lsblk -no PKNAME "$DEVICE" 2>/dev/null | head -n1 | tr -d '[:space:]')"
if [ -z "$PKNAME" ]; then
  PKNAME="$(basename "$DEVICE" | sed -E 's/[0-9]+$//; s/p[0-9]+$//')"
fi

UUID="$(blkid -o value -s UUID "$DEVICE" 2>/dev/null || true)"
LABEL="$(blkid -o value -s LABEL "$DEVICE" 2>/dev/null || true)"
FSTYPE="$(blkid -o value -s TYPE "$DEVICE" 2>/dev/null || true)"

if [ -z "$UUID" ]; then
  echo "Could not read UUID from $DEVICE (is it formatted FAT32/exFAT?)" >&2
  exit 1
fi

echo "Adopting internal USB:"
echo "  device : $DEVICE"
echo "  disk   : $PKNAME"
echo "  uuid   : $UUID"
echo "  label  : ${LABEL:-"(none)"}"
echo "  fstype : ${FSTYPE:-unknown}"
echo "  mount  : $MOUNT_POINT"

# Persist machine-local identity (do not commit this file to git).
mkdir -p "$APP_ROOT/config"
cat > "$APP_ROOT/config/internal_usb.env" <<EOF
INTERNAL_USB_UUID=$UUID
INTERNAL_USB_PKNAME=$PKNAME
INTERNAL_USB_PARTITION=$DEVICE
EOF
chown "$OWNER_USER:$OWNER_GROUP" "$APP_ROOT/config/internal_usb.env" 2>/dev/null || true
echo "  wrote  : $APP_ROOT/config/internal_usb.env"

# Update fstab for boot mounts.
mkdir -p "$MOUNT_POINT"
chown "$OWNER_USER:$OWNER_GROUP" "$MOUNT_POINT" 2>/dev/null || true
FSTAB_LINE="UUID=${UUID}  ${MOUNT_POINT}  vfat  rw,nofail,uid=1000,gid=1000,fmask=0133,dmask=0022,errors=remount-ro,x-systemd.device-timeout=3  0  2"
cp /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d_%H%M%S)"
# Remove any previous kiosk internal mount lines for this mountpoint.
sed -i "\|[[:space:]]${MOUNT_POINT}[[:space:]]|d" /etc/fstab
sed -i "/^# kiosk-internal-usb$/d" /etc/fstab
{
  echo "# kiosk-internal-usb"
  echo "$FSTAB_LINE"
} >> /etc/fstab
echo "  fstab  : updated"

# If already mounted at the right place with the right UUID, just ensure dirs.
if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
  CUR_SRC="$(findmnt -n -o SOURCE --target "$MOUNT_POINT" 2>/dev/null | head -n1 || true)"
  CUR_UUID="$(findmnt -n -o UUID --target "$MOUNT_POINT" 2>/dev/null | head -n1 || true)"
  if [ "$CUR_UUID" = "$UUID" ] || [ "$CUR_SRC" = "$DEVICE" ]; then
    echo "  already mounted correctly"
  else
    echo "  replacing mount $CUR_SRC -> $DEVICE"
    umount "$MOUNT_POINT" 2>/dev/null || umount -l "$MOUNT_POINT" 2>/dev/null || true
  fi
fi

# Reclaim from udisks auto-mount (e.g. /media/rle/LABEL).
CURRENT_MP="$(findmnt -n -o TARGET --source "$DEVICE" 2>/dev/null | head -n1 || true)"
if [ -n "$CURRENT_MP" ] && [ "$CURRENT_MP" != "$MOUNT_POINT" ]; then
  echo "  reclaim: unmounting $DEVICE from $CURRENT_MP"
  if command -v udisksctl >/dev/null 2>&1; then
    sudo -u "$OWNER_USER" udisksctl unmount -b "$DEVICE" 2>/dev/null || true
  fi
  if findmnt -n --source "$DEVICE" >/dev/null 2>&1; then
    umount "$DEVICE" 2>/dev/null || umount -l "$DEVICE" 2>/dev/null || true
  fi
fi

if ! mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
  mount "$MOUNT_POINT" 2>/dev/null || \
    mount -t vfat -o "rw,nofail,uid=1000,gid=1000,fmask=0133,dmask=0022,errors=remount-ro" \
      "$DEVICE" "$MOUNT_POINT"
fi

if ! mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
  echo "FAILED to mount $DEVICE at $MOUNT_POINT" >&2
  exit 1
fi

STORAGE_DIR="$MOUNT_POINT/storage"
REPORTS_DIR="$MOUNT_POINT/reports"
AUDIT_DB_DIR="$MOUNT_POINT/db"
mkdir -p "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR"
chown -R "$OWNER_USER:$OWNER_GROUP" "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR" 2>/dev/null || true

if [ -x "$APP_ROOT/scripts/migrate_storage_to_internal_usb.sh" ]; then
  INTERNAL_USB_PATH="$MOUNT_POINT" \
  STORAGE_DIR="$STORAGE_DIR" \
  REPORTS_DIR="$REPORTS_DIR" \
  AUDIT_DB_DIR="$AUDIT_DB_DIR" \
  APP_ROOT="$APP_ROOT" \
    bash "$APP_ROOT/scripts/migrate_storage_to_internal_usb.sh" || true
fi

# Pick up new STORAGE_DIR / UUID in the running API.
if command -v systemctl >/dev/null 2>&1; then
  systemctl try-restart kiosk-bridge.service 2>/dev/null || true
fi

echo
echo "OK: internal USB ready"
echo "  $(findmnt -n -o SOURCE,UUID,TARGET --target "$MOUNT_POINT")"
echo
echo "Next export needs a SECOND (external) pendrive — this stick is storage only."

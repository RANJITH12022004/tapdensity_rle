# Kiosk Autostart Setup Instructions

This document describes how to enable automatic startup of the kiosk application on Raspberry Pi boot.

## Prerequisites

- Raspberry Pi with Raspbian OS
- All application files installed in `/opt/kiosk/`
- Python 3 installed
- Chromium browser installed (for kiosk mode)

## Setup Steps

### 1. Copy Systemd Service File

Copy the service file to the systemd directory:

```bash
sudo cp /opt/kiosk/kiosk.service /etc/systemd/system/kiosk.service
```

### 2. Reload Systemd

Reload systemd to recognize the new service:

```bash
sudo systemctl daemon-reload
```

### 3. Enable the Service

Enable the service to start automatically on boot:

```bash
sudo systemctl enable kiosk.service
```

### 4. Start the Service

Start the service immediately (optional, to test without rebooting):

```bash
sudo systemctl start kiosk.service
```

### 5. Verify Service Status

Check if the service is running:

```bash
sudo systemctl status kiosk.service
```

### 6. View Logs

View the application logs:

```bash
tail -f /var/log/kiosk_bridge.log
```

## Service Management Commands

- **Start service**: `sudo systemctl start kiosk.service`
- **Stop service**: `sudo systemctl stop kiosk.service`
- **Restart service**: `sudo systemctl restart kiosk.service`
- **Disable autostart**: `sudo systemctl disable kiosk.service`
- **Check status**: `sudo systemctl status kiosk.service`

## Troubleshooting

### Service fails to start

1. Check logs: `sudo journalctl -u kiosk.service -n 50`
2. Verify file permissions: Ensure `/opt/kiosk/bridge.py` is executable
3. Check Python path: Verify `/usr/bin/python3` exists
4. Check working directory: Ensure `/opt/kiosk/` exists and contains all files

### Chromium not starting in kiosk mode

The `start_kiosk.sh` script attempts to start Chromium, but this may require:
- X server running (if using desktop environment)
- Display manager configured
- User session with display access

For headless operation, you may need to configure X11 forwarding or use a different display method.

### VNC shows "Cannot show desktop"

The kiosk runs Chromium on X display `:0` via `kiosk-display.service`. RealVNC (service mode) must share that same session.

**Cause:** RealVNC on Raspberry Pi OS looks for X on **vt2**. If the kiosk starts X on vt1, VNC connects but cannot show the desktop.

**Fix (included in current install):**

- Kiosk X starts on **vt2** (`/opt/kiosk/scripts/run_kiosk_display.sh`)
- `/etc/vnc/config.custom` sets `display=:0`
- `kiosk_vnc_configure.sh` runs from `.xinitrc` to allow local VNC access and reload the VNC service

Re-apply after updates:

```bash
sudo /opt/kiosk/scripts/install_kiosk_system.sh
sudo systemctl restart kiosk-display.service
sudo vncserver-x11 -service -reload
```

Connect with **RealVNC Viewer** — you should see the same full-screen Chromium kiosk as on the HDMI display.

## Notes

- The service runs as `root` user. For production, consider creating a dedicated `kiosk` user.
- Logs are written to `/var/log/kiosk_bridge.log`
- The service automatically restarts on failure (RestartSec=3)
- Network target ensures network is available before starting

## Desktop client connectivity

PC clients integrate via the desktop API documented in [docs/DESKTOP_CLIENT.md](docs/DESKTOP_CLIENT.md):

- Base URL: `http://<device-ip>:5000/api/desktop/v1`
- Device IP: kiosk **Settings → IP Configure**, or `GET /api/system/network-addresses`
- Auth, report sync, and audit export use the same lockout/audit rules as the kiosk UI


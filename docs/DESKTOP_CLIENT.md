# Tap Density Desktop Client API

The kiosk exposes a desktop integration API under `/api/desktop/v1`. The Flask app registers this blueprint from `bridge.py` alongside the main kiosk routes.

## Base URL

```
http://<device-ip>:5000/api/desktop/v1
```

Discover the device IP from the kiosk **Settings → IP Configure** screen (WLAN/LAN IPv4), or call:

```
GET /api/system/network-addresses
```

(Requires an authenticated kiosk session.)

## Health

```
GET /api/desktop/v1/health
```

Returns device identity (model, serial from factory settings) and service status.

## Authentication

```
POST /api/desktop/v1/auth/login
Content-Type: application/json

{"username": "...", "password": "..."}
```

Lockout and audit behavior matches the kiosk:

- Every wrong password is audited (`attempt 1/3`, `2/3`, `3/3; account locked`).
- Locked accounts stay locked until an admin unlocks them (successful password does not auto-unlock).
- Disabled accounts cannot log in.

Use session headers on subsequent requests (same as kiosk):

- `X-User-Username`
- `X-User-Role`
- `X-User-Name`

```
POST /api/desktop/v1/auth/logout
```

## Reports

List and download reports through the desktop routes registered in `desktop_api/routes.py` (reports sync, PDF/text export). Reports created on the kiosk (test, validation) appear here after save.

## Audit trail

Export audit entries via the desktop audit endpoints. Login, user admin (enable/disable/unlock), power interruption, and report lifecycle events use the same structured audit store as the kiosk UI.

## Real-time (optional)

```
WebSocket ws://<device-ip>:5000/api/desktop/v1/ws
```

Heartbeat/events if the PC client depends on live connectivity.

## Recipe embed ticket

The desktop client can obtain a short-lived embed ticket for recipe UI flows — see `desktop_api/routes.py` for the current ticket/issue endpoints.

## Related kiosk routes

| Purpose | Route |
|---------|-------|
| Kiosk login | `POST /api/data/auth/login` |
| Network addresses | `GET /api/system/network-addresses` |
| Reports | `GET/POST /api/data/reports` |
| Audit log | `GET /api/data/audit-log` |

## Service

The bridge service (`kiosk-bridge.service`) must be running. See [README_AUTOSTART.md](../README_AUTOSTART.md) for autostart setup.

#!/usr/bin/env python3
"""Smoke: profile enable/unlock — no approval, audit logged, session required."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("KIOSK_API_BASE", "http://127.0.0.1:5000")
ADMIN_USER = os.environ.get("SMOKE_ADMIN_USER", "ADMIN")
ADMIN_PASS = os.environ.get("SMOKE_ADMIN_PASS", "Msn@1234")


class SmokeResult:
    def __init__(self) -> None:
        self.passed: list[str] = []
        self.failed: list[str] = []

    def ok(self, msg: str) -> None:
        self.passed.append(msg)
        print("  OK  ", msg)

    def fail(self, msg: str) -> None:
        self.failed.append(msg)
        print("  FAIL", msg)


class Client:
    def __init__(self) -> None:
        self._headers: dict[str, str] = {"Content-Type": "application/json"}

    def request(self, method: str, path: str, body=None) -> tuple[int, dict]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            BASE + path, data=data, headers=dict(self._headers), method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                payload = json.loads(raw.decode("utf-8") or "{}") if raw else {}
                return resp.status, payload
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                payload = json.loads(raw.decode("utf-8") or "{}") if raw else {}
            except json.JSONDecodeError:
                payload = {"error": raw.decode("utf-8", errors="replace")}
            return e.code, payload

    def login(self, username: str, password: str) -> tuple[int, dict]:
        st, data = self.request("POST", "/api/data/auth/login", {"username": username, "password": password})
        if st < 400 and isinstance(data.get("user"), dict):
            user = data["user"]
            if user.get("role"):
                self._headers["X-User-Role"] = str(user["role"])
            if user.get("username"):
                self._headers["X-User-Username"] = str(user["username"])
            if user.get("name"):
                self._headers["X-User-Name"] = str(user["name"])
        return st, data

    def logout(self) -> None:
        self.request("POST", "/api/data/auth/logout", {})
        self._headers = {"Content-Type": "application/json"}


def main() -> int:
    r = SmokeResult()
    c = Client()

    st, login = c.login(ADMIN_USER, ADMIN_PASS)
    if st >= 400 or not login.get("user"):
        r.fail("admin login failed: {}".format(login.get("error") or st))
        return 1
    r.ok("admin login")

    st, members_payload = c.request("GET", "/api/data/members")
    members = members_payload.get("members") or []
    disabled = [m for m in members if str(m.get("status") or "").lower() == "disabled"]
    locked = [m for m in members if str(m.get("status") or "").lower() == "locked"]
    target = disabled[0] if disabled else (locked[0] if locked else None)
    created_disabled = False
    if not target:
        fallback = next((m for m in members if str(m.get("username") or "").upper() == "USER1"), None)
        if not fallback:
            r.fail("no disabled/locked member and no USER1 fallback for enable/unlock test")
            return 1
        st, upd = c.request("DELETE", "/api/data/members/{}".format(fallback["id"]))
        if st >= 400:
            r.fail("could not prepare disabled member for test: {}".format(upd.get("error") or st))
            return 1
        target = dict(fallback)
        target["status"] = "disabled"
        created_disabled = True
        r.ok("prepared USER1 as disabled for smoke test")

    path = "/unlock" if str(target.get("status")).lower() == "locked" else "/enable"
    mid = int(target["id"])
    action = "User unlocked" if path == "/unlock" else "User enabled"

    c.logout()
    st, denied = c.request("POST", "/api/data/members/{}{}".format(mid, path), {})
    if st in (403, 401):
        r.ok("enable/unlock blocked without session (HTTP {})".format(st))
    else:
        r.fail("expected 401/403 without session, got HTTP {}: {}".format(st, denied))

    st, login = c.login(ADMIN_USER, ADMIN_PASS)
    if st >= 400:
        r.fail("re-login failed")
        return 1

    st, body = c.request("POST", "/api/data/members/{}{}".format(mid, path), {})
    if st >= 400 or not body.get("success"):
        r.fail("{} failed: {}".format(path, body.get("error") or st))
    else:
        r.ok("{} succeeded for {}".format(path.lstrip("/"), target.get("username")))

    st, audit = c.request("GET", "/api/data/audit-log")
    entries = audit.get("entries") or []
    found = [
        e for e in entries[:30]
        if (e.get("action") or "") == action and ADMIN_USER.upper() in str(e.get("user") or "").upper()
    ]
    if found:
        r.ok("audit contains '{}' by {}".format(action, ADMIN_USER))
    else:
        r.fail("audit missing recent '{}' entry".format(action))

    c.logout()
    st, cur = c.request("GET", "/api/data/auth/current-user")
    user = cur.get("user")
    if user:
        r.fail("session persisted after logout (user={})".format((user or {}).get("username")))
    else:
        r.ok("session cleared after logout")

    print("\nPassed: {}  Failed: {}".format(len(r.passed), len(r.failed)))
    return 0 if not r.failed else 1


if __name__ == "__main__":
    sys.exit(main())

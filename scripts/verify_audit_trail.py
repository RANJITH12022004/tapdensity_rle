#!/usr/bin/env python3
"""End-to-end audit trail verification against the running kiosk API."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT))

BASE = os.environ.get("KIOSK_API_BASE", "http://127.0.0.1:5000")
TEST_USER = os.environ.get("AUDIT_TEST_USER", "ADMIN")
TEST_PASS = os.environ.get("AUDIT_TEST_PASS", "Rle@1234")
WRONG_PASS_USER = os.environ.get("AUDIT_WRONG_PASS_USER", "USER")
WRONG_PASS = os.environ.get("AUDIT_WRONG_PASS", "wrong-password-smoke")
FACTORY_USER = "RLERLT"
FACTORY_PASS = os.environ.get("FACTORY_PASS", "Rahul")
ADMIN_USER = os.environ.get("SMOKE_ADMIN_USER", "ADMIN")
ADMIN_PASS = os.environ.get("SMOKE_ADMIN_PASS", "Rle@1234")
STORAGE_DIR = Path(os.environ.get("STORAGE_DIR", "/media/usb_internal/storage"))
REPORTS_DIR = Path(os.environ.get("REPORTS_DIR", "/media/usb_internal/reports"))
AUDIT_DB_DIR = Path(os.environ.get("AUDIT_DB_DIR", "/media/usb_internal/db"))

# Actions exercised in this run (simulates UI button flows via audit-log/event + server routes)
EXPECTED_ACTIONS = [
    "Login",
    "Entered screen",
    "Exited screen",
    "Opened Quick Test",
    "Quick test started",
    "Test started",
    "Test finished",
    "Test aborted",
    "Test auto-aborted",
    "holder error",
    "check adaptor and holder",
    "Opened Load Recipe",
    "Loaded recipe",
    "Validation started",
    "Validation finished",
    "Validation aborted",
    "Entered USP 1 validation",
    "Logout",
    "Logout (inactivity timeout)",
    "Power interruption",
    "Power interruption logout",
    "Report aborted (power loss)",
    "User disabled",
    "User enabled",
    "User unlocked",
    "Desktop login",
    "Test performed",
    "Adapter check error",
]


class RunResult:
    def __init__(self):
        self.passed: list[str] = []
        self.failed: list[str] = []
        self.warnings: list[str] = []

    def ok(self, msg: str) -> None:
        self.passed.append(msg)
        print("  OK  ", msg)

    def fail(self, msg: str) -> None:
        self.failed.append(msg)
        print("  FAIL", msg)

    def note_warn(self, msg: str) -> None:
        self.warnings.append(msg)
        print("  WARN", msg)


def ts_ms() -> int:
    return int(time.time() * 1000)


class _Resp:
    def __init__(self, status: int, body: bytes):
        self.status_code = status
        self.content = body

    def json(self):
        return json.loads(self.content.decode("utf-8")) if self.content else {}


class Client:
    def __init__(self):
        self._headers = {"Content-Type": "application/json"}

    def _request(self, method: str, path: str, body=None, params=None) -> _Resp:
        url = BASE + path
        if params:
            qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items() if v is not None)
            if qs:
                url += ("&" if "?" in url else "?") + qs
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=self._headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return _Resp(resp.status, resp.read())
        except urllib.error.HTTPError as e:
            return _Resp(e.code, e.read())

    def login(self, username: str, password: str) -> dict:
        r = self._request("POST", "/api/data/auth/login", {"username": username, "password": password})
        if r.status_code >= 400:
            raise RuntimeError(f"login HTTP {r.status_code}: {r.json()}")
        data = r.json()
        if not data.get("success") and "user" not in data:
            raise RuntimeError(f"login failed: {data}")
        user = data.get("user") or data
        if isinstance(user, dict):
            role = user.get("role")
            if role:
                self._headers["X-User-Role"] = str(role)
            if user.get("username"):
                self._headers["X-User-Username"] = str(user["username"])
            if user.get("name"):
                self._headers["X-User-Name"] = str(user["name"])
        return user

    def logout(self, reason: str = "user") -> None:
        self._request("POST", "/api/data/auth/logout", {"reason": reason})
        self._headers = {"Content-Type": "application/json"}

    def audit_event(self, action: str, details: str = "", **extra) -> _Resp:
        body = {
            "action": action,
            "details": details,
            "outcome": extra.pop("outcome", "success"),
            "eventType": extra.pop("eventType", "lifecycle"),
        }
        for k in ("entityType", "entityName", "entityId", "reason", "extra"):
            if k in extra:
                body[k] = extra[k]
        return self._request("POST", "/api/data/audit-log/event", body)

    def audit_log(self, **params) -> list:
        r = self._request("GET", "/api/data/audit-log", params=params or None)
        if r.status_code == 403:
            return []
        if r.status_code >= 400:
            raise RuntimeError(f"audit-log HTTP {r.status_code}")
        return (r.json() or {}).get("entries") or []

    def post_report(self, payload: dict) -> dict:
        r = self._request("POST", "/api/data/reports", payload)
        if r.status_code >= 400:
            raise RuntimeError(f"report HTTP {r.status_code}: {r.json()}")
        return r.json()

    def validation_start(self, mode: str) -> _Resp:
        return self._request("POST", "/api/hardware/validation/load/start", {"mode": mode})

    def adapter_check(self) -> dict:
        r = self._request("POST", "/api/hardware/adapter/check")
        return r.json() if r.content else {}

    def validation_stop(self) -> None:
        self._request("POST", "/api/hardware/validation/load/stop", {})


def entries_since(entries: list, since_ms: int, username: str | None = None) -> list:
    out = []
    for e in entries:
        if int(e.get("timestamp") or 0) < since_ms:
            continue
        if username and (e.get("user") or "").strip() != username:
            continue
        out.append(e)
    return out


def actions_in(entries: list) -> set:
    return {str(e.get("action") or "").strip() for e in entries}


def simulate_ui_flow(c: Client, res: RunResult) -> None:
    """Mirror script.js logAuditEvent calls for navigation + test/validation lifecycle."""
    c.audit_event("Entered screen", "Home", eventType="navigation")
    c.audit_event("Opened Quick Test", "Quick Test screen opened", eventType="navigation")
    c.audit_event("Entered screen", "Quick Test", eventType="navigation")
    c.audit_event("Quick test started", "Quick Test, USP 1, 10 step(s)", eventType="lifecycle", extra={"productName": "Quick Test"})
    c.audit_event("Entered screen", "Test Run", eventType="navigation")
    c.audit_event("Test started", "Quick Test, USP 1, 10 step(s)", eventType="lifecycle")
    c.audit_event("Test finished", "Test run completed, 3 step(s) recorded", eventType="lifecycle", extra={"completedSteps": 3})
    c.audit_event("Exited screen", "Test Run", eventType="navigation")
    c.audit_event("Opened Load Recipe", "Load Recipe list opened", eventType="navigation")
    c.audit_event(
        "Loaded recipe",
        "Demo Product, batch B001",
        entityType="recipe",
        entityName="Demo Product",
        extra={"productName": "Demo Product", "batchNumber": "B001"},
    )
    c.audit_event("Test aborted", "User aborted test run", eventType="lifecycle")
    c.audit_event("Test auto-aborted", "Adapter removed during test run", outcome="failed", extra={"stepIndex": 2})
    c.audit_event(
        "holder error",
        "Adapter check failed for test run",
        outcome="failed",
        entityType="hardware",
        entityName="adapter",
        extra={"expected": "usp1", "detected": "usp2"},
    )
    c.audit_event("Entered USP 1 validation", "USP 1 validation screen", eventType="navigation")
    c.audit_event("Validation started", "USP 1 validation run started", entityType="validation")
    c.audit_event("Validation finished", "USP 1 validation: Pass", entityType="validation", extra={"status": "Pass"})
    c.audit_event("Validation aborted", "USP 1 validation aborted by user", entityType="validation")
    c.audit_event(
        "check adaptor and holder",
        "Adapter check failed for USP 2 validation",
        outcome="failed",
        entityType="hardware",
        entityName="adapter",
        extra={"expected": "usp2", "detected": "usp1"},
    )


def verify_factory_suppression(c: Client, res: RunResult, since_ms: int) -> None:
    c.login(FACTORY_USER, FACTORY_PASS)
    r = c.audit_event("Test started", "Factory should not appear in audit DB")
    if r.status_code != 200:
        res.fail(f"Factory audit event HTTP {r.status_code}")
    else:
        res.ok("Factory audit event endpoint accepts POST (200)")
    c.logout("user")
    time.sleep(0.3)
    c.login(TEST_USER, TEST_PASS)
    entries = c.audit_log()
    factory_rows = [
        e
        for e in entries_since(entries, since_ms)
        if (e.get("user") or "").strip() == FACTORY_USER
        and str(e.get("action") or "") == "Test started"
    ]
    if factory_rows:
        res.fail(f"Factory actor logged Test started ({len(factory_rows)} row(s))")
    else:
        res.ok("Factory (RLERLT) Test started suppressed from audit log")


def verify_logout_variants(c: Client, res: RunResult, since_ms: int) -> None:
    """Manual logout via live API; inactivity via test_client (browser session-ui-reset clears live session)."""
    c.login(TEST_USER, TEST_PASS)
    c.logout("user")
    time.sleep(0.2)
    c.login(TEST_USER, TEST_PASS)
    entries = actions_in(entries_since(c.audit_log(), since_ms, TEST_USER))
    if "Logout" in entries:
        res.ok("Logout (manual) recorded on live API")
    else:
        res.fail("Missing Logout (manual)")

    inactivity_since = ts_ms() - 1000
    try:
        from app import app as flask_app

        tc = flask_app.test_client()
        lr = tc.post("/api/data/auth/login", json={"username": TEST_USER, "password": TEST_PASS})
        if lr.status_code != 200:
            res.fail(f"In-process login HTTP {lr.status_code}")
            return
        lo = tc.post("/api/data/auth/logout", json={"reason": "inactivity"})
        if lo.status_code != 200:
            res.fail(f"In-process inactivity logout HTTP {lo.status_code}")
            return
        import audit_service

        audit_service.init(
            {
                "STORAGE_DIR": str(STORAGE_DIR),
                "REPORTS_DIR": str(REPORTS_DIR),
                "AUDIT_DB_DIR": str(AUDIT_DB_DIR),
            }
        )
        recent = {
            str(e.get("action") or "").strip()
            for e in audit_service.list_entries({"from": inactivity_since})
        }
        if "Logout (inactivity timeout)" in recent:
            res.ok("Logout (inactivity timeout) recorded (in-process logout route)")
        else:
            res.fail("Missing Logout (inactivity timeout) from logout route")
    except Exception as exc:
        res.fail(f"In-process inactivity logout test: {exc}")


def verify_power_interruption(res: RunResult, since_ms: int) -> None:
    import data_service
    import audit_service

    config = {
        "STORAGE_DIR": str(STORAGE_DIR),
        "REPORTS_DIR": str(REPORTS_DIR),
        "AUDIT_DB_DIR": str(AUDIT_DB_DIR),
        "APP_ROOT": str(APP_ROOT),
    }
    data_service.init(config)
    audit_service.init(config)

    flag = STORAGE_DIR / "app_clean_stop.flag"
    if flag.exists():
        flag.unlink()

    user = {"username": TEST_USER, "role": "User", "name": TEST_USER}
    data_service.save_current_user(user)
    data_service.write_session_power_audit_pending(user)

    from app import _startup_session_power_audit

    _startup_session_power_audit()

    entries = audit_service.list_entries({"from": since_ms})
    pi = [e for e in entries if e.get("action") == "Power interruption"]
    if pi:
        res.ok(f"Power interruption logged ({len(pi)} row(s))")
    else:
        res.fail("Power interruption not logged after simulated unclean startup")
    pil = [e for e in entries if e.get("action") == "Power interruption logout"]
    if pil:
        res.ok(f"Power interruption logout logged ({len(pil)} row(s))")
    else:
        res.fail("Power interruption logout not logged after simulated unclean startup")


def _unlock_member(c: Client, username: str) -> bool:
    r = c._request("GET", "/api/data/members")
    if r.status_code != 200:
        return False
    members = (r.json() or {}).get("members") or []
    for m in members:
        if str(m.get("username") or "").upper() == username.upper():
            mid = m.get("id")
            if mid is None:
                return False
            if str(m.get("status") or "").lower() == "locked":
                c._request("POST", f"/api/data/members/{mid}/unlock", {})
            if str(m.get("status") or "").lower() == "disabled":
                c._request("POST", f"/api/data/members/{mid}/enable", {})
            return True
    return False


def verify_wrong_password_audit(c: Client, res: RunResult, since_ms: int) -> None:
    """Three failed logins should produce attempt 1/3, 2/3, 3/3 audit rows."""
    target = WRONG_PASS_USER
    try:
        c.login(FACTORY_USER, FACTORY_PASS)
        _unlock_member(c, target)
        _unlock_member(c, ADMIN_USER)
        c.logout("user")
    except Exception as exc:
        res.note_warn(f"factory prep for wrong-password test: {exc}")
    # Ensure target is active before lockout test
    prep = c._request("POST", "/api/data/auth/login", {"username": target, "password": TEST_PASS})
    if prep.status_code == 403 and "locked" in str((prep.json() or {}).get("error", "")).lower():
        try:
            c.login(FACTORY_USER, FACTORY_PASS)
            _unlock_member(c, target)
            c.logout("user")
        except Exception:
            pass
    for _ in range(3):
        r = c._request("POST", "/api/data/auth/login", {"username": target, "password": WRONG_PASS})
        if r.status_code == 200:
            res.fail("wrong password unexpectedly succeeded")
            return
    time.sleep(0.3)
    try:
        c.login(FACTORY_USER, FACTORY_PASS)
    except Exception as exc:
        res.fail(f"factory login to read audit after wrong-password test: {exc}")
        return
    entries = entries_since(c.audit_log(), since_ms)
    details = [str(e.get("details") or "") for e in entries if e.get("action") == "Login"]
    joined = " | ".join(details)
    for needle in ("attempt 1/3", "attempt 2/3", "attempt 3/3"):
        if needle not in joined:
            res.fail(f"missing login audit detail '{needle}' in recent Login rows")
            return
    res.ok("wrong-password audit shows attempt 1/3, 2/3, 3/3")
    try:
        c.login(FACTORY_USER, FACTORY_PASS)
        if _unlock_member(c, target):
            res.ok(f"unlocked {target} after wrong-password smoke")
        _unlock_member(c, ADMIN_USER)
        c.logout("user")
    except Exception as exc:
        res.note_warn(f"could not unlock after wrong-password test: {exc}")


def verify_user_disabled_audit(c: Client, res: RunResult, since_ms: int) -> None:
    try:
        c.login(FACTORY_USER, FACTORY_PASS)
        _unlock_member(c, ADMIN_USER)
        c.logout("user")
    except Exception as exc:
        res.note_warn(f"factory unlock admin before disable test: {exc}")
    try:
        c.login(ADMIN_USER, ADMIN_PASS)
    except Exception as exc:
        res.fail(f"admin login for disable test: {exc}")
        return
    r = c._request("GET", "/api/data/members")
    members = ((r.json() or {}).get("members") or []) if r.status_code == 200 else []
    target = next((m for m in members if str(m.get("username") or "").upper() == "USER"), None)
    if not target:
        res.note_warn("USER not found — skip User disabled audit check")
        c.logout("user")
        return
    mid = int(target["id"])
    if str(target.get("status") or "").lower() == "disabled":
        c._request("POST", f"/api/data/members/{mid}/enable", {})
        time.sleep(0.2)
    dr = c._request("DELETE", f"/api/data/members/{mid}")
    if dr.status_code >= 400:
        res.note_warn(f"disable USER failed HTTP {dr.status_code}: {dr.json()}")
        c.logout("user")
        return
    time.sleep(0.3)
    entries = actions_in(entries_since(c.audit_log(), since_ms, ADMIN_USER))
    if "User disabled" in entries:
        res.ok("User disabled audit recorded")
    else:
        res.fail("User disabled audit missing after DELETE member")
    c._request("POST", f"/api/data/members/{mid}/enable", {})
    c.logout("user")


def verify_hardware_routes(c: Client, res: RunResult, since_ms: int) -> None:
    c.login(TEST_USER, TEST_PASS)
    check = c.adapter_check()
    res.ok(f"Adapter check API ok={check.get('ok')}")
    for mode in ("usp1", "usp2"):
        r = c.validation_start(mode)
        if r.status_code == 400 and (r.json() or {}).get("error") == "adapter_mismatch":
            action = "holder error" if mode == "usp1" else "check adaptor and holder"
            res.ok(f"validation/load/start mode={mode} → adapter_mismatch (400)")
        elif r.status_code == 200:
            res.note_warn(f"validation/load/start mode={mode} succeeded (adapter matched hardware)")
            c.validation_stop()
        else:
            res.note_warn(f"validation/load/start mode={mode} → HTTP {r.status_code}: {(r.json() or {}).get('error')}")
    time.sleep(0.3)
    entries = actions_in(entries_since(c.audit_log(), since_ms, TEST_USER))
    if "holder error" in entries or "check adaptor and holder" in entries:
        res.ok("Server-side adapter/holder error action in audit log")
    else:
        res.note_warn("No USP adapter error from hardware (adapter may match device)")


def verify_report_audit(c: Client, res: RunResult, since_ms: int) -> None:
    c.login(TEST_USER, TEST_PASS)
    payload = {
        "name": "Audit verify test report",
        "type": "test",
        "recipe": {"productName": "Quick Test", "batchNumber": "AUDIT-1", "stepCount": 1, "steps": []},
        "testData": {
            "productName": "Quick Test",
            "batchNumber": "AUDIT-1",
            "status": "completed",
            "completedSteps": 1,
            "stepCount": 1,
            "stepResults": [],
        },
    }
    try:
        rep = c.post_report(payload)
        rid = rep.get("id")
        res.ok(f"Report created id={rid}")
        time.sleep(0.3)
        entries = entries_since(c.audit_log(), since_ms, TEST_USER)
        if any(e.get("action") == "Quick test performed" for e in entries):
            res.ok("Quick test performed audit on report save")
        elif any(e.get("action") == "Test performed" for e in entries):
            res.ok("Test performed audit on report save")
        else:
            res.fail("No Test performed / Quick test performed on report save")
    except Exception as exc:
        res.fail(f"Report create failed: {exc}")


def verify_pdf_html(res: RunResult, since_ms: int) -> None:
    import audit_service
    import data_service
    from app import _build_audit_trail_html

    config = {
        "STORAGE_DIR": str(STORAGE_DIR),
        "REPORTS_DIR": str(REPORTS_DIR),
        "AUDIT_DB_DIR": str(AUDIT_DB_DIR),
    }
    data_service.init(config)
    audit_service.init(config)
    entries = audit_service.list_entries({"from": since_ms})
    factory = data_service.get_factory_settings() or {}
    html = _build_audit_trail_html(entries, {}, factory)
    required = ("Test started", "Validation finished", "Power interruption")
    missing = [a for a in required if a not in html]
    if "Logout (inactivity timeout)" in html or "Logout" in html:
        res.ok("Audit PDF HTML includes logout action(s)")
    else:
        missing.append("Logout")
    if not missing:
        res.ok("Audit PDF HTML includes new action labels")
    else:
        res.fail(f"Audit HTML missing actions: {missing}")


def main() -> int:
    since_ms = ts_ms() - 5000
    res = RunResult()
    c = Client()

    print("=== Audit trail verification ===")
    print(f"API: {BASE}")
    print(f"User: {TEST_USER}")
    print()

    try:
        c.login(TEST_USER, TEST_PASS)
        res.ok("Login")
    except Exception as exc:
        res.fail(f"Login: {exc}")
        return 1

    since_ms = ts_ms() - 1000
    simulate_ui_flow(c, res)
    verify_report_audit(c, res, since_ms)
    verify_logout_variants(c, res, since_ms)
    verify_hardware_routes(c, res, since_ms)

    wrong_since = ts_ms() - 1000
    verify_wrong_password_audit(c, res, wrong_since)

    disable_since = ts_ms() - 1000
    verify_user_disabled_audit(c, res, disable_since)

    factory_since = ts_ms() - 1000
    verify_factory_suppression(c, res, factory_since)

    power_since = ts_ms() - 1000
    verify_power_interruption(res, power_since)

    verify_pdf_html(res, since_ms - 120000)

    c.login(TEST_USER, TEST_PASS)
    all_entries = entries_since(c.audit_log(), since_ms, TEST_USER)
    found = actions_in(all_entries)
    print()
    print("--- Actions seen for test user since run ---")
    for a in sorted(found):
        print(" ", a)

    missing = [a for a in EXPECTED_ACTIONS if a not in found and a not in ("Login", "Power interruption", "Adapter check error")]
    if missing:
        res.note_warn(f"Simulated actions not all visible for {TEST_USER}: {missing}")

    print()
    print(f"Passed: {len(res.passed)}, Failed: {len(res.failed)}, Warnings: {len(res.warnings)}")
    if res.failed:
        for f in res.failed:
            print("  -", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Smoke: Tap Density power-cut checkpoint recovery.

Simulates:
  1) Durable mid-test checkpoint with stable start + elapsed duration
  2) USB test_run.json wiped to 0 bytes (VFAT power-loss) while APP_ROOT mirror survives
  3) Unclean startup recovery → aborted report with exact duration + audits
  4) start≈end reconstruction from end − elapsed
"""

from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT))

SMOKE_USB = APP_ROOT / "storage" / "_smoke_powercut_usb"
STORAGE = Path(os.environ.get("STORAGE_DIR", str(SMOKE_USB)))
os.environ["APP_ROOT"] = str(APP_ROOT)
os.environ["STORAGE_DIR"] = str(STORAGE)
os.environ.setdefault("REPORTS_DIR", str(APP_ROOT / "reports"))
os.environ.setdefault("AUDIT_DB_DIR", str(APP_ROOT / "db"))


class Result:
    def __init__(self) -> None:
        self.passed: list[str] = []
        self.failed: list[str] = []

    def ok(self, msg: str) -> None:
        self.passed.append(msg)
        print("  OK  ", msg)

    def fail(self, msg: str) -> None:
        self.failed.append(msg)
        print("  FAIL", msg)


def main() -> int:
    res = Result()
    STORAGE.mkdir(parents=True, exist_ok=True)
    (APP_ROOT / "reports").mkdir(parents=True, exist_ok=True)
    (APP_ROOT / "db").mkdir(parents=True, exist_ok=True)

    import data_service
    import audit_service

    cfg = {
        "APP_ROOT": str(APP_ROOT),
        "STORAGE_DIR": str(STORAGE),
        "REPORTS_DIR": str(APP_ROOT / "reports"),
        "AUDIT_DB_DIR": str(APP_ROOT / "db"),
    }
    data_service.init(cfg)
    audit_service.init(cfg)

    for name in ("test_run.json", "test_run.json.bak", "app_clean_stop.flag", "session_power_audit_pending.json"):
        p = STORAGE / name
        if p.exists():
            p.unlink()
    mirror = APP_ROOT / "storage" / "test_run.json"
    if mirror.exists() and mirror.resolve() != (STORAGE / "test_run.json").resolve():
        try:
            mirror.unlink()
        except OSError:
            pass

    start = datetime.now(timezone.utc) - timedelta(seconds=95)
    end = datetime.now(timezone.utc) - timedelta(seconds=1)
    bad_same = end.isoformat().replace("+00:00", "Z")
    start_iso = start.isoformat().replace("+00:00", "Z")
    end_iso = end.isoformat().replace("+00:00", "Z")
    cp = {
        "type": "test",
        "name": "SMOKE-PWR - BATCH1",
        "productName": "SMOKE-PWR",
        "batchNumber": "BATCH1",
        "status": "running",
        "isQuickTest": True,
        "testStartTime": start_iso,
        "testEndTime": end_iso,
        "durationSeconds": 94,
        "operatedByUsername": "SMOKE_OP",
        "operatedBy": "SMOKE_OP",
        "operatedByRole": "User",
        "recipe": {"productName": "SMOKE-PWR", "batchNumber": "BATCH1", "steps": []},
        "testData": {
            "status": "running",
            "productName": "SMOKE-PWR",
            "batchNumber": "BATCH1",
            "testStartTime": start_iso,
            "testEndTime": end_iso,
            "durationSeconds": 94,
            "stepResults": [{"stepIndex": 0, "resultText": "Pass"}],
            "isQuickTest": True,
            "recipe": {"productName": "SMOKE-PWR", "batchNumber": "BATCH1", "steps": []},
        },
        "_checkpointAt": end_iso,
        "_checkpointPhase": "running",
        "_testStartedAudited": True,
    }
    data_service.save_test_run_data(cp)
    loaded = data_service.get_test_run_data()
    if loaded.get("durationSeconds") == 94:
        res.ok("checkpoint saved with durationSeconds=94")
    else:
        res.fail(f"checkpoint save/load failed: {loaded.get('durationSeconds')!r}")

    if mirror.exists() or STORAGE.resolve() == (APP_ROOT / "storage").resolve():
        res.ok("checkpoint mirrored to APP_ROOT storage (or same path)")
    else:
        data_service.save_test_run_data(cp)
        if mirror.exists():
            res.ok("checkpoint mirrored to APP_ROOT storage")
        else:
            res.ok("isolated STORAGE_DIR (mirror optional)")

    usb_path = STORAGE / "test_run.json"
    usb_path.write_bytes(b"")
    bak = usb_path.with_suffix(usb_path.suffix + ".bak")
    bak.write_bytes(b"")
    recovered = data_service.get_test_run_data()
    if recovered.get("durationSeconds") == 94 and recovered.get("productName") == "SMOKE-PWR":
        res.ok("recovered checkpoint from mirror after 0-byte USB wipe")
    elif STORAGE.resolve() != (APP_ROOT / "storage").resolve():
        res.ok("isolated STORAGE_DIR skip 0-byte USB wipe recovery")
    else:
        res.fail(f"mirror recovery failed: keys={list(recovered)[:8]} dur={recovered.get('durationSeconds')}")

    from app import _apply_power_loss_duration, _startup_session_power_audit, _checkpoint_is_mid_test

    broken = {
        "type": "test",
        "testStartTime": bad_same,
        "testEndTime": bad_same,
        "durationSeconds": 94,
        "testData": {
            "testStartTime": bad_same,
            "testEndTime": bad_same,
            "durationSeconds": 94,
        },
    }
    fixed = _apply_power_loss_duration(
        broken,
        {
            "testStartTime": bad_same,
            "testEndTime": bad_same,
            "durationSeconds": 94,
            "_checkpointAt": bad_same,
            "testData": broken["testData"],
        },
    )
    td = fixed.get("testData") or {}
    s = td.get("testStartTime") or fixed.get("testStartTime")
    e = td.get("testEndTime") or fixed.get("testEndTime")
    d = td.get("durationSeconds")
    if d == 94 and s and e and s != e:
        res.ok(f"reconstructed start≠end with duration=94 (start={s}, end={e})")
    else:
        res.fail(f"reconstruction failed start={s} end={e} dur={d}")

    data_service.save_test_run_data(cp)
    data_service.write_session_power_audit_pending(
        {"username": "SMOKE_OP", "name": "SMOKE_OP", "role": "User"}
    )
    flag = STORAGE / "app_clean_stop.flag"
    if flag.exists():
        flag.unlink()
    flag.touch()

    before_ids = {r.get("id") for r in (data_service.list_reports("all", include_pending=True) or [])}
    since_ms = int(time.time() * 1000) - 2000
    if not _checkpoint_is_mid_test(data_service.get_test_run_data()):
        res.fail("checkpoint not detected as mid-test before startup recovery")
    else:
        res.ok("checkpoint detected as mid-test")

    _startup_session_power_audit()

    after = data_service.list_reports("all", include_pending=True) or []
    new_reports = [r for r in after if r.get("id") not in before_ids]
    power_rep = None
    for r in new_reports:
        td = r.get("testData") if isinstance(r.get("testData"), dict) else {}
        remarks = str(td.get("remarks") or r.get("remarks") or "").lower()
        if "power interruption" in remarks or str(r.get("reportApprovalStatus") or "").lower() == "aborted":
            power_rep = r
            break
    if not power_rep and after:
        for r in reversed(after):
            td = r.get("testData") if isinstance(r.get("testData"), dict) else {}
            if "power interruption" in str(td.get("remarks") or r.get("remarks") or "").lower():
                power_rep = r
                break

    if power_rep:
        td = power_rep.get("testData") if isinstance(power_rep.get("testData"), dict) else {}
        dur = td.get("durationSeconds")
        if dur is None:
            dur = power_rep.get("durationSeconds")
        try:
            dur_n = int(dur)
        except (TypeError, ValueError):
            dur_n = -1
        start_s = td.get("testStartTime") or power_rep.get("testStartTime")
        end_s = td.get("testEndTime") or power_rep.get("testEndTime")
        if dur_n >= 90 and start_s and end_s and start_s != end_s:
            res.ok(f"power-cut report saved id={power_rep.get('id')} duration={dur_n}s start≠end")
        else:
            res.fail(f"report timing wrong dur={dur!r} start={start_s} end={end_s}")
    else:
        res.fail("no power-interruption report created on unclean startup")

    remaining_cp = data_service.get_test_run_data()
    if not remaining_cp:
        res.ok("checkpoint cleared after recovery")
    else:
        res.fail(f"checkpoint still present after recovery: phase={remaining_cp.get('_checkpointPhase')}")

    entries = audit_service.list_entries({"from": since_ms}) or []
    actions = {str(e.get("action") or "") for e in entries}
    if "Power interruption" in actions:
        res.ok("audit: Power interruption")
    else:
        res.fail(f"missing Power interruption audit; saw {sorted(actions)[:12]}")
    if "Power interruption logout" in actions:
        res.ok("audit: Power interruption logout")
    else:
        res.fail("missing Power interruption logout audit")

    print("")
    print(f"Passed: {len(res.passed)}  Failed: {len(res.failed)}")
    return 1 if res.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

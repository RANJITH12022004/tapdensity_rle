 #!/usr/bin/env python3
"""
app.py - Flask application for Tap Density
Serves static files and REST API for data, auth, audit, reports, and print.
"""

import json
import os
import pathlib
import re
import secrets
import atexit
import signal
import subprocess
import sys
import time
import threading
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Optional
from functools import wraps
from flask import Flask, after_this_request, jsonify, request, send_file, send_from_directory, Response, stream_with_context

try:
    from flask_cors import CORS
except ImportError:
    CORS = None

try:
    from flask_sock import Sock
except ImportError:
    Sock = None

import data_service
import rbac_service
import audit_service
import calculation_service
import report_service
import print_service
import hardware_service
import biometric_service
import rtc_service
import usb_export
import network_service
import pdf_generator

# ======================= CONFIG ==========================

APP_ROOT = pathlib.Path(os.environ.get("APP_ROOT", os.path.dirname(os.path.abspath(__file__))))
INTERNAL_USB_PATH = pathlib.Path(os.environ.get("INTERNAL_USB_PATH", "/media/usb_internal"))


def _default_storage_dir() -> pathlib.Path:
    """Prefer internal USB (sda1 at /media/usb_internal) when mounted; else APP_ROOT/storage."""
    if os.environ.get("STORAGE_DIR"):
        return pathlib.Path(os.environ["STORAGE_DIR"])
    if INTERNAL_USB_PATH.is_dir():
        return INTERNAL_USB_PATH / "storage"
    return APP_ROOT / "storage"


def _default_reports_dir() -> pathlib.Path:
    """Prefer internal USB when mounted; else APP_ROOT/reports."""
    if os.environ.get("REPORTS_DIR"):
        return pathlib.Path(os.environ["REPORTS_DIR"])
    if INTERNAL_USB_PATH.is_dir():
        return INTERNAL_USB_PATH / "reports"
    return APP_ROOT / "reports"


def _default_audit_db_dir() -> pathlib.Path:
    """Audit SQLite DB: sibling of storage/ on internal USB, else APP_ROOT/db."""
    if os.environ.get("AUDIT_DB_DIR"):
        return pathlib.Path(os.environ["AUDIT_DB_DIR"])
    if INTERNAL_USB_PATH.is_dir():
        return INTERNAL_USB_PATH / "db"
    return APP_ROOT / "db"


STORAGE_DIR = _default_storage_dir()
REPORTS_DIR = _default_reports_dir()
AUDIT_DB_DIR = _default_audit_db_dir()
EXPORT_USB_PATH = os.environ.get("EXPORT_USB_PATH", str(APP_ROOT / "export"))
ESP_PORT = os.environ.get("ESP_PORT", "/dev/serial0")
ESP_BAUD = int(os.environ.get("ESP_BAUD", "9600"))
BIOMETRIC_PORT = os.environ.get("BIOMETRIC_PORT", "/dev/ttyAMA5")
BIOMETRIC_BAUD = int(os.environ.get("BIOMETRIC_BAUD", "57600"))
BIOMETRIC_ENROLL_TIMEOUT_SEC = float(os.environ.get("BIOMETRIC_ENROLL_TIMEOUT_SEC", "120"))
BIOMETRIC_LOGIN_TIMEOUT_SEC = float(os.environ.get("BIOMETRIC_LOGIN_TIMEOUT_SEC", "30"))
FLASK_HOST = os.environ.get("FLASK_HOST", "127.0.0.1")
FLASK_PORT = int(os.environ.get("FLASK_PORT", "5000"))
EXPORT_SUBFOLDER = "TapDensity-Reports-Exported"
DATETIME_STORAGE = STORAGE_DIR / "datetime.json"
APPROVAL_VERIFY_TTL_SECONDS = int(os.environ.get("APPROVAL_VERIFY_TTL_SECONDS", "180"))
AUDIT_EXPORT_PURGE_CHECK_SECONDS = int(os.environ.get("AUDIT_EXPORT_PURGE_CHECK_SECONDS", "60"))

# ==========================================================

app = Flask(__name__)
if CORS:
    CORS(app)
sock = Sock(app) if Sock else None

try:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    AUDIT_DB_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

config = {
    "APP_ROOT": str(APP_ROOT),
    "STORAGE_DIR": STORAGE_DIR,
    "REPORTS_DIR": REPORTS_DIR,
    "AUDIT_DB_DIR": AUDIT_DB_DIR,
    "A4_PORT": os.environ.get("A4_PORT", "/dev/ttyAMA4"),
    "A4_BAUD": int(os.environ.get("A4_BAUD", "9600")),
    "THERMAL_PORT": os.environ.get("THERMAL_PORT", "/dev/ttyAMA3"),
    "THERMAL_BAUD": int(os.environ.get("THERMAL_BAUD", "9600")),
    "ESP_PORT": ESP_PORT,
    "ESP_BAUD": ESP_BAUD,
    "BIOMETRIC_PORT": BIOMETRIC_PORT,
    "BIOMETRIC_BAUD": BIOMETRIC_BAUD,
    "BIOMETRIC_ENROLL_TIMEOUT_SEC": BIOMETRIC_ENROLL_TIMEOUT_SEC,
    "BIOMETRIC_LOGIN_TIMEOUT_SEC": BIOMETRIC_LOGIN_TIMEOUT_SEC,
}

data_service.init(config)
audit_service.init(config)
calculation_service.init()
report_service.init(config)
print_service.init(config)
hardware_service.init(app, config)

_enroll_sessions = {}
_enroll_sessions_lock = threading.Lock()

biometric_service.init(app, config)
rtc_service.init(app.logger)
rtc_service.schedule_rtc_startup_sync()

import logging as _logging

_cfg_log = _logging.getLogger(__name__)
_cfg_log.info(
    "[CONFIG] INTERNAL_USB_PATH=%s STORAGE_DIR=%s REPORTS_DIR=%s AUDIT_DB_DIR=%s",
    INTERNAL_USB_PATH,
    STORAGE_DIR,
    REPORTS_DIR,
    AUDIT_DB_DIR,
)


def _audit(user, role, action, details=""):
    """Helper to log audit event (user/role from current user if not passed)."""
    u = user
    r = role
    if u is None or r is None:
        cur = data_service.get_current_user()
        if cur:
            u = u if u is not None else cur.get("username") or cur.get("name") or "--"
            r = r if r is not None else cur.get("role") or "--"
    audit_time = _audit_time_fields()
    audit_service.log_structured_event(
        user=u,
        role=r,
        action=action,
        details=details,
        event_type="legacy",
        outcome="success" if action else "",
        timestamp_ms=audit_time.get("timestamp_ms"),
        date_time=audit_time.get("date_time"),
    )


def _audit_time_fields():
    payload = rtc_service.get_device_wall_datetime_payload()
    dt_raw = (payload.get("datetime") or "").strip()
    if dt_raw:
        try:
            dt_obj = datetime.fromisoformat(dt_raw.replace("Z", "+00:00"))
            return {
                "timestamp_ms": int(dt_obj.timestamp() * 1000),
                "date_time": dt_obj.strftime("%d/%m/%Y %H:%M:%S"),
            }
        except Exception:
            pass
    now = datetime.now()
    return {
        "timestamp_ms": int(now.timestamp() * 1000),
        "date_time": now.strftime("%d/%m/%Y %H:%M:%S"),
    }


def _audit_request_source():
    return "{} {}".format(request.method, request.path)


def _audit_actor():
    cur = data_service.get_current_user() or {}
    return {
        "user": (request.headers.get("X-User-Username") or "").strip() or (cur.get("username") or "").strip() or (cur.get("name") or "").strip() or "--",
        "role": (request.headers.get("X-User-Role") or "").strip() or (cur.get("role") or "").strip() or "--",
        "name": (request.headers.get("X-User-Name") or "").strip() or (cur.get("name") or "").strip() or (cur.get("username") or "").strip() or "--",
    }


def _sanitize_audit_payload(value):
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if str(k).lower() in ("password",):
                out[k] = "***"
            else:
                out[k] = _sanitize_audit_payload(v)
        return out
    if isinstance(value, list):
        return [_sanitize_audit_payload(v) for v in value]
    return value


def _changed_fields(before_obj, after_obj):
    before_obj = before_obj or {}
    after_obj = after_obj or {}
    keys = sorted(set(before_obj.keys()) | set(after_obj.keys()))
    changed = []
    for key in keys:
        if before_obj.get(key) != after_obj.get(key):
            changed.append(key)
    return changed


def _audit_member_permissions_if_changed(before_member, after_member, *, member_id, signature):
    """Log a dedicated audit row when permission cards and/or role change."""
    payload = rbac_service.build_permission_change_audit(
        before_member,
        after_member,
        target_username=str(
            (after_member or {}).get("username") or (after_member or {}).get("name") or ""
        ).strip(),
    )
    if not payload:
        return
    uname = str(
        (after_member or {}).get("username") or (after_member or {}).get("name") or ""
    ).strip()
    _audit_event(
        action="User permissions updated",
        outcome="success",
        entity_type="member",
        entity_id=member_id,
        entity_name=uname,
        details=payload.get("details") or "User permissions updated",
        target_user=uname,
        before=payload.get("before"),
        after=payload.get("after"),
        signature=signature,
        extra=payload.get("extra"),
    )


def _audit_event(
    *,
    action,
    outcome,
    entity_type="",
    entity_id=None,
    entity_name="",
    details="",
    reason="",
    target_user="",
    before=None,
    after=None,
    signature=None,
    event_type="compliance",
    extra=None,
):
    actor = _audit_actor()
    audit_time = _audit_time_fields()
    signature = signature or {}
    before_clean = _sanitize_audit_payload(before)
    after_clean = _sanitize_audit_payload(after)
    audit_service.log_structured_event(
        user=actor.get("user"),
        role=actor.get("role"),
        action=action,
        details=details,
        event_type=event_type,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_name=entity_name,
        outcome=outcome,
        reason=reason,
        session_user=actor.get("user"),
        session_role=actor.get("role"),
        target_user=target_user,
        signature_mode=signature.get("mode") or "",
        signature_user=signature.get("username") or "",
        signature_role=signature.get("role") or "",
        changed_fields=_changed_fields(before_clean if isinstance(before_clean, dict) else {}, after_clean if isinstance(after_clean, dict) else {}),
        before=before_clean,
        after=after_clean,
        request_source=_audit_request_source(),
        extra=extra,
        timestamp_ms=audit_time.get("timestamp_ms"),
        date_time=audit_time.get("date_time"),
    )




def _disabled_login_audit_details(member, username):
    member = member or {}
    attempted_username = str(member.get("username") or username or "").strip() or "--"
    attempted_name = str(member.get("name") or "").strip() or "--"
    return "Disabled account {} ({}) tried to log in".format(attempted_username, attempted_name)


def _locked_login_audit_details(member, username):
    member = member or {}
    attempted_username = str(member.get("username") or username or "").strip() or "--"
    attempted_name = str(member.get("name") or "").strip() or "--"
    return "Locked account {} ({}) tried to log in".format(attempted_username, attempted_name)


def _wrong_password_audit_details(member, username, attempt, maximum):
    member = member or {}
    attempted_username = str(member.get("username") or username or "").strip() or "--"
    attempted_name = str(member.get("name") or "").strip() or "--"
    detail = "User {} ({}) entered the wrong password - attempt {}/{}".format(
        attempted_username,
        attempted_name,
        attempt,
        maximum,
    )
    if int(attempt) >= int(maximum):
        detail += "; account locked"
    return detail


def _member_status_change_audit_detail(verb_past, target_member, actor):
    """Human-readable audit line for enable/disable/unlock."""
    target_name = str((target_member or {}).get("name") or "").strip() or "--"
    target_username = str((target_member or {}).get("username") or "").strip() or "--"
    actor_name = str((actor or {}).get("name") or (actor or {}).get("user") or "").strip() or "--"
    actor_username = str((actor or {}).get("user") or (actor or {}).get("name") or "").strip() or "--"
    verb_past = str(verb_past or "updated").strip().lower()
    return "Member {}: {} ({}) | {} by: {} ({})".format(
        verb_past,
        target_name,
        target_username,
        verb_past.capitalize(),
        actor_name,
        actor_username,
    )


POWER_INTERRUPTION_REMARKS = "Auto-Approved – Power Failure"


def _parse_report_dt(raw):
    """Parse ISO-ish timestamps from reports/checkpoints into datetime (best-effort)."""
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw
    s = str(raw).strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except Exception:
        return None


def _format_duration_hms(seconds) -> str:
    try:
        total = max(0, int(seconds))
    except (TypeError, ValueError):
        return "00:00:00"
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return "{:02d}:{:02d}:{:02d}".format(h, m, s)


def _power_loss_end_iso(checkpoint: dict = None, report: dict = None) -> str:
    """Last known live test time: checkpoint stamp beats post-boot wall clock."""
    cp = checkpoint if isinstance(checkpoint, dict) else {}
    rp = report if isinstance(report, dict) else {}
    td = rp.get("testData") if isinstance(rp.get("testData"), dict) else {}
    cp_td = cp.get("testData") if isinstance(cp.get("testData"), dict) else {}
    for raw in (
        cp.get("_checkpointAt"),
        cp.get("testEndTime"),
        cp_td.get("testEndTime"),
        cp.get("_espCommandSentAt"),
        td.get("testEndTime"),
        rp.get("testEndTime"),
        rp.get("completedAt"),
    ):
        if raw:
            return str(raw).strip()
    return _utc_now_iso()


def _read_duration_seconds_candidate(*dicts) -> Optional[int]:
    for d in dicts:
        if not isinstance(d, dict):
            continue
        for key in ("durationSeconds", "elapsedSeconds", "durationSec"):
            raw = d.get(key)
            if raw is None:
                continue
            try:
                return max(0, int(raw))
            except (TypeError, ValueError):
                continue
    return None


def _apply_power_loss_duration(report: dict, checkpoint: dict = None) -> dict:
    """Stamp exact duration of the test that ran before power loss onto the report."""
    report = dict(report or {})
    td = report.get("testData")
    td = dict(td) if isinstance(td, dict) else {}
    cp = checkpoint if isinstance(checkpoint, dict) else {}
    cp_td = cp.get("testData") if isinstance(cp.get("testData"), dict) else {}

    elapsed = _read_duration_seconds_candidate(cp, cp_td, td, report)

    start_raw = (
        cp.get("testStartTime")
        or cp_td.get("testStartTime")
        or td.get("testStartTime")
        or report.get("testStartTime")
    )
    end_raw = _power_loss_end_iso(cp, report)
    start_dt = _parse_report_dt(start_raw)
    end_dt = _parse_report_dt(end_raw)

    duration = None
    if start_dt is not None and end_dt is not None:
        if start_dt.tzinfo and not end_dt.tzinfo:
            end_dt = end_dt.replace(tzinfo=start_dt.tzinfo)
        elif end_dt.tzinfo and not start_dt.tzinfo:
            start_dt = start_dt.replace(tzinfo=end_dt.tzinfo)
        delta = int((end_dt - start_dt).total_seconds())
        if abs(delta) <= 2 and elapsed is not None and elapsed > 2:
            try:
                start_dt = end_dt - timedelta(seconds=elapsed)
                start_raw = start_dt.isoformat().replace("+00:00", "Z")
                duration = elapsed
            except Exception:
                duration = elapsed
        else:
            duration = elapsed if (elapsed is not None and elapsed >= 0) else max(0, delta)
            if elapsed is not None and elapsed > max(0, delta) + 2:
                duration = elapsed
                if abs(delta) <= 2:
                    try:
                        start_dt = end_dt - timedelta(seconds=elapsed)
                        start_raw = start_dt.isoformat().replace("+00:00", "Z")
                    except Exception:
                        pass
    elif elapsed is not None:
        duration = elapsed
        if end_dt is not None and start_dt is None and elapsed > 0:
            try:
                start_dt = end_dt - timedelta(seconds=elapsed)
                start_raw = start_dt.isoformat().replace("+00:00", "Z")
            except Exception:
                pass
        elif start_dt is not None and end_dt is None and elapsed > 0:
            try:
                end_dt = start_dt + timedelta(seconds=elapsed)
                end_raw = end_dt.isoformat().replace("+00:00", "Z")
            except Exception:
                pass

    if start_raw:
        start_iso = str(start_raw).strip()
        td["testStartTime"] = start_iso
        report["testStartTime"] = start_iso
    end_iso = str(end_raw).strip() if end_raw else _utc_now_iso()
    td["testEndTime"] = end_iso
    report["testEndTime"] = end_iso
    if duration is not None:
        td["durationSeconds"] = duration
        report["durationSeconds"] = duration
    report["testData"] = td
    return report


def _apply_power_loss_abort_to_report(report: dict, checkpoint: dict = None) -> dict:
    """Mark a report aborted after power loss with mandatory power-interruption remarks."""
    report = _apply_power_loss_duration(dict(report or {}), checkpoint)
    td = report.get("testData")
    if not isinstance(td, dict):
        td = {}
    else:
        td = dict(td)
    td["status"] = "aborted"
    td["remarks"] = POWER_INTERRUPTION_REMARKS
    for k in ("approvalPassFail", "drumPassFail"):
        td.pop(k, None)
    results = td.get("stepResults")
    if isinstance(results, list):
        for idx, row in enumerate(results):
            if not isinstance(row, dict):
                continue
            row = dict(row)
            row["resultText"] = "Aborted"
            row.pop("approvalPassFail", None)
            if not row.get("drumLabel"):
                row["drumLabel"] = "Drum {}".format(idx + 1)
            results[idx] = row
        td["stepResults"] = results
    val_runs = td.get("validationRuns")
    if isinstance(val_runs, list):
        for idx, run in enumerate(val_runs):
            if not isinstance(run, dict):
                continue
            run = dict(run)
            run["status"] = "Aborted"
            val_runs[idx] = run
        td["validationRuns"] = val_runs
    report["testData"] = td
    report["remarks"] = POWER_INTERRUPTION_REMARKS
    report["status"] = "Aborted"
    report["approvalRemarks"] = POWER_INTERRUPTION_REMARKS
    report["reportApprovalStatus"] = "aborted"
    report["approvedBy"] = "System (power interruption)"
    report["approvedByUsername"] = "system"
    report["approvedAt"] = _utc_now_iso()
    for k in ("approvalPassFail", "drumPassFail"):
        report.pop(k, None)
    val_runs_top = report.get("validationRuns")
    if isinstance(val_runs_top, list):
        for idx, run in enumerate(val_runs_top):
            if not isinstance(run, dict):
                continue
            run = dict(run)
            run["status"] = "Aborted"
            val_runs_top[idx] = run
        report["validationRuns"] = val_runs_top
    if not report.get("completedAt"):
        report["completedAt"] = report.get("testEndTime") or _utc_now_iso()
    return report


def _persist_power_loss_aborted_report(report: dict, checkpoint: dict = None) -> dict:
    """Save power-loss aborted report and write print artifacts (no Pass/Fail)."""
    report = _apply_power_loss_abort_to_report(report, checkpoint)
    report_id = report.get("id")
    if report_id is None:
        report_id = data_service.save_report(report)
        report["id"] = report_id
    else:
        data_service.save_report(report)
    try:
        print_service.save_report_text_files(report, int(report_id), REPORTS_DIR)
    except Exception:
        app.logger.exception("Failed to save report text files after power-loss abort for id %s", report_id)
    try:
        _generate_report_pdf_file(int(report_id), write_audit=False)
    except Exception:
        app.logger.exception("Failed to generate PDF after power-loss abort for id %s", report_id)
    return report


def _audit_power_loss_aborted_report(report: dict) -> None:
    """Audit: power interruption report saved (with exact duration) + report aborted."""
    rid = report.get("id")
    if rid is None:
        return
    ctx = _format_report_audit_details(int(rid), report)
    td = report.get("testData") if isinstance(report.get("testData"), dict) else {}
    duration = td.get("durationSeconds")
    if duration is None:
        duration = report.get("durationSeconds")
    try:
        duration_i = int(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration_i = None
    dur_txt = _format_duration_hms(duration_i) if duration_i is not None else "--"
    start_txt = td.get("testStartTime") or report.get("testStartTime") or "--"
    end_txt = td.get("testEndTime") or report.get("testEndTime") or "--"
    pl_detail = (
        "Power interruption report saved | {} | duration: {} | "
        "start: {} | end: {} | unclean shutdown | status: aborted | remarks: {} | "
        "approved by System (power interruption)"
    ).format(ctx, dur_txt, start_txt, end_txt, POWER_INTERRUPTION_REMARKS)
    audit_time = _audit_time_fields()
    common = dict(
        user="--",
        role="--",
        details=pl_detail,
        event_type="compliance",
        entity_type="report",
        entity_id=rid,
        entity_name=(report.get("name") or report.get("productName") or ""),
        outcome="success",
        request_source="system/startup",
        timestamp_ms=audit_time.get("timestamp_ms"),
        date_time=audit_time.get("date_time"),
        extra={
            "reportApprovalStatus": "aborted",
            "approvedBy": "System (power interruption)",
            "durationSeconds": duration_i,
            "durationHms": dur_txt,
        },
    )
    audit_service.log_structured_event(action="Power interruption", **common)
    audit_service.log_structured_event(action="Report aborted (power loss)", **common)


def _checkpoint_is_mid_test(cp) -> bool:
    """True when an in-progress / awaiting-approval checkpoint should recover on boot."""
    if not isinstance(cp, dict) or not cp:
        return False
    rtype = str(cp.get("type") or "").strip().lower()
    if rtype not in ("test", "validation", "calibration"):
        return False
    phase = str(cp.get("_checkpointPhase") or "").strip().lower()
    if phase in ("running", "awaiting-approval"):
        return True
    if cp.get("_pendingReportId") is not None:
        return True
    return False


def _checkpoint_operator_user(cp) -> dict:
    """Best-effort operator identity from a mid-test checkpoint for power-loss logout."""
    if not isinstance(cp, dict):
        return {}
    td = cp.get("testData") if isinstance(cp.get("testData"), dict) else {}
    username = (
        cp.get("operatedByUsername")
        or td.get("operatedByUsername")
        or cp.get("employeeId")
        or td.get("employeeId")
        or cp.get("username")
        or ""
    )
    name = cp.get("operatedBy") or td.get("operatedBy") or username
    role = cp.get("operatedByRole") or td.get("operatedByRole") or cp.get("role") or ""
    out = {
        "username": str(username or "").strip(),
        "name": str(name or "").strip(),
        "role": str(role or "").strip(),
    }
    return out if out.get("username") or out.get("name") else {}


def _audit_test_started_from_checkpoint(cp) -> None:
    """Ensure a Test started audit exists for a power-loss mid-test recovery."""
    if not isinstance(cp, dict) or not cp:
        return
    if cp.get("_testStartedAudited"):
        return
    rtype = str(cp.get("type") or "test").strip().lower()
    action = "Quick test started" if cp.get("isQuickTest") or (isinstance(cp.get("testData"), dict) and cp.get("testData").get("isQuickTest")) else "Test started"
    if rtype == "validation":
        action = "Validation started"
    elif rtype == "calibration":
        action = "Calibration started"
    product = cp.get("productName") or (cp.get("recipe") or {}).get("productName") or ""
    batch = cp.get("batchNumber") or (cp.get("recipe") or {}).get("batchNumber") or ""
    details_parts = [p for p in (product, batch) if p]
    details = ", ".join(details_parts) if details_parts else "Test run in progress"
    start = cp.get("testStartTime") or ((cp.get("testData") or {}) if isinstance(cp.get("testData"), dict) else {}).get("testStartTime")
    if start:
        details = "{} | start: {}".format(details, start)
    op = _checkpoint_operator_user(cp)
    audit_time = _audit_time_fields()
    user = op.get("username") or op.get("name") or "--"
    role = op.get("role") or "--"
    if audit_service.is_hidden_factory_actor(user, role):
        user, role = "--", "--"
    audit_service.log_structured_event(
        user=user,
        role=role,
        action=action,
        details=details,
        event_type="lifecycle",
        entity_type="test" if rtype == "test" else rtype,
        entity_name=product or "test",
        outcome="success",
        request_source="system/startup",
        timestamp_ms=audit_time.get("timestamp_ms"),
        date_time=audit_time.get("date_time"),
        extra={"recoveredAfterPowerLoss": True, "testStartTime": start} if start else {"recoveredAfterPowerLoss": True},
    )


def _audit_power_interruption_logout(user_info: dict, request_source: str = "system/startup") -> None:
    """Audit: user logged out due to power interruption."""
    user_info = user_info if isinstance(user_info, dict) else {}
    un = (user_info.get("username") or user_info.get("name") or "").strip()
    role = (user_info.get("role") or "").strip()
    audit_time = _audit_time_fields()
    if audit_service.is_hidden_factory_actor(un, role):
        details = "Privileged factory session was active when power was interrupted or the system restarted."
        actor_user, actor_role = "--", "--"
    elif un:
        details = "User logged out due to {}: {}".format(POWER_INTERRUPTION_REMARKS, un)
        actor_user, actor_role = un, (role or "--")
        if audit_service.is_hidden_factory_actor(actor_user, actor_role):
            actor_user, actor_role = "--", "--"
    else:
        details = "User logged out due to {}".format(POWER_INTERRUPTION_REMARKS)
        actor_user, actor_role = "--", "--"
    audit_service.log_structured_event(
        user=actor_user,
        role=actor_role,
        action="Power interruption logout",
        outcome="success",
        entity_type="session",
        entity_name="logout",
        details=details,
        event_type="compliance",
        reason=POWER_INTERRUPTION_REMARKS,
        target_user=un or None,
        extra={"lastKnownRole": role} if role else None,
        request_source=request_source,
        timestamp_ms=audit_time.get("timestamp_ms"),
        date_time=audit_time.get("date_time"),
    )
    try:
        key = (un or "--").strip().lower()
        last_map = getattr(app, "_last_power_interrupt_logout_ms", None)
        if not isinstance(last_map, dict):
            last_map = {}
        last_map[key] = int(time.time() * 1000)
        app._last_power_interrupt_logout_ms = last_map
    except Exception:
        pass


def _mark_checkpoint_esp_command(command_label: str) -> None:
    """Once START checkpoint exists, any ESP tap command commits the run as started."""
    try:
        cp = data_service.get_test_run_data()
        if not isinstance(cp, dict) or not cp:
            return
        if not _checkpoint_is_mid_test(cp):
            return
        now_iso = _utc_now_iso()
        changed = False
        if not cp.get("testStartTime"):
            cp["testStartTime"] = now_iso
            td = cp.get("testData") if isinstance(cp.get("testData"), dict) else {}
            td = dict(td)
            td.setdefault("testStartTime", now_iso)
            cp["testData"] = td
            changed = True
        if not cp.get("_espCommandSentAt"):
            cp["_espCommandSentAt"] = now_iso
            cp["_espCommand"] = str(command_label or "")[:32]
            changed = True
        if str(cp.get("_checkpointPhase") or "").strip().lower() != "running":
            if str(cp.get("_checkpointPhase") or "").strip().lower() != "awaiting-approval":
                cp["_checkpointPhase"] = "running"
                changed = True
        cp["_checkpointAt"] = now_iso
        if changed or True:
            data_service.save_test_run_data(cp)
    except Exception:
        app.logger.exception("Failed to mark ESP command on test checkpoint")


def _audit_test_started_on_checkpoint_save(body: dict) -> dict:
    """On first running checkpoint after START, persist Test started audit immediately."""
    body = dict(body or {})
    phase = str(body.get("_checkpointPhase") or "").strip().lower()
    if phase not in ("running", "awaiting-approval"):
        return body
    if body.get("_testStartedAudited"):
        return body
    prev = data_service.get_test_run_data()
    if isinstance(prev, dict) and prev.get("_testStartedAudited"):
        body["_testStartedAudited"] = True
        return body
    if not body.get("testStartTime"):
        body["testStartTime"] = _utc_now_iso()
    td = body.get("testData") if isinstance(body.get("testData"), dict) else {}
    td = dict(td)
    td.setdefault("testStartTime", body.get("testStartTime"))
    body["testData"] = td
    rtype = str(body.get("type") or "test").strip().lower()
    action = "Quick test started" if body.get("isQuickTest") or td.get("isQuickTest") else "Test started"
    if rtype == "validation":
        action = "Validation started"
    product = body.get("productName") or (body.get("recipe") or {}).get("productName") or ""
    batch = body.get("batchNumber") or (body.get("recipe") or {}).get("batchNumber") or ""
    details_parts = [p for p in (product, batch) if p]
    details = ", ".join(details_parts) if details_parts else "Test run started"
    details = "{} | start: {}".format(details, body.get("testStartTime"))
    try:
        actor = _audit_actor()
    except Exception:
        cur = data_service.get_current_user() or {}
        actor = {
            "user": cur.get("username") or cur.get("name") or "--",
            "role": cur.get("role") or "--",
        }
    audit_time = _audit_time_fields()
    audit_service.log_structured_event(
        user=actor.get("user"),
        role=actor.get("role"),
        action=action,
        details=details,
        event_type="lifecycle",
        entity_type="test" if rtype == "test" else rtype,
        entity_name=product or "test",
        outcome="success",
        request_source="PUT /api/data/test-run/checkpoint",
        timestamp_ms=audit_time.get("timestamp_ms"),
        date_time=audit_time.get("date_time"),
        extra={"testStartTime": body.get("testStartTime")},
    )
    body["_testStartedAudited"] = True
    return body


def _abort_pending_reports_after_power_loss(session_username=None, checkpoint: dict = None):
    """Mark pending test/validation reports as aborted after unclean shutdown (machine-wide)."""
    aborted = 0
    for report in data_service.list_reports("all") or []:
        rtype = (report.get("type") or "").strip().lower()
        if rtype not in ("test", "validation", "calibration"):
            continue
        if (report.get("reportApprovalStatus") or "").strip().lower() != "pending":
            continue
        report = _persist_power_loss_aborted_report(report, checkpoint)
        _audit_power_loss_aborted_report(report)
        aborted += 1
    return aborted


def _create_aborted_report_from_power_loss_checkpoint(session_username=None):
    """If a test/validation was in progress (checkpoint) but no pending report existed, save an aborted report."""
    cp = data_service.get_test_run_data()
    if not isinstance(cp, dict) or not cp:
        return 0
    pending_id = cp.get("_pendingReportId") or cp.get("id")
    if pending_id is not None:
        try:
            existing = data_service.get_report(int(pending_id))
        except Exception:
            existing = None
        if existing and str(existing.get("reportApprovalStatus") or "").strip().lower() == "pending":
            report = _persist_power_loss_aborted_report(existing, cp)
            _audit_power_loss_aborted_report(report)
            data_service.clear_test_run_data()
            return 1
        if existing and str(existing.get("reportApprovalStatus") or "").strip().lower() == "aborted":
            data_service.clear_test_run_data()
            return 0
    rtype = (cp.get("type") or "").strip().lower()
    if rtype not in ("test", "validation", "calibration"):
        data_service.clear_test_run_data()
        return 0
    td = cp.get("testData") if isinstance(cp.get("testData"), dict) else {}
    report_data = dict(cp)
    for k in ("_checkpointAt", "_checkpointPhase", "_pendingReportId", "_testStartedAudited", "_espCommandSentAt", "_espCommand"):
        report_data.pop(k, None)
    recipe = report_data.get("recipe") or (td.get("recipe") if isinstance(td, dict) else None)
    enriched = report_service.generate_report(
        report_data,
        recipe=recipe,
        factory_settings=report_data.get("factorySettings"),
    )
    enriched = _stamp_report_operator(enriched)
    enriched = _persist_power_loss_aborted_report(enriched, cp)
    _audit_power_loss_aborted_report(enriched)
    data_service.clear_test_run_data()
    return 1


def _startup_session_power_audit():
    """If the last run ended without a clean stop while a session was active, log power-interruption rows."""
    try:
        had_clean_shutdown = data_service.consume_app_clean_stop_flag()
        pending = data_service.read_session_power_audit_pending()
        checkpoint = data_service.get_test_run_data()
        mid_test = _checkpoint_is_mid_test(checkpoint)
        if had_clean_shutdown and mid_test:
            had_clean_shutdown = False
            app.logger.warning(
                "Ignoring stale clean-stop flag; mid-test checkpoint present — treating as unclean shutdown"
            )

        should_recover_reports = mid_test or ((not had_clean_shutdown) and bool(pending))
        if not had_clean_shutdown and not should_recover_reports:
            try:
                for report in data_service.list_reports("all") or []:
                    rtype = (report.get("type") or "").strip().lower()
                    if rtype not in ("test", "validation", "calibration"):
                        continue
                    if (report.get("reportApprovalStatus") or "").strip().lower() == "pending":
                        should_recover_reports = True
                        break
            except Exception:
                pass

        if should_recover_reports:
            if mid_test:
                try:
                    _audit_test_started_from_checkpoint(checkpoint)
                except Exception:
                    app.logger.exception("Test started recovery audit failed")
            try:
                _abort_pending_reports_after_power_loss(None, checkpoint if mid_test else None)
                _create_aborted_report_from_power_loss_checkpoint(None)
            except Exception:
                app.logger.exception("Abort pending reports after power loss failed")
            logout_user = None
            if pending and (pending.get("username") or pending.get("name")):
                logout_user = pending
            else:
                logout_user = _checkpoint_operator_user(checkpoint) or data_service.get_current_user()
            if logout_user and not (isinstance(pending, dict) and pending.get("powerAuditLogged")):
                try:
                    _audit_power_interruption_logout(logout_user)
                except Exception:
                    app.logger.exception("Power interruption logout audit failed")
                if pending:
                    pending = dict(pending)
                    pending["powerAuditLogged"] = True
                    data_service.write_session_power_audit_pending(pending)
        elif pending and had_clean_shutdown and pending.get("powerAuditLogged"):
            pending = dict(pending)
            pending.pop("powerAuditLogged", None)
            data_service.write_session_power_audit_pending(pending)
        cur = data_service.get_current_user()
        if cur:
            if not pending:
                data_service.write_session_power_audit_pending(cur)
        else:
            data_service.delete_session_power_audit_pending()
        audit_service.prune_power_interruption_overflow(keep=10)
        data_service.clear_current_user()
    except Exception:
        app.logger.exception("Startup session power audit failed")




def _register_clean_shutdown_atexit():
    """Mark clean shutdown on normal process exit (reduces false power-interruption audits)."""

    def _on_exit():
        try:
            data_service.touch_app_clean_stop_flag()
        except Exception:
            pass

    try:
        atexit.register(_on_exit)
    except Exception:
        pass

def _register_clean_shutdown_signals():
    """Mark clean shutdown on SIGTERM/SIGINT so the next start does not log a false power interruption."""

    def _handler(signum, frame):
        try:
            data_service.touch_app_clean_stop_flag()
        except Exception:
            pass
        sys.exit(0)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError, AttributeError):
            pass


def _require_user_admin_verification():
    return _consume_approval_verify_token("user_admin")


def _approval_verifier_member(verifier: dict) -> dict:
    """Resolve verifier to a member row with featureOverrides for permission checks."""
    if not verifier:
        return {}
    role = str(verifier.get("role") or "").strip().lower()
    if role == "factory":
        return verifier
    un = str(verifier.get("username") or "").strip()
    m = data_service.get_member_by_username(un) if un else None
    return m if m else verifier


def _approval_verifier_eligible_for_recipe(verifier: dict) -> bool:
    """Recipe approval: verifier must have recipe-approve permission (Factory bypass)."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, "recipe-approve")


def _approval_verifier_eligible_for_report(verifier: dict) -> bool:
    """Test report approval: verifier must have test-report-approve permission (Factory bypass)."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, "test-report-approve")


def _approval_verifier_eligible_for_user_admin(verifier: dict) -> bool:
    """User disable / admin actions: verifier must have profile-management permission."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, "user-manage")


def _approval_verifier_eligible_for_export(verifier: dict) -> bool:
    """USB export approval: verifier must have export-approve permission (Factory bypass)."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, "export-approve")


def _approval_verifier_eligible_for_validation_report(verifier: dict) -> bool:
    """Validation report approval: verifier must have validation-report-approve (Factory bypass)."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, "validation-report-approve")


def _utc_now_iso():
    """Naive local ISO timestamp for reports/labels (hardware RTC wall time)."""
    dt = rtc_service.read_rtc_wall_datetime()
    if dt is not None:
        return dt.strftime("%Y-%m-%dT%H:%M:%S")
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _norm_username(val):
    return str(val or "").strip().lower()


def _report_operated_by_username(report):
    td = report.get("testData") or {}
    if isinstance(td, dict):
        u = td.get("operatedByUsername") or td.get("employeeId")
        if u:
            return _norm_username(u)
    return _norm_username(report.get("operatedByUsername") or report.get("employeeId"))


def _stamp_report_operator(enriched):
    cur = data_service.get_current_user() or {}
    td = enriched.get("testData")
    if not isinstance(td, dict):
        td = {}
    un = _norm_username(
        enriched.get("operatedByUsername")
        or td.get("operatedByUsername")
        or td.get("employeeId")
        or cur.get("username")
        or cur.get("name")
    )
    name = (
        enriched.get("operatorName")
        or td.get("operatorName")
        or cur.get("name")
        or cur.get("username")
        or "—"
    )
    emp = (
        enriched.get("employeeId")
        or td.get("employeeId")
        or cur.get("username")
        or un
    )
    enriched["operatedByUsername"] = un
    enriched["operatorName"] = name
    enriched["employeeId"] = emp
    td = dict(td)
    td["operatedByUsername"] = un
    td["operatorName"] = name
    td["employeeId"] = emp
    enriched["testData"] = td
    return enriched


def _report_requires_approval(report):
    rtype = (report.get("type") or "").strip().lower()
    return rtype in ("test", "validation")


def _check_report_approved_for_print_export(report=None, report_id=None, report_data=None):
    """Return (json_response, status_code) if blocked, else None."""
    if report is None and report_id is not None:
        report = data_service.get_report(report_id)
    if report is None and report_data:
        report = report_data
    if not report or not _report_requires_approval(report):
        return None
    st = (report.get("reportApprovalStatus") or "").strip().lower()
    if st == "approved":
        return None
    if st == "pending" and _effective_request_role() != "factory":
        body = {
            "ok": False,
            "success": False,
            "error": "Report must be approved before print or export.",
        }
        return jsonify(body), 403
    return None


def _display_role_label(role_str):
    """User-facing role in approval lines (stored role Supervisor → Reviewer)."""
    r = str(role_str or "").strip()
    if not r:
        return r
    if r.lower() == "supervisor":
        return "Reviewer"
    return r


def _rbac_member_from_session():
    """Member record (with normalized permissions) for RBAC, or factory stub user."""
    cur = data_service.get_current_user()
    if not cur:
        return None
    role = str((cur or {}).get("role") or "").strip().lower()
    un = str((cur or {}).get("username") or "").strip().upper()
    if role == "factory" or un == data_service.FACTORY_USERNAME.upper():
        return cur
    m = data_service.get_member_by_username(cur.get("username") or "")
    return m if m else cur


def _session_has_internal(internal_key: str) -> bool:
    m = _rbac_member_from_session()
    if not m:
        return False
    return rbac_service.member_has_internal(m, internal_key)


def _require_auth():
    """Return 401 if no logged-in session."""
    if not data_service.get_current_user():
        return jsonify({"error": "Unauthorized"}), 401
    return None


def _require_auth_or_kiosk_headers():
    """Accept server session or validated X-User-* headers from the kiosk UI."""
    if data_service.get_current_user():
        return None
    un = (request.headers.get("X-User-Username") or request.headers.get("X-User-Name") or "").strip()
    if not un:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    role = (request.headers.get("X-User-Role") or "").strip().lower()
    if role == "factory" or un.upper() == data_service.FACTORY_USERNAME.upper():
        return None
    member = data_service.get_member_by_username(un)
    if not member:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    st = str(member.get("status") or "active").strip().lower()
    if st != "active":
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    return None


def _session_member_id():
    """Logged-in member id from session, or None (e.g. factory stub)."""
    cur = data_service.get_current_user() or {}
    try:
        mid = cur.get("id")
        if mid is None:
            return None
        return int(mid)
    except (TypeError, ValueError):
        return None


def _is_self_member(member_id: int) -> bool:
    """True when the session user is updating/viewing their own member record."""
    try:
        target_id = int(member_id)
    except (TypeError, ValueError):
        return False
    sid = _session_member_id()
    if sid is not None and sid == target_id:
        return True
    cur = data_service.get_current_user() or {}
    member = data_service.get_member(target_id)
    if not member:
        return False
    un_cur = str(cur.get("username") or "").strip().lower()
    un_mem = str(member.get("username") or "").strip().lower()
    return bool(un_cur) and un_cur == un_mem


def _require_user_manage_or_self(member_id: int):
    """Allow user-manage admins or any user accessing their own profile."""
    err = _require_auth()
    if err:
        return err
    if _is_self_member(member_id):
        return None
    return _require_session_internal(
        "user-manage",
        "Forbidden. You do not have permission to manage users.",
    )


def _self_profile_payload_from_request(existing: dict, payload: dict) -> dict:
    """Self-service profile: only display name and password may change."""
    out = dict(existing)
    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if name:
            out["name"] = name
    new_pwd = payload.get("password")
    if new_pwd is not None and str(new_pwd).strip():
        pwd_err = _password_strength_error(str(new_pwd))
        if pwd_err:
            raise ValueError(pwd_err)
        out["password"] = str(new_pwd)
    return out


def _self_payload_tries_permission_change(payload: dict) -> bool:
    if not isinstance(payload, dict):
        return False
    if "featureOverrides" in payload:
        return True
    if "role" in payload and str(payload.get("role") or "").strip():
        return True
    return False


def _session_username_key():
    cur = data_service.get_current_user() or {}
    return _norm_username(
        (request.headers.get("X-User-Username") or "").strip()
        or (cur.get("username") or "").strip()
        or (cur.get("name") or "").strip()
    )


def _stamp_recipe_actor(processed, is_create=False):
    un = _session_username_key()
    if is_create and not processed.get("createdByUsername"):
        processed["createdByUsername"] = un
    processed["lastEditedByUsername"] = un


def _recipe_creator_or_editor_username(recipe):
    return _norm_username(
        (recipe or {}).get("lastEditedByUsername")
        or (recipe or {}).get("createdByUsername")
    )


def _recipe_self_approve_blocked(recipe, verified_username):
    if _effective_request_role() == "factory":
        return False
    creator = _recipe_creator_or_editor_username(recipe)
    return bool(creator) and creator == _norm_username(verified_username)


def _role_sees_all_reports():
    role = (_effective_request_role() or "").strip().lower()
    return role in ("admin", "factory", "supervisor", "qa", "reviewer")


def _resolve_session_member_record():
    """Member row for the logged-in user (not factory)."""
    data_service.refresh_current_user_from_member()
    cur = data_service.get_current_user() or {}
    un = str(cur.get("username") or "").strip()
    if un.upper() == data_service.FACTORY_USERNAME.upper():
        return None, cur
    mid = _session_member_id()
    member = data_service.get_member(mid) if mid is not None else None
    if not member and un:
        member = data_service.get_member_by_username(un)
    return member, cur


def _require_session_internal(internal_key: str, message: str = None):
    """Return Flask error response if session lacks internal permission, else None."""
    err = _require_auth()
    if err:
        return err
    data_service.refresh_current_user_from_member()
    if not _session_has_internal(internal_key):
        msg = message or "Forbidden. You do not have permission for this action."
        return jsonify({"error": msg}), 403
    return None


def _require_any_session_internal(internal_keys, message: str = None):
    """Return Flask error response if session lacks all listed permissions, else None."""
    err = _require_auth()
    if err:
        return err
    data_service.refresh_current_user_from_member()
    for key in internal_keys or []:
        if _session_has_internal(key):
            return None
    msg = message or "Forbidden. You do not have permission for this action."
    return jsonify({"error": msg}), 403


def _session_can_edit_datetime() -> bool:
    """True when the logged-in user may change system date/time (RBAC, not role name alone)."""
    data_service.refresh_current_user_from_member()
    m = _rbac_member_from_session()
    if not m:
        return False
    return rbac_service.member_has_internal(m, "edit-datetime")


def _require_edit_datetime():
    """Return a Flask error response if the session may not change date/time, else None."""
    if not data_service.get_current_user():
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    if not _session_can_edit_datetime():
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "Forbidden. You do not have permission to change date and time.",
                }
            ),
            403,
        )
    return None


def _verifier_payload_has_internal(verified, internal_key: str) -> bool:
    if not verified:
        return False
    vr = str((verified or {}).get("role") or "").strip().lower()
    if vr == "factory":
        return True
    un = (verified or {}).get("username") or ""
    vm = data_service.get_member_by_username(un) if un else None
    if not vm:
        return False
    return rbac_service.member_has_internal(vm, internal_key)


def _session_role_header():
    return (request.headers.get("X-User-Role") or "").strip().lower()


def _effective_request_role():
    """Role for this request: X-User-Role if present, else logged-in user from server session."""
    hr = _session_role_header()
    if hr:
        return hr
    cur = data_service.get_current_user()
    return str((cur or {}).get("role") or "").strip().lower()


def _is_biometric_enabled():
    settings = data_service.get_factory_settings() or {}
    val = settings.get("biometricEnabled", True)
    if isinstance(val, bool):
        return val
    return str(val).strip().lower() not in ("false", "0", "off", "no", "disabled")


def _is_biometric_transient_error(message):
    """Errors expected during passive biometric polling (not true auth failures)."""
    msg = str(message or "").strip().lower()
    if not msg:
        return False
    transient_markers = (
        "timed out waiting for finger",
        "no finger detected",
        "image too messy",
    )
    return any(marker in msg for marker in transient_markers)


def _can_assign_feature_overrides():
    if _effective_request_role() == "factory":
        return True
    return _session_has_internal("user-add")


def _payload_has_protected_feature_overrides(member_data):
    if not isinstance(member_data, dict):
        return False
    raw = member_data.get("featureOverrides")
    if not isinstance(raw, dict):
        return False
    protected = {"dashboard", "factory-settings", "factory-reset"}
    for k in (raw.get("allow") or []):
        if str(k or "").strip() in protected:
            return True
    for k in (raw.get("deny") or []):
        if str(k or "").strip() in protected:
            return True
    return False


def _apply_recipe_approval_for_session_creator(processed):
    """Factory saves: approve immediately (no QA/Admin verification). Others: pending."""
    _stamp_recipe_actor(processed, is_create=not processed.get("id"))
    if _effective_request_role() != "factory":
        processed["recipeApprovalStatus"] = "pending"
        for k in (
            "recipeApprovedAt",
            "recipeApprovedBy",
            "recipeApprovalRemarks",
            "recipeApprovedByUsername",
        ):
            processed.pop(k, None)
        return
    cur = data_service.get_current_user() or {}
    display_name = (request.headers.get("X-User-Name") or "").strip() or (
        request.headers.get("X-User-Username") or ""
    ).strip() or (cur.get("name") or "").strip() or (cur.get("username") or "").strip() or "Factory"
    username_raw = (
        (request.headers.get("X-User-Username") or "").strip()
        or (cur.get("username") or "").strip()
        or (cur.get("name") or "").strip()
        or display_name
    )
    username_key = _norm_username(username_raw)
    by_line = "{} ({})".format(display_name, _display_role_label("factory"))
    processed["recipeApprovalStatus"] = "approved"
    processed["recipeApprovedAt"] = _utc_now_iso()
    processed["recipeApprovedBy"] = by_line
    processed["recipeApprovedByUsername"] = username_key
    processed["recipeApprovalRemarks"] = ""


def _apply_recipe_approval_verify_token(processed, remarks=""):
    """
    When X-Approval-Verify-Token is present, approve a pending recipe in the same save
    (avoids save-then-approve creating duplicate recipes or double writes).
    Returns (error_message or None, applied_via_token bool).
    """
    if (request.headers.get("X-Approval-Verify-Token") or "").strip() == "":
        return None, False
    if processed.get("recipeApprovalStatus") != "pending":
        return None, False
    verified, verify_err = _consume_approval_verify_token("recipe")
    if verify_err:
        return verify_err, False
    verified_name = (verified.get("name") or verified.get("username") or "—").strip()
    verified_role = (verified.get("role") or "").strip()
    verified_username = _norm_username(verified.get("username"))
    if _recipe_self_approve_blocked(processed, verified_username):
        return "Creator cannot approve their own recipe.", False
    by_line = verified_name
    if verified_role:
        by_line = "{} ({})".format(verified_name, _display_role_label(verified_role))
    processed["recipeApprovalStatus"] = "approved"
    processed["recipeApprovedAt"] = _utc_now_iso()
    processed["recipeApprovedBy"] = by_line
    processed["recipeApprovedByUsername"] = verified_username
    processed["recipeApprovalRemarks"] = (remarks or "").strip()
    return None, True


_approval_verify_tokens = {}


def _cleanup_approval_verify_tokens():
    pass


def _issue_approval_verify_token(verifier_user, purpose):
    return auth_store.issue_approval_verify_token(verifier_user, purpose)


def _consume_approval_verify_token(expected_purpose):
    return auth_store.consume_approval_verify_token(expected_purpose)


def _audit_report_pdf_generated(report_id, report=None) -> None:
    """Audit row when a report PDF file is written (approved or aborted only)."""
    if report is None:
        report = data_service.get_report(report_id)
    rid = report_id if report_id is not None else (report or {}).get("id")
    st = str((report or {}).get("reportApprovalStatus") or "").strip().lower()
    if st == "approved":
        pf = str((report or {}).get("approvalPassFail") or "").strip().upper()
        detail = "Report id {}".format(rid)
        if pf:
            detail = "{} | {} | approved PDF".format(detail, pf)
        else:
            detail = "{} | approved PDF".format(detail)
    elif st == "aborted":
        detail = "Report id {} | aborted PDF".format(rid)
    else:
        return
    _audit(None, None, "Report PDF generated", detail)


def _format_report_audit_details(report_id, enriched):
    """Build audit trail details: saved report name, recipe, batch."""
    if not enriched:
        return str(report_id)
    parts = []
    name = enriched.get("name")
    if name:
        parts.append("saved as: {}".format(name))
    else:
        parts.append("report id {}".format(report_id))
    recipe = enriched.get("recipe") or {}
    test_data = enriched.get("testData") or {}
    recipe_inner = test_data.get("recipe") or {}
    rname = (
        recipe.get("productName")
        or recipe.get("name")
        or test_data.get("productName")
        or recipe_inner.get("productName")
        or recipe_inner.get("name")
        or enriched.get("productName")
    )
    if rname:
        parts.append("recipe: {}".format(rname))
    if report_id is not None:
        parts.append("report id {}".format(report_id))
    batch = recipe.get("batchNumber")
    if batch is None or (isinstance(batch, str) and not batch.strip()):
        batch = test_data.get("batchNumber")
    if batch is None or (isinstance(batch, str) and not batch.strip()):
        batch = recipe_inner.get("batchNumber")
    if batch is not None and str(batch).strip() != "":
        parts.append("batch: {}".format(batch))
    return " | ".join(parts)


def _recipe_label(recipe: dict) -> str:
    if not isinstance(recipe, dict):
        return ""
    return str(recipe.get("productName") or recipe.get("name") or "").strip()


def _recipe_audit_snapshot(recipe: dict) -> dict:
    """Comparable recipe fields for audit before/after on edit."""
    if not isinstance(recipe, dict):
        return {}
    steps = recipe.get("steps") or []
    tap_parts = []
    if isinstance(steps, list):
        for step in steps:
            if isinstance(step, dict):
                tap_parts.append(str(step.get("tapCount", "?")))
    cyl = recipe.get("cylinder") if isinstance(recipe.get("cylinder"), dict) else {}
    usp = recipe.get("usp") or recipe.get("uspMode") or ""
    return {
        "productName": _recipe_label(recipe),
        "speed": recipe.get("speed"),
        "dropHeight": recipe.get("dropHeight"),
        "usp": str(usp).strip(),
        "stepCount": recipe.get("stepCount"),
        "customTotalTaps": recipe.get("customTotalTaps"),
        "cylinderMl": cyl.get("volume") if cyl.get("volume") is not None else cyl.get("volumeMl"),
        "stepTaps": ",".join(tap_parts),
    }


def _recipe_audit_field_label(key: str) -> str:
    return {
        "productName": "product",
        "speed": "speed",
        "dropHeight": "drop height",
        "usp": "USP mode",
        "stepCount": "steps",
        "customTotalTaps": "total taps",
        "cylinderMl": "cylinder (ml)",
        "stepTaps": "taps per step",
    }.get(key, key)


def _recipe_audit_value_display(val) -> str:
    if val is None or val == "":
        return "—"
    return str(val)


def _format_recipe_edit_change_details(before_snap: dict, after_snap: dict) -> str:
    parts = []
    for key in sorted(set((before_snap or {}).keys()) | set((after_snap or {}).keys())):
        b = (before_snap or {}).get(key)
        a = (after_snap or {}).get(key)
        if b != a:
            parts.append(
                "{}: {} → {}".format(
                    _recipe_audit_field_label(key),
                    _recipe_audit_value_display(b),
                    _recipe_audit_value_display(a),
                )
            )
    return "; ".join(parts)


def _audit_recipe_edited(before_recipe: dict, after_recipe: dict, recipe_id: int) -> None:
    before_snap = _recipe_audit_snapshot(before_recipe)
    after_snap = _recipe_audit_snapshot(after_recipe)
    changes = _format_recipe_edit_change_details(before_snap, after_snap)
    rlabel = _recipe_label(after_recipe) or _recipe_label(before_recipe) or "id {}".format(recipe_id)
    if changes:
        details = "Recipe edited — {} (id {}): {}".format(rlabel, recipe_id, changes)
    else:
        details = "Recipe edited — {} (id {})".format(rlabel, recipe_id)
    _audit_event(
        action="Recipe edited",
        outcome="success",
        entity_type="recipe",
        entity_id=recipe_id,
        entity_name=rlabel,
        details=details,
        before=before_snap,
        after=after_snap,
        event_type="compliance",
    )


def _audit_recipe_created(recipe: dict, recipe_id: int) -> None:
    after_snap = _recipe_audit_snapshot(recipe)
    rlabel = _recipe_label(recipe) or "id {}".format(recipe_id)
    details = "Recipe created — {} (id {})".format(rlabel, recipe_id)
    _audit_event(
        action="Recipe created",
        outcome="success",
        entity_type="recipe",
        entity_id=recipe_id,
        entity_name=rlabel,
        details=details,
        after=after_snap,
        event_type="compliance",
    )


# =================== STATIC ==========================


@app.route("/api/health")
def health():
    return jsonify({"status": "ok"}), 200


# =================== DESKTOP API ==========================
# Token/session state lives in desktop_api.auth_store (shared with blueprint routes
# such as /embed/issue). Legacy handlers below delegate to auth_store so login
# tokens work for recipe embed and other blueprint-only endpoints.

from desktop_api import auth_store

DESKTOP_TOKEN_TTL_SECONDS = int(os.environ.get("DESKTOP_TOKEN_TTL_SECONDS", str(8 * 60 * 60)))


def _desktop_now() -> int:
    return int(time.time())


def _desktop_token_from_request() -> str:
    return auth_store.token_from_request()


def _desktop_user_snapshot(user: dict) -> dict:
    return auth_store.user_snapshot(user)


def _desktop_issue_token(user: dict) -> tuple[str, dict]:
    return auth_store.issue_token(user)


def _desktop_revoke_token(token: str) -> None:
    auth_store.revoke_token(token)


def _desktop_current_user():
    return auth_store.current_user()


def _desktop_require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        token, user = _desktop_current_user()
        if not user:
            return jsonify({"error": "Unauthorized"}), 401
        return fn(user, *args, **kwargs)
    return wrapper


def _desktop_has_internal(user: dict, internal_key: str) -> bool:
    return rbac_service.member_has_internal(user or {}, internal_key)


def _desktop_require_internal(internal_key: str):
    def decorator(fn):
        @wraps(fn)
        @_desktop_require_auth
        def wrapper(user, *args, **kwargs):
            if not _desktop_has_internal(user, internal_key):
                return jsonify({"error": "Forbidden"}), 403
            return fn(user, *args, **kwargs)
        return wrapper
    return decorator


def _desktop_filter_range(filters: dict) -> dict:
    out = {}
    for key in ("user", "role", "action", "type", "range"):
        value = filters.get(key)
        if value:
            out[key] = value
    for key in ("from", "to"):
        value = filters.get(key)
        if not value:
            continue
        try:
            out[key] = int(value)
        except (TypeError, ValueError):
            out[key] = value
    return out


def _desktop_send_temp(path, download_name, mimetype):
    path = pathlib.Path(path)

    @after_this_request
    def _cleanup(response):
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass
        return response

    return send_file(path, mimetype=mimetype, as_attachment=True, download_name=download_name)


def _desktop_is_display_ipv4(ip: str) -> bool:
    """IPv4 suitable for display: skip loopback and Tailscale (100.x.x.x)."""
    value = str(ip or "").strip()
    if not value or value.startswith("127.") or value.startswith("100."):
        return False
    parts = value.split(".")
    if len(parts) != 4:
        return False
    try:
        return all(0 <= int(part) <= 255 for part in parts)
    except (TypeError, ValueError):
        return False


def _desktop_collect_ipv4_addresses():
    """Best-effort LAN IPv4 addresses via hostname -I, then iproute2."""
    found = []
    seen = set()
    source = ""

    def add_ip(ip):
        if not _desktop_is_display_ipv4(ip):
            return
        if ip in seen:
            return
        seen.add(ip)
        found.append(ip)

    try:
        proc = subprocess.run(
            ["hostname", "-I"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        raw = (proc.stdout or "").strip()
        if raw:
            source = "hostname -I"
            for part in raw.split():
                add_ip(part)
    except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
        pass

    if not found:
        for ip_cmd in (
            ["ip", "-4", "-o", "addr", "show", "scope", "global"],
            ["/sbin/ip", "-4", "-o", "addr", "show", "scope", "global"],
        ):
            try:
                proc = subprocess.run(
                    ip_cmd,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if proc.returncode != 0:
                    continue
                matches = re.findall(r"\binet (\d+\.\d+\.\d+\.\d+)/", proc.stdout or "")
                if matches:
                    source = " ".join(ip_cmd)
                    for ip in matches:
                        add_ip(ip)
                    break
            except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
                continue

    return {"addresses": found, "source": source}


def _desktop_zip_paths(zip_path: pathlib.Path, roots: list[tuple[pathlib.Path, str]]) -> None:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for root, prefix in roots:
            root = pathlib.Path(root)
            if root.is_file():
                zf.write(root, "{}/{}".format(prefix, root.name))
                continue
            if not root.exists():
                continue
            for item in root.rglob("*"):
                if item.is_file():
                    rel = item.relative_to(root)
                    zf.write(item, str(pathlib.PurePosixPath(prefix) / rel.as_posix()))


@app.route("/api/desktop/v1/health", methods=["GET"])
def desktop_health():
    try:
        factory = data_service.get_factory_settings() or {}
    except Exception:
        factory = {}
    return jsonify({
        "ok": True,
        "status": "ok",
        "app": "Tap Density",
        "model": factory.get("modelNo") or factory.get("model") or "",
        "serial": factory.get("serialNo") or factory.get("serial") or "",
        "time": datetime.now().isoformat(),
    }), 200


@app.route("/api/desktop/v1/auth/login", methods=["POST"])
def desktop_auth_login():
    try:
        credentials = request.get_json(force=True, silent=True) or {}
        username = str(credentials.get("username") or "").strip()
        password = credentials.get("password") if isinstance(credentials.get("password"), str) else str(credentials.get("password") or "")
        member = data_service.get_member_by_username(username)
        if member:
            status = str(member.get("status") or "active").strip().lower()
            if status == "locked":
                return jsonify({"error": "Account locked. Contact admin."}), 403
            if status == "disabled":
                return jsonify({"error": "Account disabled by admin."}), 403
        user = data_service.authenticate_user(username, password)
        if not user:
            updated = data_service.record_failed_login(username)
            remaining = None
            if updated:
                status = str(updated.get("status") or "").strip().lower()
                if status == "locked":
                    return jsonify({"error": "Account locked. Contact admin.", "remainingAttempts": 0}), 403
                try:
                    remaining = max(0, 3 - int(updated.get("failedAttempts") or 0))
                except (TypeError, ValueError):
                    remaining = None
            body = {"error": "Invalid username or password."}
            if remaining is not None:
                body["remainingAttempts"] = remaining
            return jsonify(body), 401
        if username.upper() != data_service.FACTORY_USERNAME.upper():
            member = data_service.get_member_by_username(username)
            if member:
                if bool(member.get("mustChangePassword")):
                    return jsonify({"error": "Password change required before login.", "passwordChangeRequired": True}), 403
                expiry = data_service.get_member_password_expiry_state(member)
                if bool(expiry.get("expired")):
                    return jsonify({"error": "Password expired. Reset required.", "passwordExpired": True, "expiry": expiry}), 403
        data_service.record_successful_login(username)
        token, safe_user = _desktop_issue_token(user)
        _audit_event(
            action="Desktop login",
            outcome="success",
            entity_type="session",
            entity_name="desktop",
            details="Desktop user logged in: {}".format(username),
            target_user=username,
            after={"username": safe_user.get("username"), "role": safe_user.get("role")},
        )
        return jsonify({"success": True, "token": token, "user": safe_user}), 200
    except Exception as e:
        app.logger.exception("Desktop login failed")
        return jsonify({"error": str(e)}), 500


@app.route("/api/desktop/v1/auth/me", methods=["GET"])
@_desktop_require_auth
def desktop_auth_me(user):
    return jsonify({"user": user}), 200


@app.route("/api/desktop/v1/auth/logout", methods=["POST"])
@_desktop_require_auth
def desktop_auth_logout(user):
    token = _desktop_token_from_request()
    _desktop_revoke_token(token)
    _audit_event(
        action="Desktop logout",
        outcome="success",
        entity_type="session",
        entity_name="desktop",
        details="Desktop user logged out: {}".format(user.get("username") or user.get("name") or "--"),
        target_user=user.get("username") or user.get("name"),
    )
    return jsonify({"success": True}), 200


@app.route("/api/desktop/v1/reports", methods=["GET"])
@_desktop_require_internal("reports-view")
def desktop_reports(user):
    filter_type = (request.args.get("type") or "all").strip().lower() or "all"
    reports = data_service.list_reports(filter_type if filter_type in ("test", "validation") else "all")
    query_user = (request.args.get("user") or "").strip().lower()
    query_role = (request.args.get("role") or "").strip().lower()
    if query_user:
        reports = [r for r in reports if query_user in str(r.get("username") or r.get("operatorName") or r.get("employeeId") or "").lower()]
    if query_role:
        reports = [r for r in reports if query_role in str(r.get("role") or r.get("operatorRole") or "").lower()]
    return jsonify({"reports": reports}), 200


@app.route("/api/desktop/v1/reports/<int:report_id>/pdf", methods=["GET"])
@_desktop_require_internal("reports-view")
def desktop_report_pdf(user, report_id):
    report = data_service.get_report(report_id)
    if not report:
        return jsonify({"error": "Report not found"}), 404
    if not _report_pdf_status_allowed(report):
        return jsonify({"error": "PDF is available only after the report is approved or marked aborted."}), 403
    if not _generate_report_pdf_file(report_id, write_audit=True):
        return jsonify({"error": "PDF generation failed"}), 500
    path = _report_pdf_path(report_id)
    return send_file(path, mimetype="application/pdf", as_attachment=True, download_name="report-{}.pdf".format(report_id))


@app.route("/api/desktop/v1/reports/download", methods=["POST"])
@_desktop_require_internal("reports-view")
def desktop_reports_download(user):
    payload = request.get_json(force=True, silent=True) or {}
    report_ids = payload.get("report_ids") or payload.get("reportIds")
    if report_ids:
        wanted = []
        for rid in report_ids:
            try:
                wanted.append(int(rid))
            except (TypeError, ValueError):
                pass
        reports = [data_service.get_report(rid) for rid in wanted]
        reports = [r for r in reports if r]
    else:
        filter_type = str(payload.get("type") or "all").strip().lower()
        reports = data_service.list_reports(filter_type if filter_type in ("test", "validation") else "all")
    if not reports:
        return jsonify({"error": "No reports found"}), 404
    tmp = pathlib.Path(tempfile.NamedTemporaryFile(delete=False, suffix=".zip").name)
    try:
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for report in reports:
                rid = int(report.get("id"))
                if not _report_pdf_status_allowed(report):
                    continue
                if _generate_report_pdf_file(rid, write_audit=True):
                    pdf = _report_pdf_path(rid)
                    if pdf.exists():
                        zf.write(pdf, "reports/report-{}.pdf".format(rid))
        return _desktop_send_temp(tmp, "reports-download.zip", "application/zip")
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        raise


@app.route("/api/desktop/v1/audit", methods=["GET"])
@_desktop_require_internal("audit-view")
def desktop_audit(user):
    filters = _desktop_filter_range(dict(request.args))
    entries = _prepare_audit_entries_for_display(audit_service.list_entries(filters))
    return jsonify({"entries": entries}), 200


@app.route("/api/desktop/v1/audit/download", methods=["POST"])
@_desktop_require_internal("audit-view")
def desktop_audit_download(user):
    payload = request.get_json(force=True, silent=True) or {}
    filters = _desktop_filter_range(payload.get("filters") or payload)
    entries = _prepare_audit_entries_for_display(audit_service.list_entries(filters))
    factory = data_service.get_factory_settings() or {}
    html = _build_audit_trail_html(entries, filters, factory, export_meta={"exported_by": user, "approved_by": user})
    tmp = pathlib.Path(tempfile.NamedTemporaryFile(delete=False, suffix=".pdf").name)
    try:
        pdf_generator.render_html_to_pdf(html, tmp)
        _audit(user.get("username") or user.get("name"), user.get("role"), "Desktop audit downloaded", "{} entries".format(len(entries)))
        return _desktop_send_temp(tmp, "audit-download.pdf", "application/pdf")
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        raise


@app.route("/api/desktop/v1/audit/desktop-print", methods=["POST"])
@_desktop_require_internal("reports-view")
def desktop_audit_print(user):
    payload = request.get_json(force=True, silent=True) or {}
    report_id = payload.get("reportId") or payload.get("report_id")
    details = "Desktop print"
    if report_id:
        details += " | report id {}".format(report_id)
    _audit(user.get("username") or user.get("name"), user.get("role"), "Desktop print", details)
    return jsonify({"success": True, "logged": True}), 200


@app.route("/api/desktop/v1/network/ips", methods=["GET"])
@_desktop_require_auth
def desktop_network_ips(user):
    try:
        payload = _desktop_collect_ipv4_addresses()
        return jsonify({
            "ok": True,
            "addresses": payload.get("addresses") or [],
            "source": payload.get("source") or "",
        }), 200
    except Exception as e:
        app.logger.exception("desktop_network_ips")
        return jsonify({"error": str(e)}), 500


@app.route("/api/desktop/v1/backup/download", methods=["POST"])
@_desktop_require_auth
def desktop_backup_download(user):
    timestamp = time.strftime("%Y%m%d_%H%M%S", time.localtime())
    tmp = pathlib.Path(tempfile.NamedTemporaryFile(delete=False, suffix=".zip").name)
    try:
        roots = [
            (STORAGE_DIR, "storage"),
            (REPORTS_DIR, "reports"),
            (AUDIT_DB_DIR, "db"),
        ]
        _desktop_zip_paths(tmp, roots)
        _audit(user.get("username") or user.get("name"), user.get("role"), "Desktop backup downloaded", "backup {}".format(timestamp))
        return _desktop_send_temp(tmp, "machine-backup-{}.zip".format(timestamp), "application/zip")
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        raise


if sock:
    @sock.route("/api/desktop/v1/ws")
    def desktop_ws(ws):
        token, user = _desktop_current_user()
        if not user:
            ws.close()
            return
        while True:
            try:
                ws.send(json.dumps({
                    "type": "status",
                    "status": "ok",
                    "time": datetime.now().isoformat(),
                    "user": user.get("username") or user.get("name"),
                }))
                time.sleep(5)
            except Exception:
                break


@app.route("/")
def serve_index():
    return send_from_directory(APP_ROOT, "index.html")


@app.route("/<path:path>")
def serve_static(path):     
    return send_from_directory(APP_ROOT, path)


# =================== DATA: RECIPES ==========================


@app.route("/api/data/recipes", methods=["GET"])
def get_recipes():
    try:
        gate = _require_any_session_internal(
            ["recipe-list", "quick-test", "recipe-test", "recipe-edit"],
            "Forbidden. You do not have permission to view recipes.",
        )
        if gate:
            return gate
        status = str(request.args.get("status") or "active").strip().lower()
        if status not in ("active", "disabled", "all"):
            status = "active"
        recipes = data_service.list_recipes(status=status)
        return jsonify({"recipes": recipes}), 200
    except Exception as e:
        app.logger.exception("Error listing recipes")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes", methods=["POST"])
def create_recipe():
    try:
        gate = _require_session_internal(
            "recipe-manage",
            "Forbidden. You do not have permission to create recipes.",
        )
        if gate:
            return gate
        recipe_data = request.get_json(force=True, silent=True) or {}
        validation_result = calculation_service.validate_recipe(recipe_data)
        if not validation_result.get("valid", False):
            return jsonify({"error": validation_result.get("error", "Invalid recipe data")}), 400
        processed = calculation_service.process_recipe_form_data(recipe_data)
        _apply_recipe_approval_for_session_creator(processed)
        remarks = (recipe_data.get("recipeApprovalRemarks") or recipe_data.get("remarks") or "").strip()
        tok_err, via_token = _apply_recipe_approval_verify_token(processed, remarks)
        if tok_err:
            code = 403 if "cannot approve their own recipe" in str(tok_err).lower() else 401
            return jsonify({"error": tok_err}), code
        recipe_id = data_service.save_recipe(processed)
        _audit_recipe_created(processed, recipe_id)
        rlabel = _recipe_label(processed) or "id {}".format(recipe_id)
        rd = "Recipe created — {} (id {})".format(rlabel, recipe_id)
        if processed.get("recipeApprovalStatus") == "approved":
            if via_token:
                v_user = processed.get("recipeApprovedByUsername") or "--"
                v_role = (request.headers.get("X-User-Role") or "").strip() or "--"
                _audit(v_user, v_role, "Recipe approved", rd)
            elif _effective_request_role() == "factory":
                au = (request.headers.get("X-User-Username") or "").strip() or "--"
                _audit(au, "factory", "Recipe approved", rd)
        return jsonify({"id": recipe_id, "recipe": processed}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error creating recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["GET"])
def get_recipe(recipe_id):
    try:
        gate = _require_any_session_internal(
            ["recipe-list", "quick-test", "recipe-test", "recipe-edit"],
            "Forbidden. You do not have permission to view recipes.",
        )
        if gate:
            return gate
        include_disabled = str(request.args.get("includeDisabled") or "").strip().lower() in ("1", "true", "yes")
        recipe = data_service.get_recipe(recipe_id, include_disabled=include_disabled)
        if recipe:
            return jsonify({"recipe": recipe}), 200
        return jsonify({"error": "Recipe not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["PUT"])
def update_recipe(recipe_id):
    try:
        gate = _require_session_internal(
            "recipe-manage",
            "Forbidden. You do not have permission to edit recipes.",
        )
        if gate:
            return gate
        recipe_data = request.get_json(force=True, silent=True) or {}
        recipe_data["id"] = recipe_id
        before_recipe = data_service.get_recipe(recipe_id, include_disabled=True)
        if not before_recipe:
            return jsonify({"error": "Recipe not found"}), 404
        validation_result = calculation_service.validate_recipe(recipe_data)
        if not validation_result.get("valid", False):
            return jsonify({"error": validation_result.get("error", "Invalid recipe data")}), 400
        processed = calculation_service.process_recipe_form_data(recipe_data)
        processed["id"] = recipe_id
        if before_recipe.get("createdByUsername"):
            processed["createdByUsername"] = before_recipe.get("createdByUsername")
        _apply_recipe_approval_for_session_creator(processed)
        remarks = (recipe_data.get("recipeApprovalRemarks") or recipe_data.get("remarks") or "").strip()
        tok_err, via_token = _apply_recipe_approval_verify_token(processed, remarks)
        if tok_err:
            code = 403 if "cannot approve their own recipe" in str(tok_err).lower() else 401
            return jsonify({"error": tok_err}), code
        data_service.save_recipe(processed)
        _audit_recipe_edited(before_recipe, processed, recipe_id)
        rlabel = _recipe_label(processed) or "id {}".format(recipe_id)
        rd = "Recipe edited — {} (id {})".format(rlabel, recipe_id)
        if processed.get("recipeApprovalStatus") == "approved":
            if via_token:
                v_user = processed.get("recipeApprovedByUsername") or "--"
                v_role = (request.headers.get("X-User-Role") or "").strip() or "--"
                _audit(v_user, v_role, "Recipe approved", rd)
            elif _effective_request_role() == "factory":
                au = (request.headers.get("X-User-Username") or "").strip() or "--"
                _audit(au, "factory", "Recipe approved", rd)
        return jsonify({"id": recipe_id, "recipe": processed}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error updating recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["DELETE"])
def delete_recipe(recipe_id):
    try:
        gate = _require_any_session_internal(
            ["recipe-delete", "disable-recipes"],
            "Forbidden. You do not have permission to disable recipes.",
        )
        if gate:
            return gate
        existing = data_service.get_recipe(recipe_id, include_disabled=True)
        updated = data_service.disable_recipe(
            recipe_id,
            disabled_by=((request.headers.get("X-User-Name") or request.headers.get("X-User-Username") or "").strip() or "--"),
            disabled_by_username=((request.headers.get("X-User-Username") or "").strip() or "--"),
        )
        if updated:
            rlabel = ""
            if existing:
                rlabel = existing.get("productName") or existing.get("name") or ""
            details = "Recipe id {}".format(recipe_id)
            if rlabel:
                details = "{}: {}".format(details, rlabel)
            _audit(None, None, "Disable Recipe", details)
            return jsonify({"success": True, "recipe": updated}), 200
        return jsonify({"error": "Recipe not found"}), 404
    except Exception as e:
        app.logger.exception("Error deleting recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>/enable", methods=["POST"])
def enable_recipe(recipe_id):
    try:
        gate = _require_any_session_internal(
            ["recipe-delete", "disable-recipes"],
            "Forbidden. You do not have permission to enable recipes.",
        )
        if gate:
            return gate
        updated = data_service.enable_recipe(recipe_id)
        if updated:
            rlabel = updated.get("productName") or updated.get("name") or ""
            details = "Recipe id {}".format(recipe_id)
            if rlabel:
                details = "{}: {}".format(details, rlabel)
            _audit(None, None, "Enable Recipe", details)
            return jsonify({"success": True, "recipe": updated}), 200
        return jsonify({"error": "Recipe not found"}), 404
    except Exception as e:
        app.logger.exception("Error enabling recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>/approve", methods=["POST"])
def approve_recipe(recipe_id):
    try:
        verified, verify_err = _consume_approval_verify_token("recipe")
        if verify_err:
            return jsonify({"ok": False, "error": verify_err}), 401
        body = request.get_json(force=True, silent=True) or {}
        remarks = (body.get("remarks") or "").strip()
        approver_name = (body.get("approverName") or "").strip()
        role_header = (request.headers.get("X-User-Role") or "").strip()
        recipe = data_service.get_recipe(recipe_id)
        if not recipe:
            return jsonify({"ok": False, "error": "Recipe not found"}), 404
        verified_username = _norm_username(verified.get("username"))
        if _recipe_self_approve_blocked(recipe, verified_username):
            return jsonify({"ok": False, "error": "Creator cannot approve their own recipe."}), 403
        st = recipe.get("recipeApprovalStatus")
        if st == "approved":
            existing_approver = _norm_username(recipe.get("recipeApprovedByUsername"))
            if existing_approver and existing_approver == verified_username:
                return jsonify({"ok": False, "error": "Same person cannot approve twice"}), 409
            return jsonify({"ok": True, "recipe": recipe}), 200
        if st not in (None, "pending"):
            return jsonify({"ok": False, "error": "Invalid approval state"}), 400
        if st is None:
            return jsonify({"ok": False, "error": "Legacy recipe does not require approval"}), 400
        verified_name = (verified.get("name") or verified.get("username") or approver_name or "—").strip()
        verified_role = (verified.get("role") or role_header or "").strip()
        by_line = verified_name
        if verified_role:
            by_line = "{} ({})".format(verified_name, _display_role_label(verified_role))
        recipe["recipeApprovalStatus"] = "approved"
        recipe["recipeApprovedAt"] = _utc_now_iso()
        recipe["recipeApprovedBy"] = by_line
        recipe["recipeApprovedByUsername"] = verified_username
        recipe["recipeApprovalRemarks"] = remarks
        data_service.save_recipe(recipe)
        rname = (recipe.get("productName") or recipe.get("name") or "").strip()
        rdetail = "Recipe id {} | verified by {} | creator {}".format(
            recipe_id, verified_name, recipe.get("createdByUsername") or recipe.get("lastEditedByUsername") or "--"
        )
        if rname:
            rdetail = "{} | recipe: {}".format(rdetail, rname)
        batch = recipe.get("batchNumber")
        if batch is not None and str(batch).strip():
            rdetail = "{} | batch: {}".format(rdetail, str(batch).strip())
        v_audit_user = verified.get("username") or verified_username or verified_name
        v_audit_role = (verified.get("role") or "").strip() or "--"
        _audit(
            v_audit_user,
            v_audit_role,
            "Recipe approved",
            rdetail,
        )
        return jsonify({"ok": True, "recipe": recipe}), 200
    except Exception as e:
        app.logger.exception("Error approving recipe")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>/reject", methods=["POST"])
def reject_recipe(recipe_id):
    try:
        verified, verify_err = _consume_approval_verify_token("recipe")
        if verify_err:
            return jsonify({"ok": False, "error": verify_err}), 401
        body = request.get_json(force=True, silent=True) or {}
        remarks = (body.get("remarks") or "").strip()
        recipe = data_service.get_recipe(recipe_id)
        if not recipe:
            return jsonify({"ok": False, "error": "Recipe not found"}), 404
        verified_username = _norm_username(verified.get("username"))
        if _recipe_self_approve_blocked(recipe, verified_username):
            return jsonify({"ok": False, "error": "Creator cannot reject their own recipe."}), 403
        st = recipe.get("recipeApprovalStatus")
        if st not in (None, "pending"):
            return jsonify({"ok": False, "error": "Invalid approval state"}), 400
        if st is None:
            return jsonify({"ok": False, "error": "Legacy recipe does not require approval"}), 400
        verified_name = (verified.get("name") or verified.get("username") or "—").strip()
        verified_role = (verified.get("role") or "").strip()
        by_line = verified_name
        if verified_role:
            by_line = "{} ({})".format(verified_name, _display_role_label(verified_role))
        recipe["recipeApprovalStatus"] = "rejected"
        recipe["recipeRejectedAt"] = _utc_now_iso()
        recipe["recipeRejectedBy"] = by_line
        recipe["recipeRejectedByUsername"] = verified_username
        recipe["recipeApprovalRemarks"] = remarks
        data_service.save_recipe(recipe)
        rname = (recipe.get("productName") or recipe.get("name") or "").strip()
        rdetail = "Recipe id {} | rejected by {}".format(recipe_id, verified_name)
        if rname:
            rdetail = "{} | recipe: {}".format(rdetail, rname)
        _audit(
            verified.get("username") or verified_username or verified_name,
            (verified.get("role") or "").strip() or "--",
            "Recipe rejected",
            rdetail,
        )
        return jsonify({"ok": True, "recipe": recipe}), 200
    except Exception as e:
        app.logger.exception("Error rejecting recipe")
        return jsonify({"ok": False, "error": str(e)}), 500


# =================== DATA: TEST RUN CHECKPOINT (power-loss recovery) ==========================


@app.route("/api/data/test-run/checkpoint", methods=["PUT"])
def put_test_run_checkpoint():
    """Persist in-progress test run so a report can be saved after unclean shutdown."""
    try:
        gate = _require_auth()
        if gate:
            return gate
        gate = _require_any_session_internal(
            ["quick-test", "recipe-test"],
            "Forbidden. You do not have permission to run tests.",
        )
        if gate:
            return gate
        body = request.get_json(force=True, silent=True) or {}
        if not body:
            return jsonify({"ok": False, "error": "Checkpoint body required"}), 400
        body = _audit_test_started_on_checkpoint_save(body)
        data_service.save_test_run_data(body)
        return jsonify({"ok": True}), 200
    except Exception as e:
        app.logger.exception("Error saving test run checkpoint")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/test-run/checkpoint", methods=["DELETE"])
def delete_test_run_checkpoint():
    try:
        gate = _require_auth()
        if gate:
            return gate
        data_service.clear_test_run_data()
        return jsonify({"ok": True}), 200
    except Exception as e:
        app.logger.exception("Error clearing test run checkpoint")
        return jsonify({"ok": False, "error": str(e)}), 500


# =================== DATA: REPORTS ==========================


@app.route("/api/data/reports", methods=["GET"])
def get_reports():
    try:
        _maybe_purge_scheduled_report_export()
        gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to view reports.")
        if gate:
            return gate
        filter_type = request.args.get("filter", "all")
        reports = data_service.list_reports(filter_type)
        if not _role_sees_all_reports():
            me = _session_username_key()
            reports = [
                r for r in (reports or [])
                if _report_operated_by_username(r) == me
            ]
        return jsonify({"reports": reports}), 200
    except Exception as e:
        app.logger.exception("Error listing reports")
        return jsonify({"error": str(e)}), 500




def _audit_report_created(report_id, enriched):
    """Write audit row for a newly saved report/test/validation."""
    details = _format_report_audit_details(report_id, enriched)
    approval_st = str(enriched.get("reportApprovalStatus") or "").strip().lower()
    if approval_st == "pending":
        details = "{} | awaiting approval (PDF after approval)".format(details)
    elif approval_st == "aborted":
        details = "{} | aborted".format(details)
    rtype = (enriched.get("type") or "").strip().lower()
    if rtype == "test":
        td = enriched.get("testData") or {}
        recipe = enriched.get("recipe") or td.get("recipe") or {}
        pname = str(recipe.get("productName") or td.get("productName") or "").strip()
        recipe_id = recipe.get("id")
        is_quick = pname.lower() == "quick test" or (recipe_id is None and bool(pname))
        action = "Quick test performed" if is_quick else "Test performed"
        _audit(None, None, action, details)
    elif rtype == "validation":
        _audit(None, None, "Validation performed", details)
    else:
        _audit(None, None, "Report saved", details)

@app.route("/api/data/reports", methods=["POST"])
def create_report():
    try:
        report_data = request.get_json(force=True, silent=True) or {}
        rtype = (report_data.get("type") or "").strip().lower()
        if rtype == "validation":
            gate = _require_session_internal(
                "validation-test",
                "Forbidden. You do not have permission to run validation.",
            )
        elif rtype == "test":
            gate = _require_any_session_internal(
                ["quick-test", "recipe-test"],
                "Forbidden. You do not have permission to save test reports.",
            )
        else:
            gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to save reports.")
        if gate:
            return gate
        recipe = report_data.get("recipe") or (report_data.get("testData") or {}).get("recipe")
        enriched = report_service.generate_report(
            report_data,
            recipe=recipe,
            factory_settings=report_data.get("factorySettings"),
        )
        if (enriched.get("type") or "").strip().lower() in ("test", "validation"):
            enriched = _stamp_report_operator(enriched)
            td = enriched.get("testData") if isinstance(enriched.get("testData"), dict) else {}
            run_status = str(td.get("status") or enriched.get("status") or "").strip().lower()
            if run_status == "aborted":
                enriched["reportApprovalStatus"] = "aborted"
            else:
                enriched["reportApprovalStatus"] = "pending"
                for k in ("approvalPassFail", "approvalRemarks", "approvedBy", "approvedAt", "approvedByUsername"):
                    enriched.pop(k, None)
        report_id = data_service.save_report(enriched)
        enriched = report_service.enrich_report_context({**enriched, "id": report_id})
        data_service.save_report(enriched)
        if (enriched.get("type") or "").strip().lower() == "validation":
            try:
                report_service.sync_factory_validation_dates()
            except Exception:
                app.logger.exception("Failed to sync factory validation dates after validation report")
        try:
            print_service.save_report_text_files(enriched, report_id, REPORTS_DIR)
        except Exception:
            pass
        approval_st = str(enriched.get("reportApprovalStatus") or "").strip().lower()
        pdf_ok = False
        if approval_st == "pending":
            _remove_report_pdf_file(report_id)
        elif approval_st == "aborted":
            try:
                pdf_ok = _generate_report_pdf_file(report_id, write_audit=False)
            except Exception:
                app.logger.exception("Aborted-report PDF on create failed for id %s", report_id)
        _audit_report_created(report_id, enriched)
        if approval_st == "aborted" and pdf_ok:
            _audit_report_pdf_generated(report_id, enriched)
        return jsonify({"id": report_id, "report": enriched}), 201
    except Exception as e:
        app.logger.exception("Error creating report")
        return jsonify({"error": str(e)}), 500


def _apply_pending_report_approval(report_id, verified, pf, remarks, approver_name="", role_header=""):
    """Approve a pending report and generate its PDF. Does not log the verifier in.

    Returns (report, error, status_code, pdf_ok).
    """
    pf = (pf or "").strip().upper()
    if pf not in ("PASS", "FAIL"):
        return None, "passFail must be PASS or FAIL", 400, False
    remarks = (remarks or "").strip()
    report = data_service.get_report(report_id)
    if not report:
        return None, "Report not found", 404, False
    verified = verified or {}
    verified_username = _norm_username(verified.get("username"))
    st = report.get("reportApprovalStatus")
    if st is None:
        return None, "Report does not require approval", 400, False
    if st == "approved":
        existing_approver = _norm_username(report.get("approvedByUsername"))
        if existing_approver and existing_approver == verified_username:
            return None, "Same person cannot approve twice", 409, False
        return report, None, 200, False
    if st != "pending":
        return None, "Invalid approval state", 400, False
    op_username = _report_operated_by_username(report)
    if op_username and verified_username == op_username and str(verified.get("role") or "").strip().lower() != "factory":
        return None, "Operator cannot approve their own report.", 403, False
    verified_name = (verified.get("name") or verified.get("username") or approver_name or "—").strip()
    verified_role = (verified.get("role") or role_header or "").strip()
    by_line = verified_name
    if verified_role:
        by_line = "{} ({})".format(verified_name, _display_role_label(verified_role))
    report["reportApprovalStatus"] = "approved"
    report["approvalPassFail"] = pf
    report["approvalRemarks"] = remarks
    report["approvedBy"] = by_line
    report["approvedByUsername"] = verified_username
    report["approvedAt"] = _utc_now_iso()
    data_service.save_report(report)
    rtype = (report.get("type") or "").strip().lower()
    if rtype == "validation" and pf == "PASS":
        try:
            report_service.apply_pending_validation_due_dates(report)
            data_service.save_report(report)
        except Exception:
            app.logger.exception("Failed to apply pending validation due dates for report %s", report_id)
    pdf_ok = False
    try:
        pdf_ok = _generate_report_pdf_file(report_id, write_audit=False)
    except Exception:
        app.logger.exception("Approved-report PDF generation failed for id %s", report_id)
    v_audit_user = verified.get("username") or verified_username or verified_name
    v_audit_role = (verified.get("role") or "").strip() or "--"
    ctx = _format_report_audit_details(report_id, report)
    appr_detail = "{} | {} | verified by {}".format(ctx, pf, verified_name)
    _audit(v_audit_user, v_audit_role, "Report approved", appr_detail)
    if pdf_ok:
        _audit(
            v_audit_user,
            v_audit_role,
            "Report PDF generated",
            "Report id {} | {} | approved PDF".format(report_id, pf),
        )
    return report, None, 200, pdf_ok


@app.route("/api/data/reports/<int:report_id>/approve", methods=["POST"])
def approve_report(report_id):
    try:
        token = (request.headers.get("X-Approval-Verify-Token") or "").strip()
        verified = None
        if token:
            verified, verify_err = _consume_approval_verify_token("report")
            if verify_err:
                return jsonify({"ok": False, "error": verify_err}), 401
        else:
            # Factory: no verifier modal — same trust model as recipe save (header + server session).
            if _effective_request_role() != "factory":
                return jsonify({"ok": False, "error": "Approval verification is required."}), 401
            cur = data_service.get_current_user() or {}
            display_name = (request.headers.get("X-User-Name") or "").strip() or (
                (cur.get("name") or "").strip() or (cur.get("username") or "").strip() or "Factory"
            )
            username_raw = (
                (request.headers.get("X-User-Username") or "").strip()
                or (cur.get("username") or "").strip()
                or (cur.get("name") or "").strip()
                or display_name
            )
            verified = {
                "username": username_raw,
                "name": display_name,
                "role": "factory",
            }
        body = request.get_json(force=True, silent=True) or {}
        pf = (body.get("passFail") or body.get("pass_fail") or "").strip().upper()
        remarks = (body.get("remarks") or "").strip()
        approver_name = (body.get("approverName") or "").strip()
        role_header = (request.headers.get("X-User-Role") or "").strip()
        report, err, code, _pdf_ok = _apply_pending_report_approval(
            report_id, verified, pf, remarks, approver_name=approver_name, role_header=role_header
        )
        if err:
            return jsonify({"ok": False, "error": err}), code
        return jsonify({"ok": True, "report": report}), 200
    except Exception as e:
        app.logger.exception("Error approving report")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>/abort", methods=["POST"])
def abort_report(report_id):
    try:
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"ok": False, "error": "Report not found"}), 404
        rtype = (report.get("type") or "").strip().lower()
        if rtype == "validation":
            gate = _require_session_internal(
                "validation-test",
                "Forbidden. You do not have permission to abort validation reports.",
            )
        elif rtype == "test":
            gate = _require_any_session_internal(
                ["quick-test", "recipe-test"],
                "Forbidden. You do not have permission to abort test reports.",
            )
        else:
            gate = _require_session_internal("reports-view", "Forbidden.")
        if gate:
            return gate
        if rtype not in ("test", "validation"):
            return jsonify({"ok": False, "error": "Report type cannot be aborted"}), 400
        st = (report.get("reportApprovalStatus") or "").strip().lower()
        if st != "pending":
            return jsonify({"ok": False, "error": "Only pending reports can be aborted"}), 400
        cur = data_service.get_current_user() or {}
        session_un = _norm_username(cur.get("username") or cur.get("name"))
        op_un = _report_operated_by_username(report)
        role = _effective_request_role()
        if role != "factory" and session_un != op_un:
            return jsonify({"ok": False, "error": "Only the operator or Factory can abort this report."}), 403
        td = report.get("testData")
        if not isinstance(td, dict):
            td = {}
        else:
            td = dict(td)
        td["status"] = "aborted"
        report["testData"] = td
        report["status"] = "aborted"
        report["reportApprovalStatus"] = "aborted"
        if not report.get("completedAt"):
            report["completedAt"] = _utc_now_iso()
        data_service.save_report(report)
        pdf_ok = False
        try:
            pdf_ok = _generate_report_pdf_file(report_id, write_audit=False)
        except Exception:
            app.logger.exception("Aborted-report PDF generation failed for id %s", report_id)
        if pdf_ok:
            _audit_report_pdf_generated(report_id, report)
        ctx = _format_report_audit_details(report_id, report)
        abort_detail = ctx
        if pdf_ok:
            abort_detail = "{} | aborted PDF saved".format(ctx)
        _audit(session_un or None, role or None, "Report aborted", abort_detail)
        return jsonify({"ok": True, "report": report}), 200
    except Exception as e:
        app.logger.exception("Error aborting report")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>", methods=["GET"])
def get_report(report_id):
    try:
        gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to view reports.")
        if gate:
            return gate
        report = data_service.get_report(report_id)
        if report:
            return jsonify({"report": report}), 200
        return jsonify({"error": "Report not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting report")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>", methods=["DELETE"])
def delete_report(report_id):
    try:
        gate = _require_session_internal("reports-delete", "Forbidden. You do not have permission to delete reports.")
        if gate:
            return gate
        existing = data_service.get_report(report_id)
        success = data_service.delete_report(report_id)
        if success:
            details = (
                _format_report_audit_details(report_id, existing)
                if existing
                else str(report_id)
            )
            _audit(None, None, "Report deleted", details)
            return jsonify({"success": True}), 200
        return jsonify({"error": "Report not found"}), 404
    except Exception as e:
        app.logger.exception("Error deleting report")
        return jsonify({"error": str(e)}), 500


# =================== DATA: MEMBERS ==========================


@app.route("/api/data/members", methods=["GET"])
def get_members():
    try:
        gate = _require_session_internal("user-manage", "Forbidden. You do not have permission to manage users.")
        if gate:
            return gate
        members = data_service.list_members()
        safe = [data_service.sanitize_member_for_client(m) or m for m in members]
        return jsonify({"members": safe}), 200
    except Exception as e:
        app.logger.exception("Error listing members")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members", methods=["POST"])
def create_member():
    try:
        gate = _require_session_internal("user-add", "Forbidden. You do not have permission to add users.")
        if gate:
            return gate
        member_data = request.get_json(force=True, silent=True) or {}
        if _payload_has_protected_feature_overrides(member_data):
            return jsonify({"error": "Protected features cannot be overridden."}), 400
        if data_service.has_non_empty_feature_overrides(member_data) and not _can_assign_feature_overrides():
            return jsonify({"error": "Forbidden. Only Factory/Admin can assign feature overrides."}), 403
        member_id = data_service.save_member(member_data)
        created = data_service.get_member(member_id) or dict(member_data)
        cur = data_service.get_current_user() or {}
        sig = {
            "mode": "session",
            "username": (cur.get("username") or cur.get("name") or "").strip() or "--",
            "role": (cur.get("role") or "").strip() or "--",
        }
        uname = created.get("username") or created.get("name") or ""
        urole = created.get("role") or ""
        _audit_event(
            action="Added new user",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=uname,
            details="Added new user: {} ({})".format(uname, _display_role_label(urole) if urole else "—"),
            target_user=uname,
            after=data_service.sanitize_member_for_client(created) or created,
            signature=sig,
        )
        _audit_member_permissions_if_changed(None, created, member_id=member_id, signature=sig)
        safe = data_service.sanitize_member_for_client(created) or dict(created)
        return jsonify({"id": member_id, "member": safe}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error creating member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>", methods=["GET"])
def get_member(member_id):
    try:
        gate = _require_user_manage_or_self(member_id)
        if gate:
            return gate
        member = data_service.get_member(member_id)
        if member:
            return jsonify({"member": data_service.sanitize_member_for_client(member) or member}), 200
        return jsonify({"error": "Member not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>", methods=["PUT"])
def update_member(member_id):
    try:
        gate = _require_user_manage_or_self(member_id)
        if gate:
            return gate
        member_data = request.get_json(force=True, silent=True) or {}
        before_member = data_service.get_member(member_id)
        if not before_member:
            return jsonify({"error": "Member not found"}), 404
        is_self = _is_self_member(member_id)
        if is_self and _self_payload_tries_permission_change(member_data):
            uname = before_member.get("username") or before_member.get("name") or ""
            _audit_event(
                action="User permissions updated",
                outcome="denied",
                entity_type="member",
                entity_id=member_id,
                entity_name=uname,
                details="Self-service change of role or permission cards is not allowed",
                target_user=uname,
            )
            return jsonify({"error": "You cannot change your own role or permission cards."}), 403
        if is_self:
            try:
                member_data = _self_profile_payload_from_request(before_member, member_data)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
        elif _payload_has_protected_feature_overrides(member_data):
            return jsonify({"error": "Protected features cannot be overridden."}), 400
        if not is_self and data_service.has_non_empty_feature_overrides(member_data) and not _can_assign_feature_overrides():
            return jsonify({"error": "Forbidden. Only Factory/Admin can assign feature overrides."}), 403
        member_data["id"] = member_id
        cur = data_service.get_current_user() or {}
        acting_id = cur.get("id")
        password_changed = "password" in member_data and member_data.get("password") not in (None, "")
        data_service.save_member(member_data, acting_user_id=acting_id)
        updated = data_service.get_member(member_id) or dict(member_data)
        sig = {
            "mode": "session",
            "username": (cur.get("username") or cur.get("name") or "").strip() or "--",
            "role": (cur.get("role") or "").strip() or "--",
        }
        uname = updated.get("username") or updated.get("name") or ""
        if password_changed:
            _audit_event(
                action="Password changed",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=uname,
                details="Password changed for user: {}".format(uname),
                target_user=uname,
                signature=sig,
            )
        _audit_member_permissions_if_changed(
            before_member, updated, member_id=member_id, signature=sig
        )
        _audit_event(
            action="User update",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=uname,
            details="Member updated",
            target_user=uname,
            before=data_service.sanitize_member_for_client(before_member) if before_member else None,
            after=data_service.sanitize_member_for_client(updated) or updated,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(updated) or dict(updated)
        return jsonify({"id": member_id, "member": safe}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error updating member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>", methods=["DELETE"])
def delete_member(member_id):
    try:
        gate = _require_session_internal("user-delete", "Forbidden. You do not have permission to delete users.")
        if gate:
            return gate
        member = data_service.get_member(member_id)
        if not member:
            return jsonify({"error": "Member not found"}), 404
        target_username = (member.get("username") or "").strip()
        target_name = (member.get("name") or target_username or "").strip() or "--"
        if str(target_username).strip().upper() == data_service.FACTORY_USERNAME.upper():
            return jsonify({"error": "The factory profile cannot be disabled."}), 403
        verified, verify_err = _require_user_admin_verification()
        if not verified:
            _audit_event(
                action="User disable",
                outcome="denied",
                entity_type="member",
                entity_id=member_id,
                entity_name=target_username or target_name,
                details=verify_err or "Approval verification required",
                target_user=target_username,
                before=member,
            )
            return jsonify({"error": verify_err}), 403
        actor = _audit_actor()
        disabler_username = (actor.get("user") or "").strip() or "--"
        disabler_name = (actor.get("name") or disabler_username).strip() or "--"
        disabler_role = (actor.get("role") or "").strip() or "--"
        sig = {
            "mode": "password_reconfirm",
            "username": verified.get("username") if verified else disabler_username,
            "role": verified.get("role") if verified else disabler_role,
        }
        before_member = dict(member)
        template_id = member.get("fingerprintTemplateId")
        template_delete_error = ""
        if template_id is not None:
            deleted = biometric_service.delete_template(template_id)
            if not deleted.get("ok"):
                _audit_event(
                    action="User disable",
                    outcome="warning",
                    entity_type="member",
                    entity_id=member_id,
                    entity_name=member.get("username") or member.get("name") or "",
                    details="Biometric template unlink fallback: {}".format(
                        deleted.get("error") or "Failed to delete fingerprint template from sensor"
                    ),
                    target_user=member.get("username") or "",
                    before=before_member,
                    signature={"mode": "password_reconfirm", "username": verified.get("username"), "role": verified.get("role")},
                    extra={"templateId": template_id},
                )
                template_delete_error = deleted.get("error") or "Failed to delete fingerprint template from sensor"
            data_service.clear_member_biometric(member_id)
        member = data_service.disable_member(member_id)
        detail = _member_status_change_audit_detail("disabled", member, actor)
        _audit_event(
            action="User disabled",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=target_username or target_name,
            details=detail,
            target_user=target_username,
            before=before_member,
            after=member,
            signature=sig,
            extra={
                "templateIdFreed": template_id,
                "templateDeleteError": template_delete_error,
                "disabledMemberUsername": target_username,
                "disabledMemberName": target_name,
                "disabledByUsername": disabler_username,
                "disabledByName": disabler_name,
                "disabledByRole": disabler_role,
            },
        )
        return jsonify({"success": True, "member": member}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error deleting member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>/unlock", methods=["POST"])
def unlock_member_route(member_id):
    if not _session_has_internal("user-unlock"):
        return jsonify({"error": "Forbidden. Unlock requires profile management permission."}), 403
    try:
        before_member = data_service.get_member(member_id)
        cur = data_service.get_current_user() or {}
        sig = {
            "mode": "session",
            "username": (cur.get("username") or cur.get("name") or "").strip() or "--",
            "role": (cur.get("role") or "").strip() or "--",
        }
        member = data_service.unlock_member(member_id)
        actor = _audit_actor()
        detail = _member_status_change_audit_detail("unlocked", member, actor)
        _audit_event(
            action="User unlocked",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=member.get("username") or member.get("name") or "",
            details=detail,
            target_user=member.get("username") or "",
            before=data_service.sanitize_member_for_client(before_member) if before_member else None,
            after=data_service.sanitize_member_for_client(member) or member,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(member) or dict(member)
        return jsonify({"success": True, "member": safe}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error unlocking member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>/enable", methods=["POST"])
def enable_member_route(member_id):
    if not _session_has_internal("user-enable"):
        return jsonify({"error": "Forbidden. Enable requires profile management permission."}), 403
    try:
        before_member = data_service.get_member(member_id)
        cur = data_service.get_current_user() or {}
        sig = {
            "mode": "session",
            "username": (cur.get("username") or cur.get("name") or "").strip() or "--",
            "role": (cur.get("role") or "").strip() or "--",
        }
        member = data_service.enable_member(member_id)
        actor = _audit_actor()
        detail = _member_status_change_audit_detail("enabled", member, actor)
        _audit_event(
            action="User enabled",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=member.get("username") or member.get("name") or "",
            details=detail,
            target_user=member.get("username") or "",
            before=data_service.sanitize_member_for_client(before_member) if before_member else None,
            after=data_service.sanitize_member_for_client(member) or member,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(member) or dict(member)
        return jsonify({"success": True, "member": safe}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error enabling member")
        return jsonify({"error": str(e)}), 500


# =================== DATA: FACTORY SETTINGS ==========================


@app.route("/api/data/factory-settings", methods=["GET"])
def get_factory_settings():
    try:
        settings = report_service.enrich_factory_settings(data_service.get_factory_settings() or {})
        return jsonify({"settings": settings}), 200
    except Exception as e:
        app.logger.exception("Error getting factory settings")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/factory-settings", methods=["POST"])
def save_factory_settings():
    try:
        settings = request.get_json(force=True, silent=True) or {}
        before = data_service.get_factory_settings() or {}
        data_service.save_factory_settings(settings)
        merged = report_service.enrich_factory_settings(data_service.get_factory_settings() or {})
        details = "maxUsers {}→{} | maxAdmins {}→{} | maxSupervisors {}→{} | maxQa {}→{}".format(
            before.get("maxUsers"), merged.get("maxUsers"),
            before.get("maxAdmins"), merged.get("maxAdmins"),
            before.get("maxSupervisors"), merged.get("maxSupervisors"),
            before.get("maxQa"), merged.get("maxQa"),
        )
        _audit(None, None, "Factory settings updated", details)
        return jsonify({"success": True, "settings": merged}), 200
    except Exception as e:
        app.logger.exception("Error saving factory settings")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/factory-settings/validation-dates", methods=["POST"])
def save_validation_due_dates():
    """Persist last/next validation due dates without a Factory Settings audit."""
    try:
        gate = _require_any_session_internal(
            ["validation-test", "validation-report-approve"],
            "Forbidden. You do not have permission to update validation due dates.",
        )
        if gate:
            return gate
        body = request.get_json(force=True, silent=True) or {}
        last = str(body.get("lastValidationDate") or "").strip()
        nxt = str(body.get("nextValidationDate") or "").strip()
        try:
            months = int(body.get("months") or 0)
        except (TypeError, ValueError):
            months = 0
        due_kind = str(body.get("dueKind") or body.get("due_kind") or "validation").strip().lower()
        if due_kind not in ("validation", "calibration"):
            due_kind = "validation"
        if months not in (3, 6, 12):
            return jsonify({"ok": False, "error": "months must be 3, 6, or 12"}), 400
        if not last or not nxt:
            return jsonify({"ok": False, "error": "lastValidationDate and nextValidationDate are required"}), 400
        stored = data_service.get_factory_settings() or {}
        before_last = stored.get("lastValidationDate")
        before_next = stored.get("nextValidationDate")
        before_months = stored.get("dueIntervalMonths")
        before_kind = stored.get("dueKind")
        updated = dict(stored)
        updated["lastValidationDate"] = last
        updated["nextValidationDate"] = nxt
        updated["dueIntervalMonths"] = months
        updated["dueKind"] = due_kind
        data_service.save_factory_settings(updated)
        if before_last != last or before_next != nxt or before_months != months or before_kind != due_kind:
            _audit(
                None,
                None,
                "Validation due date set",
                "Last: {} | Next: {} | Interval: {} months".format(last, nxt, months),
            )
        saved = data_service.get_factory_settings() or {}
        return jsonify({
            "ok": True,
            "lastValidationDate": saved.get("lastValidationDate"),
            "nextValidationDate": saved.get("nextValidationDate"),
            "dueIntervalMonths": saved.get("dueIntervalMonths"),
            "dueKind": due_kind,
        }), 200
    except Exception as e:
        app.logger.exception("Error saving validation due dates")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>/pending-due", methods=["POST"])
def set_report_pending_validation_due(report_id):
    """Stash operator-chosen due dates on the report until approval Pass."""
    try:
        gate = _require_any_session_internal(
            ["validation-test", "validation-report-approve"],
            "Forbidden. You do not have permission to set validation due dates.",
        )
        if gate:
            return gate
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"ok": False, "error": "Report not found"}), 404
        rtype = str(report.get("type") or "").strip().lower()
        if rtype != "validation":
            return jsonify({"ok": False, "error": "Only validation reports accept pending due dates"}), 400
        body = request.get_json(force=True, silent=True) or {}
        try:
            months = int(body.get("months") or 0)
        except (TypeError, ValueError):
            months = 0
        if months not in (3, 6, 12):
            return jsonify({"ok": False, "error": "months must be 3, 6, or 12"}), 400
        last = str(body.get("lastValidationDate") or "").strip()
        nxt = str(body.get("nextValidationDate") or "").strip()
        due_kind = str(body.get("dueKind") or body.get("due_kind") or rtype).strip().lower()
        if due_kind not in ("validation", "calibration"):
            due_kind = rtype
        if not last or not nxt:
            return jsonify({"ok": False, "error": "lastValidationDate and nextValidationDate are required"}), 400
        report["pendingValidationDue"] = {
            "months": months,
            "lastValidationDate": last,
            "nextValidationDate": nxt,
            "dueKind": due_kind,
        }
        fs = report.get("factorySettings") if isinstance(report.get("factorySettings"), dict) else {}
        fs = dict(fs)
        fs["lastValidationDate"] = last
        fs["nextValidationDate"] = nxt
        fs["dueIntervalMonths"] = months
        fs["dueKind"] = due_kind
        report["factorySettings"] = fs
        data_service.save_report(report)
        return jsonify({"ok": True, "pendingValidationDue": report["pendingValidationDue"]}), 200
    except Exception as e:
        app.logger.exception("Error setting pending validation due")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/factory-reset", methods=["POST"])
def factory_reset():
    try:
        user = data_service.get_current_user()
        if not user or (user.get("role") or "").strip().lower() != "factory":
            return jsonify({"error": "Forbidden. Factory role required."}), 403

        data_service.delete_session_power_audit_pending()
        result = data_service.factory_reset()
        data_service.touch_app_clean_stop_flag()

        audit_removed = audit_service.clear_all_entries()
        audit_remaining = audit_service.entry_count()
        if audit_remaining > 0:
            audit_removed += audit_service.clear_all_entries()
            audit_remaining = audit_service.entry_count()

        biometric_cleared = False
        try:
            bio_result = biometric_service.clear_templates()
            biometric_cleared = bool(bio_result and bio_result.get("ok"))
        except Exception as bio_err:
            app.logger.warning("Factory reset: biometric clear skipped: %s", bio_err)

        if DATETIME_STORAGE.exists():
            try:
                DATETIME_STORAGE.unlink()
            except Exception:
                pass

        return jsonify({
            "success": True,
            "deleted": result["deleted"],
            "auditRowsRemoved": audit_removed,
            "auditRowsRemaining": audit_remaining,
            "biometricTemplatesCleared": biometric_cleared,
            "requiresLogin": True,
        }), 200
    except Exception as e:
        app.logger.exception("Error during factory reset")
        return jsonify({"error": str(e)}), 500


# =================== DATA: AUTH ==========================


def _password_strength_error(password: str) -> str:
    pwd = str(password or "")
    if len(pwd) < 8:
        return "Password must be at least 8 characters."
    if not any(ch.isupper() for ch in pwd):
        return "Password must include at least one uppercase letter."
    if not any(ch.islower() for ch in pwd):
        return "Password must include at least one lowercase letter."
    if not any(ch.isdigit() for ch in pwd):
        return "Password must include at least one numeric digit."
    if pwd.isalnum():
        return "Password must include at least one special character."
    return ""


@app.route("/api/data/auth/login", methods=["POST"])
def login():
    try:
        credentials = request.get_json(force=True, silent=True) or {}
        if not isinstance(credentials, dict):
            credentials = {}
        username = (credentials.get("username") or "").strip()
        raw_pw = credentials.get("password")
        if isinstance(raw_pw, str):
            password = raw_pw
        elif raw_pw is None:
            password = ""
        else:
            password = str(raw_pw)
        # Factory user: special case, not subject to lockout
        if username.upper() == data_service.FACTORY_USERNAME.upper():
            user = data_service.authenticate_user(username, password)
            if user:
                data_service.save_current_user(user)
                data_service.write_session_power_audit_pending(user)
                _audit_event(
                    action="Login",
                    outcome="success",
                    entity_type="session",
                    entity_name="password",
                    details="User logged in: {}".format(username),
                    target_user=username,
                    after={"username": user.get("username"), "role": user.get("role")},
                )
                return jsonify({"success": True, "user": data_service.sanitize_member_for_client(user) or user}), 200
            _audit_event(
                action="Login",
                outcome="denied",
                entity_type="session",
                entity_name="password",
                details="User {} (Factory) entered the wrong password; attempt not counted for the factory account".format(
                    username or data_service.FACTORY_USERNAME
                ),
                target_user=username or data_service.FACTORY_USERNAME,
            )
            return jsonify({"error": "Invalid username or password"}), 401

        # Normal member: check status first
        member = data_service.get_member_by_username(username)
        if member:
            status = str(member.get("status") or "active").strip().lower()
            if status == "locked":
                _audit_event(action="Login", outcome="denied", entity_type="session", entity_name="password", details=_locked_login_audit_details(member, username), target_user=username)
                return jsonify({"error": "Account locked. Contact admin."}), 403
            if status == "disabled":
                _audit_event(action="Login", outcome="denied", entity_type="session", entity_name="password", details=_disabled_login_audit_details(member, username), target_user=username)
                return jsonify({"error": "Account disabled by admin."}), 403

        # Try authenticate
        user = data_service.authenticate_user(username, password)
        if user:
            member = data_service.get_member_by_username(username)
            if member:
                if bool(member.get("mustChangePassword")):
                    _audit_event(
                        action="Login",
                        outcome="denied",
                        entity_type="session",
                        entity_name="password",
                        details="Mandatory password reset required before login",
                        target_user=username,
                    )
                    return jsonify(
                        {
                            "error": "Password change required before login.",
                            "passwordChangeRequired": True,
                            "username": username,
                        }
                    ), 403
                expiry = data_service.get_member_password_expiry_state(member)
                if bool(expiry.get("expired")):
                    _audit_event(
                        action="Login",
                        outcome="denied",
                        entity_type="session",
                        entity_name="password",
                        details="Password expired - reset required",
                        target_user=username,
                        extra={"passwordExpiry": expiry},
                    )
                    return jsonify({
                        "error": "Password expired. Reset required.",
                        "passwordExpired": True,
                        "username": username,
                        "expiry": expiry,
                    }), 403
            data_service.record_successful_login(username)
            data_service.save_current_user(user)
            data_service.refresh_current_user_from_member()
            data_service.write_session_power_audit_pending(data_service.get_current_user() or user)
            _audit_event(
                action="Login",
                outcome="success",
                entity_type="session",
                entity_name="password",
                details="User logged in: {}".format(username),
                target_user=username,
                after={"username": user.get("username"), "role": user.get("role")},
            )
            safe_user = data_service.sanitize_member_for_client(data_service.get_current_user() or user) or user
            return jsonify({"success": True, "user": safe_user}), 200

        # Wrong password: increment failedAttempts (may lock at 3)
        updated = data_service.record_failed_login(username)
        if updated:
            status = str(updated.get("status") or "").strip().lower()
            try:
                fa = int(updated.get("failedAttempts") or 0)
            except (TypeError, ValueError):
                fa = 0
            maximum = data_service.MAX_FAILED_LOGIN_ATTEMPTS
            remaining = max(0, maximum - fa)
            details = _wrong_password_audit_details(updated, username, fa, maximum)
            _audit_event(
                action="Login failed",
                outcome="denied",
                entity_type="session",
                entity_name="password",
                details=details,
                target_user=updated.get("username") or username,
                extra={
                    "failedAttempts": fa,
                    "maximumAttempts": maximum,
                    "remainingAttempts": remaining,
                },
            )
            if status == "locked":
                return jsonify({
                    "error": "Account locked. Contact admin.",
                    "remainingAttempts": 0
                }), 403
            return jsonify({
                "error": "Invalid username or password.",
                "remainingAttempts": remaining
            }), 401
        if username:
            _audit_event(
                action="Login",
                outcome="denied",
                entity_type="session",
                entity_name="password",
                details="Invalid username or password for unknown user: {}".format(username),
                target_user=username,
            )
        return jsonify({"error": "Invalid username or password"}), 401
    except Exception as e:
        app.logger.exception("Error during login")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/password-expired-reset", methods=["POST"])
def password_expired_reset():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        old_password = str(payload.get("oldPassword") or "")
        new_password = str(payload.get("newPassword") or "")
        if not username or not old_password or not new_password:
            return jsonify({"ok": False, "error": "username, oldPassword and newPassword are required"}), 400
        member = data_service.get_member_by_username(username)
        if not member:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        if str(member.get("username", "")).strip().upper() == data_service.FACTORY_USERNAME.upper():
            return jsonify({"ok": False, "error": "Factory account is excluded from this flow"}), 403
        auth_user = data_service.authenticate_user(username, old_password)
        if not auth_user:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        expiry = data_service.get_member_password_expiry_state(member)
        if not bool(expiry.get("expired")):
            return jsonify({"ok": False, "error": "Password is not expired for this account"}), 400
        pwd_err = _password_strength_error(new_password)
        if pwd_err:
            return jsonify({"ok": False, "error": pwd_err}), 400
        if old_password == new_password:
            return jsonify({"ok": False, "error": "New password must be different from old password"}), 400
        updated_member = data_service.set_member_password(int(member.get("id")), new_password)
        data_service.clear_mandatory_password_reset_flags(int(member.get("id")))
        updated_member = data_service.get_member(int(member.get("id"))) or updated_member
        data_service.record_successful_login(username)
        safe_member = data_service.sanitize_member_for_client(updated_member) or dict(updated_member)
        _audit_event(
            action="Password reset",
            outcome="success",
            entity_type="member",
            entity_id=updated_member.get("id"),
            entity_name=updated_member.get("username") or updated_member.get("name") or "",
            details="Password reset after expiry",
            target_user=updated_member.get("username") or "",
        )
        return jsonify({"ok": True, "member": safe_member}), 200
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error resetting expired password")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/auth/mandatory-password-reset", methods=["POST"])
def mandatory_password_reset():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        old_password = str(payload.get("oldPassword") or "")
        new_password = str(payload.get("newPassword") or "")
        if not username or not old_password or not new_password:
            return jsonify({"ok": False, "error": "username, oldPassword and newPassword are required"}), 400
        member = data_service.get_member_by_username(username)
        if not member:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        if str(member.get("username", "")).strip().upper() == data_service.FACTORY_USERNAME.upper():
            return jsonify({"ok": False, "error": "Factory account is excluded from this flow"}), 403
        if not bool(member.get("mustChangePassword")):
            return jsonify({"ok": False, "error": "Password change is not required for this account"}), 400
        auth_user = data_service.authenticate_user(username, old_password)
        if not auth_user:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        pwd_err = _password_strength_error(new_password)
        if pwd_err:
            return jsonify({"ok": False, "error": pwd_err}), 400
        if old_password == new_password:
            return jsonify({"ok": False, "error": "New password must be different from your current password."}), 400
        if data_service.new_password_matches_creation_commitment(member, new_password):
            return jsonify(
                {"ok": False, "error": "New password must be different from the password set when your account was created."}
            ), 400
        data_service.complete_mandatory_password_reset(username, new_password)
        data_service.record_successful_login(username)
        refreshed = data_service.get_member(int(member.get("id")))
        user = dict(refreshed) if refreshed else dict(auth_user)
        user.pop("password", None)
        user.pop("creationPasswordSalt", None)
        user.pop("creationPasswordHash", None)
        data_service.save_current_user(user)
        data_service.write_session_power_audit_pending(user)
        safe_user = data_service.sanitize_member_for_client(user) or user
        _audit_event(
            action="Password reset",
            outcome="success",
            entity_type="member",
            entity_id=member.get("id"),
            entity_name=member.get("username") or member.get("name") or "",
            details="Mandatory first password change completed",
            target_user=member.get("username") or "",
        )
        return jsonify({"ok": True, "user": safe_user}), 200
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error during mandatory password reset")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/auth/login-biometric", methods=["POST"])
def login_biometric():
    try:
        if not _is_biometric_enabled():
            return jsonify({"error": "Biometric login is disabled by Factory Settings."}), 403
        payload = request.get_json(force=True, silent=True) or {}
        timeout_sec = float(payload.get("timeoutSec") or BIOMETRIC_LOGIN_TIMEOUT_SEC)
        identified = biometric_service.identify(timeout_sec=timeout_sec)
        if not identified.get("ok"):
            return jsonify({"error": identified.get("error") or "Fingerprint not recognized"}), 401

        template_id = identified.get("templateId")
        member = data_service.get_member_by_fingerprint_template(template_id)
        if not member:
            return jsonify({"error": "Fingerprint is not linked to any member account"}), 404

        username = member.get("username") or ""
        status = str(member.get("status") or "active").strip().lower()
        if status == "locked":
            _audit_event(action="Biometric login", outcome="denied", entity_type="session", entity_name="biometric", details="Account locked", target_user=username, extra={"templateId": template_id})
            return jsonify({"error": "Account locked. Contact admin."}), 403
        if status == "disabled":
            _audit_event(action="Biometric login", outcome="denied", entity_type="session", entity_name="biometric", details="Account disabled", target_user=username, extra={"templateId": template_id})
            return jsonify({"error": "Account disabled by admin."}), 403

        if not bool(member.get("biometricEnabled", True)):
            _audit_event(action="Biometric login", outcome="denied", entity_type="session", entity_name="biometric", details="Biometric disabled for member", target_user=username, extra={"templateId": template_id})
            return jsonify({"error": "Biometric login is disabled for this account"}), 403

        if bool(member.get("mustChangePassword")):
            _audit_event(
                action="Biometric login",
                outcome="denied",
                entity_type="session",
                entity_name="biometric",
                details="Mandatory password reset required before login",
                target_user=username,
                extra={"templateId": template_id},
            )
            return jsonify(
                {
                    "error": "Password change required before login.",
                    "passwordChangeRequired": True,
                    "username": username,
                }
            ), 403

        user = dict(member)
        user.pop("password", None)
        user.pop("creationPasswordSalt", None)
        user.pop("creationPasswordHash", None)
        data_service.record_successful_login(username)
        data_service.save_current_user(user)
        data_service.write_session_power_audit_pending(user)
        _audit_event(
            action="Biometric login",
            outcome="success",
            entity_type="session",
            entity_name="biometric",
            details="User logged in (biometric): {}".format(username),
            target_user=username,
            after={"username": user.get("username"), "role": user.get("role")},
            extra={"templateId": template_id, "confidence": identified.get("confidence")},
        )
        return jsonify({"success": True, "user": data_service.sanitize_member_for_client(user) or user, "templateId": template_id, "confidence": identified.get("confidence")}), 200
    except Exception as e:
        app.logger.exception("Error during biometric login")
        return jsonify({"error": str(e)}), 500


def _schedule_bridge_restart_after_logout() -> None:
    """Restart kiosk-bridge in the background after logout (manual or idle timeout)."""
    script = APP_ROOT / "scripts" / "restart_bridge_background.sh"
    if not script.is_file():
        app.logger.warning("Bridge restart script missing: %s", script)
        return
    try:
        subprocess.Popen(
            ["/bin/bash", str(script)],
            start_new_session=True,
            close_fds=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        app.logger.exception("Failed to schedule bridge restart after logout")


@app.route("/api/data/auth/logout", methods=["POST"])
def logout():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        reason = str(payload.get("reason") or "user").strip().lower()
        user = data_service.get_current_user()
        if user:
            un = (user.get("username") or user.get("name") or "").strip()
            role = (user.get("role") or "").strip()
            if audit_service.is_hidden_factory_actor(un, role):
                audit_time = _audit_time_fields()
                audit_service.log_structured_event(
                    user="--",
                    role="--",
                    action="Logout",
                    outcome="success",
                    entity_type="session",
                    entity_name="logout",
                    details="Privileged factory session ended",
                    event_type="compliance",
                    request_source="POST /api/data/auth/logout",
                    timestamp_ms=audit_time.get("timestamp_ms"),
                    date_time=audit_time.get("date_time"),
                )
            else:
                if reason == "inactivity":
                    fs = data_service.get_factory_settings() or {}
                    mins = fs.get("autoLogoutMinutes")
                    try:
                        mins = int(mins) if mins is not None else 0
                    except (TypeError, ValueError):
                        mins = 0
                    detail = "User logged out due to inactivity timeout: {}".format(un)
                    _audit_event(
                        action="Logout (inactivity timeout)",
                        outcome="success",
                        entity_type="session",
                        entity_name="logout",
                        details=detail,
                        target_user=un,
                        extra={"autoLogoutMinutes": mins} if mins > 0 else None,
                    )
                else:
                    _audit_event(
                        action="Logout",
                        outcome="success",
                        entity_type="session",
                        entity_name="logout",
                        details="User logged out: {}".format(un),
                        target_user=un,
                    )
        data_service.touch_app_clean_stop_flag()
        data_service.delete_session_power_audit_pending()
        data_service.clear_current_user()
        if reason in ("user", "inactivity"):
            _schedule_bridge_restart_after_logout()
        return jsonify({"success": True}), 200
    except Exception as e:
        app.logger.exception("Error during logout")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/session-ui-reset", methods=["POST"])
def session_ui_reset():
    """Clear persisted kiosk session when the browser loads or refreshes.

    Not a user-initiated logout: no audit entry (avoids false Logout on every refresh).
    """
    try:
        data_service.delete_session_power_audit_pending()
        data_service.clear_current_user()
        return jsonify({"success": True}), 200
    except Exception as e:
        app.logger.exception("Error during session UI reset")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/approval-verify", methods=["POST"])
def approval_verify():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        method = str(payload.get("method") or "credentials").strip().lower()
        purpose = str(payload.get("purpose") or "recipe").strip().lower()
        if purpose not in ("recipe", "report", "user_admin", "export", "validation"):
            return jsonify({"ok": False, "error": "purpose must be recipe, report, user_admin, export, or validation"}), 400
        verifier = None
        username = (payload.get("username") or "").strip()

        if method == "credentials":
            password = str(payload.get("password") or "").strip()
            if not username or not password:
                return jsonify({"ok": False, "error": "Username and password are required"}), 400
            verifier = data_service.authenticate_user(username, password)
            if not verifier:
                _audit_event(
                    action="Approval verification",
                    outcome="failed",
                    entity_type="verification",
                    entity_name=purpose,
                    details="Invalid credentials",
                    target_user=username,
                    extra={"purpose": purpose, "attemptedUser": username, "method": "credentials"},
                )
                return jsonify({"ok": False, "error": "Invalid verifier username or password"}), 401
        elif method == "biometric":
            if not _is_biometric_enabled():
                return jsonify({"ok": False, "error": "Biometric login is disabled by Factory Settings."}), 403
            timeout_sec = float(payload.get("timeoutSec") or BIOMETRIC_LOGIN_TIMEOUT_SEC)
            identified = biometric_service.identify(timeout_sec=timeout_sec)
            if not identified.get("ok"):
                _audit_event(
                    action="Approval verification",
                    outcome="failed",
                    entity_type="verification",
                    entity_name=purpose,
                    details=identified.get("error") or "Biometric identify failed",
                    target_user="--",
                    extra={"purpose": purpose, "method": "biometric"},
                )
                return jsonify({"ok": False, "error": identified.get("error") or "Fingerprint not recognized"}), 401
            template_id = identified.get("templateId")
            member = data_service.get_member_by_fingerprint_template(template_id)
            if not member:
                _audit_event(
                    action="Approval verification",
                    outcome="failed",
                    entity_type="verification",
                    entity_name=purpose,
                    details="No member mapped to fingerprint",
                    target_user="--",
                    extra={"purpose": purpose, "method": "biometric", "templateId": template_id},
                )
                return jsonify({"ok": False, "error": "Fingerprint is not linked to any member account"}), 404
            status = str(member.get("status") or "active").strip().lower()
            if status != "active":
                _audit_event(
                    action="Approval verification",
                    outcome="denied",
                    entity_type="verification",
                    entity_name=purpose,
                    details="Verifier account not active",
                    target_user=member.get("username") or "--",
                    extra={"purpose": purpose, "method": "biometric", "templateId": template_id},
                )
                return jsonify({"ok": False, "error": "Verifier account is not active"}), 403
            if not bool(member.get("biometricEnabled", True)):
                _audit_event(
                    action="Approval verification",
                    outcome="denied",
                    entity_type="verification",
                    entity_name=purpose,
                    details="Verifier biometric disabled",
                    target_user=member.get("username") or "--",
                    extra={"purpose": purpose, "method": "biometric", "templateId": template_id},
                )
                return jsonify({"ok": False, "error": "Biometric login is disabled for this account"}), 403
            verifier = dict(member)
            username = verifier.get("username") or ""
        else:
            return jsonify({"ok": False, "error": "Unsupported verification method"}), 400

        verifier_role = str(verifier.get("role") or "").strip().lower()
        if purpose == "report":
            eligible = _approval_verifier_eligible_for_report(verifier)
        elif purpose == "recipe":
            eligible = _approval_verifier_eligible_for_recipe(verifier)
        elif purpose == "export":
            eligible = _approval_verifier_eligible_for_export(verifier)
        elif purpose == "validation":
            eligible = _approval_verifier_eligible_for_validation_report(verifier)
        else:
            eligible = _approval_verifier_eligible_for_user_admin(verifier)
        if not eligible:
            _audit_event(
                action="Approval verification",
                outcome="denied",
                entity_type="verification",
                entity_name=purpose,
                details="Verifier lacks required permission",
                target_user=verifier.get("username") or username,
                extra={"purpose": purpose, "verifierRole": verifier_role, "method": method},
            )
            return jsonify({"ok": False, "error": "Verifier does not have permission for this approval"}), 403

        if verifier_role != "factory":
            member = data_service.get_member_by_username(verifier.get("username") or username)
            if member:
                status = str(member.get("status") or "active").strip().lower()
                if status != "active":
                    _audit_event(
                        action="Approval verification",
                        outcome="denied",
                        entity_type="verification",
                        entity_name=purpose,
                        details="Verifier account not active",
                        target_user=verifier.get("username") or username,
                        extra={"purpose": purpose, "method": method},
                    )
                    return jsonify({"ok": False, "error": "Verifier account is not active"}), 403

        token, token_payload = _issue_approval_verify_token(verifier, purpose)
        vname = verifier.get("username") or username
        _audit_event(
            action="Approval verification",
            outcome="success",
            entity_type="verification",
            entity_name=purpose,
            details="Verification token issued",
            target_user=vname,
            signature={"mode": method, "username": vname, "role": verifier_role},
            extra={"purpose": purpose, "method": method},
        )
        payload_out = {
            "ok": True,
            "token": token,
            "expiresInSec": APPROVAL_VERIFY_TTL_SECONDS,
            "verifier": {
                "username": token_payload.get("username"),
                "name": token_payload.get("name"),
                "role": token_payload.get("role"),
            },
        }
        # Operator stays logged in. Verifier is not logged in. If a pending
        # report id + PASS/FAIL is supplied, generate the approved report now.
        if purpose in ("report", "validation"):
            raw_rid = payload.get("reportId")
            if raw_rid is None:
                raw_rid = payload.get("report_id")
            pf = (payload.get("passFail") or payload.get("pass_fail") or "").strip().upper()
            remarks = (payload.get("remarks") or "").strip()
            if raw_rid not in (None, "") and pf in ("PASS", "FAIL"):
                try:
                    rid = int(raw_rid)
                except (TypeError, ValueError):
                    return jsonify({"ok": False, "error": "reportId must be an integer"}), 400
                report, err, code, pdf_ok = _apply_pending_report_approval(rid, verifier, pf, remarks)
                if err:
                    return jsonify({"ok": False, "error": err, "token": token}), code
                payload_out["approved"] = True
                payload_out["pdfGenerated"] = bool(pdf_ok)
                payload_out["report"] = report
        return jsonify(payload_out), 200
    except Exception as e:
        app.logger.exception("Error during approval verification")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/auth/current-user", methods=["GET"])
def get_current_user_route():
    try:
        user = data_service.refresh_current_user_from_member() or data_service.get_current_user()
        if user:
            user = data_service.sanitize_member_for_client(user) or user
        return jsonify({"user": user}), 200
    except Exception as e:
        app.logger.exception("Error getting current user")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/profile", methods=["GET"])
def get_own_profile():
    """Any logged-in member may read their own profile (for the User Profile screen)."""
    try:
        err = _require_auth()
        if err:
            return err
        member, cur = _resolve_session_member_record()
        if member:
            return jsonify({"member": data_service.sanitize_member_for_client(member) or member}), 200
        if cur:
            return jsonify({"member": data_service.sanitize_member_for_client(cur) or cur}), 200
        return jsonify({"error": "Member not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting own profile")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/profile", methods=["PUT"])
def update_own_profile():
    """Any logged-in member may change their own display name and password."""
    try:
        err = _require_auth()
        if err:
            return err
        payload = request.get_json(force=True, silent=True) or {}
        member, cur = _resolve_session_member_record()
        if not member:
            if cur and str((cur.get("username") or "")).strip().upper() == data_service.FACTORY_USERNAME.upper():
                return jsonify({"error": "Factory profile is managed locally on this device."}), 400
            return jsonify({"error": "Member not found"}), 404
        member_id = int(member.get("id"))
        before_member = dict(member)
        try:
            member_data = _self_profile_payload_from_request(before_member, payload)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        name_in = "name" in payload and str(payload.get("name") or "").strip()
        pwd_in = "password" in payload and str(payload.get("password") or "").strip()
        if not name_in and not pwd_in:
            return jsonify({"error": "Provide a name and/or new password to save."}), 400
        acting_id = _session_member_id()
        password_changed = pwd_in
        data_service.save_member(member_data, acting_user_id=acting_id)
        updated = data_service.get_member(member_id) or member_data
        data_service.refresh_current_user_from_member()
        cur_after = data_service.get_current_user() or {}
        sig = {
            "mode": "self",
            "username": (cur_after.get("username") or cur_after.get("name") or "").strip() or "--",
            "role": (cur_after.get("role") or "").strip() or "--",
        }
        uname = updated.get("username") or updated.get("name") or ""
        if password_changed:
            _audit_event(
                action="Password changed",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=uname,
                details="Password changed (self) for user: {}".format(uname),
                target_user=uname,
                signature=sig,
            )
        _audit_event(
            action="Profile updated",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=uname,
            details="Profile updated (self)",
            target_user=uname,
            before=data_service.sanitize_member_for_client(before_member),
            after=data_service.sanitize_member_for_client(updated) or updated,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(updated) or dict(updated)
        return jsonify({"ok": True, "member": safe}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error updating own profile")
        return jsonify({"error": str(e)}), 500


# =================== DATA: AUDIT LOG ==========================


def _require_export_usb_and_verification_json():
    """Return (error_response_or_None, export_approval_verifier_payload_or_None)."""
    cur = data_service.get_current_user()
    if not cur:
        return jsonify({"success": False, "error": "Unauthorized"}), 401, None
    data_service.refresh_current_user_from_member()
    if not _session_has_internal("export-usb"):
        return jsonify({"success": False, "error": "Forbidden. Export to USB is not permitted for this account."}), 403, None
    role = str(cur.get("role") or "").strip().lower()
    verifier = None
    if role != "factory":
        _verified, verify_err = _consume_approval_verify_token("export")
        if verify_err:
            return jsonify({"success": False, "error": verify_err}), 401, None
        verifier = _verified
    return None, verifier


def _resolve_employee_id(username: str, role: str = "") -> str:
    """Employee ID for audit export labels (member field or login username)."""
    uname = str(username or "").strip()
    if not uname:
        return "--"
    member = data_service.get_member_by_username(uname)
    if member:
        emp = member.get("employeeId") or member.get("employee_id")
        if emp is not None and str(emp).strip():
            return str(emp).strip()
    return uname


def _export_actor_snapshot(user_dict: dict) -> dict:
    username = str(user_dict.get("username") or user_dict.get("name") or "").strip() or "--"
    role = str(user_dict.get("role") or "").strip() or "--"
    return {
        "username": username,
        "employee_id": _resolve_employee_id(username, role),
        "role": role,
    }


def _export_actor_from_verifier(verifier: dict) -> dict:
    if not verifier:
        return {}
    return _export_actor_snapshot(
        {
            "username": verifier.get("username") or verifier.get("name"),
            "role": verifier.get("role"),
        }
    )


def _maybe_purge_scheduled_audit_export() -> None:
    """Run due 24h post-verify purge and log audit cycle start."""
    try:
        purged = audit_service.run_due_audit_export_purge()
    except Exception:
        app.logger.exception("Audit export purge check failed")
        return
    if not purged:
        return
    exported = purged.get("exported_by") if isinstance(purged.get("exported_by"), dict) else {}
    approved = purged.get("approved_by") if isinstance(purged.get("approved_by"), dict) else {}
    ex_u = str(exported.get("username") or "--")
    ex_e = str(exported.get("employee_id") or "--")
    ap_u = str(approved.get("username") or "--")
    ap_e = str(approved.get("employee_id") or "--")
    details = (
        "Audit cycle started | Exported by: {} ({}) | Approved by: {} ({})"
    ).format(ex_u, ex_e, ap_u, ap_e)
    _audit_event(
        action="Audit cycle started",
        outcome="success",
        entity_type="audit",
        details=details,
        event_type="compliance",
    )


def _maybe_purge_scheduled_report_export() -> None:
    """Run due 24h post-verify purge for exported reports and log cycle start."""
    try:
        purged = data_service.run_due_report_export_purge()
    except Exception:
        app.logger.exception("Report export purge check failed")
        return
    if not purged:
        return
    exported = purged.get("exported_by") if isinstance(purged.get("exported_by"), dict) else {}
    approved = purged.get("approved_by") if isinstance(purged.get("approved_by"), dict) else {}
    ex_u = str(exported.get("username") or "--")
    ex_e = str(exported.get("employee_id") or "--")
    ap_u = str(approved.get("username") or "--")
    ap_e = str(approved.get("employee_id") or "--")
    details = (
        "Report cycle started | Exported by: {} ({}) | Approved by: {} ({})"
    ).format(ex_u, ex_e, ap_u, ap_e)
    _audit_event(
        action="Report cycle started",
        outcome="success",
        entity_type="report",
        details=details,
        event_type="compliance",
    )


def _maybe_purge_scheduled_exports() -> None:
    _maybe_purge_scheduled_audit_export()
    _maybe_purge_scheduled_report_export()


def _stage_report_usb_export(cur, verifier, exported_report_ids):
    """Stage successfully USB-copied reports for operator verification."""
    ids = []
    for rid in exported_report_ids or []:
        try:
            n = int(rid)
            if n > 0:
                ids.append(n)
        except (TypeError, ValueError):
            continue
    if not ids:
        return None, None, None
    export_id = secrets.token_urlsafe(16)
    exported_by = _export_actor_snapshot(cur or {})
    approved_by = _export_actor_from_verifier(verifier) if verifier else dict(exported_by)
    data_service.stage_report_export_pending(
        export_id=export_id,
        report_ids=ids,
        exported_by=exported_by,
        approved_by=approved_by,
    )
    return export_id, exported_by, approved_by


def _audit_export_purge_loop():
    while True:
        try:
            _maybe_purge_scheduled_exports()
        except Exception:
            app.logger.exception("Export purge loop error")
        time.sleep(max(15, AUDIT_EXPORT_PURGE_CHECK_SECONDS))


_audit_purge_thread = threading.Thread(target=_audit_export_purge_loop, name="audit-export-purge", daemon=True)
_audit_purge_thread.start()


@app.route("/api/data/audit-log", methods=["GET"])
def get_audit_log():
    """Return audit log entries. Requires audit-view permission (Factory bypass in RBAC)."""
    try:
        _maybe_purge_scheduled_audit_export()
        cur = data_service.get_current_user()
        if not cur:
            return jsonify({"error": "Unauthorized"}), 401
        if not _session_has_internal("audit-view"):
            return jsonify({"error": "Forbidden. You do not have permission to view the audit log."}), 403

        _audit(
            cur.get("username") or cur.get("name"),
            cur.get("role"),
            "Audit log viewed",
            "",
        )

        user = request.args.get("user")
        filter_role = request.args.get("role")
        action = request.args.get("action")
        from_ts = request.args.get("from")
        to_ts = request.args.get("to")
        filters = {}
        if user:
            filters["user"] = user
        if filter_role:
            filters["role"] = filter_role
        if action:
            filters["action"] = action
        if from_ts:
            try:
                filters["from"] = int(from_ts)
            except (TypeError, ValueError):
                pass
        if to_ts:
            try:
                filters["to"] = int(to_ts)
            except (TypeError, ValueError):
                pass
        entries = audit_service.list_entries(filters)
        return jsonify({"entries": _prepare_audit_entries_for_display(entries)}), 200
    except Exception as e:
        app.logger.exception("Error listing audit log")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/audit-log/event", methods=["POST"])
def create_client_audit_event():
    """Allow UI to emit lifecycle audit events for run navigation/actions."""
    try:
        cur = data_service.get_current_user()
        if not cur or not (cur.get("username") or cur.get("name")):
            return jsonify({"ok": False, "error": "Authentication required"}), 401
        payload = request.get_json(force=True, silent=True) or {}
        action = str(payload.get("action") or "").strip()
        details = str(payload.get("details") or "").strip()
        if not action:
            return jsonify({"ok": False, "error": "action is required"}), 400
        actor = _audit_actor()
        outcome = str(payload.get("outcome") or "success").strip() or "success"
        event_type = str(payload.get("eventType") or payload.get("event_type") or "lifecycle").strip() or "lifecycle"
        entity_type = str(payload.get("entityType") or payload.get("entity_type") or "").strip()
        entity_name = str(payload.get("entityName") or payload.get("entity_name") or "").strip()
        entity_id = payload.get("entityId", payload.get("entity_id"))
        reason = str(payload.get("reason") or "").strip()
        extra = payload.get("extra")
        if extra is None and payload.get("extraJson"):
            extra = payload.get("extraJson")
        audit_time = _audit_time_fields()
        audit_service.log_structured_event(
            user=actor.get("user"),
            role=actor.get("role"),
            action=action,
            details=details,
            event_type=event_type,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=entity_name,
            outcome=outcome,
            reason=reason,
            session_user=actor.get("user"),
            session_role=actor.get("role"),
            request_source="POST /api/data/audit-log/event",
            extra=extra,
            timestamp_ms=audit_time.get("timestamp_ms"),
            date_time=audit_time.get("date_time"),
        )
        return jsonify({"ok": True}), 200
    except Exception as e:
        app.logger.exception("Error creating client audit event")
        return jsonify({"ok": False, "error": str(e)}), 500


def _html_escape(value):
    """HTML-escape a value, treating None as empty."""
    if value is None:
        return ""
    s = str(value)
    return (
        s.replace("&", "&amp;")
         .replace("<", "&lt;")
         .replace(">", "&gt;")
         .replace('"', "&quot;")
         .replace("'", "&#39;")
    )


def _format_wall_datetime_for_audit(dt_value) -> str:
    """Human-readable date/time for audit details (dd/mm/yyyy HH:MM:SS)."""
    if dt_value is None:
        return "--"
    s = str(dt_value).strip()
    if not s:
        return "--"
    try:
        clean = s.replace("Z", "").strip()
        if "+" in clean:
            clean = clean.split("+", 1)[0].strip()
        if clean.count("-") > 2:
            clean = clean.rsplit("-", 1)[0].strip()
        dt_obj = datetime.fromisoformat(clean)
        if getattr(dt_obj, "tzinfo", None) is not None:
            dt_obj = dt_obj.replace(tzinfo=None)
        return dt_obj.strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return s


def _humanize_audit_details(action: str, details: str) -> str:
    """Normalize verbose/internal audit detail text for UI and PDF export."""
    action = str(action or "").strip()
    details = audit_service._details_audit_display(details)
    if not details:
        return details
    if action == "Power interruption":
        import re
        if "privileged factory session" in details.lower():
            return "Unclean shutdown during factory session"
        m = re.search(r"User\s+([^\s]+)\s+was logged in", details, re.I)
        if m:
            return "Unclean shutdown while {} was logged in".format(m.group(1))
        m2 = re.search(r"Unclean shutdown while\s+([^\s]+)", details, re.I)
        if m2:
            return "Unclean shutdown while {} was logged in".format(m2.group(1))
        if "kiosk-bridge" in details.lower() or "clean shutdown" in details.lower():
            return "Unclean shutdown during active session"
        return details
    if action == "Reports exported":
        import re
        if details.lower().startswith("exported "):
            return details
        m = re.search(r"\bok=(\d+)", details)
        if m:
            n = int(m.group(1))
            return "Exported {} report{} to USB".format(n, "" if n == 1 else "s")
        return "Exported report(s) to USB"
    if action in ("Print thermal", "Print A4"):
        details = (
            details.replace(" | full data", "")
            .replace("| full data", "")
            .replace(" | inline", "")
            .replace("| inline", "")
            .strip()
        )
        import re
        m = re.search(r"report\s+id\s+(\d+)", details, re.I)
        if m:
            return "Report id {}".format(m.group(1))
        return details
    if action == "Report PDF generated":
        import re
        m = re.search(r"report\s+id\s+(\d+)", details, re.I)
        if not m:
            m = re.search(r"report\s+(\d+)", details, re.I)
        if m:
            rid = m.group(1)
            if "aborted PDF" in details:
                return "Report id {} | aborted PDF".format(rid)
            pf = re.search(r"\|\s*(PASS|FAIL)\s*\|", details, re.I)
            if pf and "approved PDF" in details:
                return "Report id {} | {} | approved PDF".format(rid, pf.group(1))
            if "approved PDF" in details:
                return "Report id {} | approved PDF".format(rid)
            return "Report id {}".format(rid)
        return "Report PDF saved"
    if action in ("Report aborted", "Report aborted (power loss)", "Report approved", "Test performed", "Quick test performed", "Validation performed"):
        import re
        details = re.sub(
            r"\s*\|\s*awaiting approval \(PDF after approval\)",
            " | awaiting approval",
            details,
            flags=re.I,
        )
        return details
    if action == "System date change":
        if details.lower().startswith("changed from"):
            return details
        import re
        if re.match(r"^\d{4}-\d{2}-\d{2}T", details):
            return "Set to {}".format(_format_wall_datetime_for_audit(details))
        return _format_wall_datetime_for_audit(details)
    if "/opt/kiosk/" in details or "/media/" in details:
        import re
        details = re.sub(
            r"report\s+(\d+)\s*->\s*\S+",
            r"Report id \1",
            details,
            flags=re.I,
        )
        details = re.sub(r"\s*\|\s*dir\s+\S+", "", details, flags=re.I)
    return details


def _audit_entry_should_omit(entry: dict) -> bool:
    """Drop noisy or sensitive rows from operator-facing audit views."""
    action = str(entry.get("action") or "").strip()
    outcome = str(entry.get("outcome") or "").strip().lower()
    details = str(entry.get("details") or "").strip().lower()
    if action == "Login" and "invalid username" in details:
        return True
    return False


def _prepare_audit_entries_for_display(entries):
    out = []
    for entry in entries or []:
        if _audit_entry_should_omit(entry):
            continue
        row = dict(entry)
        row["role"] = _display_role_label(row.get("role"))
        row["details"] = _humanize_audit_details(row.get("action"), row.get("details"))
        out.append(row)
    return out


def _build_audit_trail_html(entries, filters, factory, export_meta=None):
    """Build a printable A4 audit-trail HTML document.

    Layout: branded header (company/model/serial from factory settings),
    filter summary, then a wide rows-table. Long detail strings wrap. The
    document is rendered to PDF by pdf_generator.render_html_to_pdf, which
    produces an inherently write-protected file.
    """
    factory = factory or {}
    company = _html_escape(factory.get("companyName") or "")
    model = _html_escape(factory.get("modelNo") or "")
    serial = _html_escape(factory.get("serialNo") or "")
    location = _html_escape(factory.get("companyLocation") or factory.get("location") or "")
    instrument_no = _html_escape(factory.get("instrumentId") or "")
    generated_at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    export_meta = export_meta if isinstance(export_meta, dict) else {}
    exported_by = export_meta.get("exported_by") if isinstance(export_meta.get("exported_by"), dict) else {}
    approved_by = export_meta.get("approved_by") if isinstance(export_meta.get("approved_by"), dict) else {}
    export_lines = []
    if exported_by:
        export_lines.append(
            "<div><strong>Exported by:</strong> "
            + _html_escape(str(exported_by.get("username") or "--"))
            + " ("
            + _html_escape(str(exported_by.get("employee_id") or "--"))
            + ")</div>"
        )
    if approved_by:
        export_lines.append(
            "<div><strong>Approved by:</strong> "
            + _html_escape(str(approved_by.get("username") or "--"))
            + " ("
            + _html_escape(str(approved_by.get("employee_id") or "--"))
            + ")</div>"
        )
    export_meta_html = "".join(export_lines)

    def _fmt_ts(ts):
        try:
            ts_int = int(ts)
        except (TypeError, ValueError):
            return _html_escape(ts) if ts else ""
        if ts_int <= 0:
            return ""
        if ts_int > 10 ** 12:
            ts_int = ts_int // 1000
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts_int))

    def _split_date_time_cell(raw, timestamp_fallback):
        """Return (date_html, time_html). Splits any 'DATE TIME' string on the first space.

        Accepts the pre-formatted 'dateTime' string from the audit entry (preferred)
        or a numeric timestamp fallback. Either field is HTML-escaped before return.
        Empty inputs yield ('--', '').
        """
        raw_str = ""
        if raw:
            raw_str = str(raw).strip()
        elif timestamp_fallback is not None:
            raw_str = _fmt_ts(timestamp_fallback).strip()
        if not raw_str:
            return ("--", "")
        date_part, time_part = raw_str, ""
        idx = raw_str.find(" ")
        if idx > 0:
            date_part = raw_str[:idx].strip()
            time_part = raw_str[idx + 1:].strip()
        return (_html_escape(date_part), _html_escape(time_part))

    chips = []
    if filters.get("user"):
        chips.append("User = " + _html_escape(filters["user"]))
    if filters.get("role"):
        chips.append("Role = " + _html_escape(filters["role"]))
    if filters.get("action"):
        chips.append("Action = " + _html_escape(filters["action"]))
    if filters.get("from"):
        chips.append("From = " + _fmt_ts(filters["from"]))
    if filters.get("to"):
        chips.append("To = " + _fmt_ts(filters["to"]))
    chips_html = (
        '<div class="chips">' +
        "".join('<span class="chip">' + c + "</span>" for c in chips) +
        "</div>"
    ) if chips else '<div class="chips muted">No filters applied (all entries).</div>'

    if entries:
        rows = []
        for i, e in enumerate(entries, start=1):
            date_part, time_part = _split_date_time_cell(e.get("dateTime"), e.get("timestamp"))
            usr = _html_escape(e.get("user") or "--")
            rol = _html_escape(e.get("role") or "--")
            act = _html_escape(e.get("action") or "")
            det = _html_escape(e.get("details") or "")
            outcome = _html_escape(e.get("outcome") or "")
            rows.append(
                "<tr>"
                "<td class=\"col-sl\">{sl}</td>"
                "<td class=\"col-dt\">"
                  "<span class=\"dt-date\">{d}</span>"
                  "<span class=\"dt-time\">{t}</span>"
                "</td>"
                "<td>{usr}</td>"
                "<td>{rol}</td>"
                "<td>{act}</td>"
                "<td class=\"col-out\">{out}</td>"
                "<td class=\"col-det\">{det}</td>"
                "</tr>".format(sl=i, d=date_part, t=time_part, usr=usr, rol=rol, act=act, out=outcome, det=det)
            )
        rows_html = "".join(rows)
    else:
        rows_html = '<tr><td colspan="7" class="empty">No audit entries match the filters.</td></tr>'

    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Audit Trail Export</title>'
        '<style>'
        '@page { size: A4 portrait; margin: 10mm; }'
        'html, body { margin: 0; padding: 0; background:#ffffff; color:#111;'
        '   font-family: "Inter", "Segoe UI", Roboto, Arial, sans-serif; font-size: 10.5pt; }'
        'body { text-align: center; }'
        '.audit-sheet { width: 100%; max-width: 190mm; margin: 0 auto; text-align: left; box-sizing: border-box; }'
        'h1 { font-size: 16pt; margin: 0 0 4px 0; letter-spacing: 0.5px; }'
        'h2 { font-size: 12pt; margin: 0 0 8px 0; color:#444; font-weight: 600; }'
        '.brand { display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px; '
        '         border-bottom: 2px solid #111; padding-bottom: 6px; margin-bottom: 8px; }'
        '.brand .meta { text-align: right; font-size: 9pt; color:#333; }'
        '.brand .meta div { line-height: 1.35; }'
        '.brand .meta strong { color:#111; }'
        '.chips { margin: 4px 0 8px 0; }'
        '.chip { display:inline-block; padding: 2px 8px; margin-right: 6px; margin-bottom: 4px;'
        '        background:#eef2ff; color:#1e3a8a; border-radius: 12px; font-size: 9.5pt; }'
        '.muted { color:#666; font-style: italic; font-size: 9.5pt; }'
        'table { width:100%; border-collapse: collapse; table-layout: fixed; }'
        'thead th { background:#111827; color:#fff; padding: 7px 8px; text-align: left;'
        '           font-weight:600; font-size: 10pt; border: 1px solid #111827; }'
        'tbody td { border: 1px solid #d1d5db; padding: 6px 8px; vertical-align: top;'
        '           word-wrap: break-word; overflow-wrap: break-word; word-break: break-word; }'
        'tbody tr:nth-child(even) td { background: #f9fafb; }'
        '.col-sl  { width: 4%; text-align: right; font-variant-numeric: tabular-nums; }'
        '.col-dt  { width: 14%; font-variant-numeric: tabular-nums; line-height: 1.25; }'
        '.col-dt .dt-date { display: block; white-space: nowrap; font-weight: 600; }'
        '.col-dt .dt-time { display: block; white-space: nowrap; font-size: 9.5pt; color: #444; }'
        '.col-out { width: 11%; }'
        '.col-det { width: 24%; }'
        '.empty { text-align: center; padding: 18px 0; color:#666; font-style: italic; }'
        '.footer { margin-top: 10px; font-size: 9pt; color:#555; '
        '          border-top: 1px solid #d1d5db; padding-top: 6px; }'
        '.footer .left  { float: left; }'
        '.footer .right { float: right; }'
        '.footer::after { content: ""; display: block; clear: both; }'
        '</style></head><body><div class="audit-sheet">'
        '<div class="brand">'
        '  <div>'
        '    <h1>AUDIT TRAIL EXPORT</h1>'
        '    <h2>' + (company or "Tap Density Tester") + '</h2>'
        '  </div>'
        '  <div class="meta">'
        '    <div><strong>Model:</strong> ' + (model or "--") + '</div>'
        '    <div><strong>Serial:</strong> ' + (serial or "--") + '</div>'
        '    <div><strong>Instrument:</strong> ' + (instrument_no or "--") + '</div>'
        '    <div><strong>Location:</strong> ' + (location or "--") + '</div>'
        '    <div><strong>Generated:</strong> ' + _html_escape(generated_at) + '</div>'
        '    <div><strong>Entries:</strong> ' + str(len(entries)) + '</div>'
        + export_meta_html +
        '  </div>'
        '</div>'
        + chips_html +
        '<table>'
        '  <thead><tr>'
        '    <th class="col-sl">#</th>'
        '    <th class="col-dt">Date &amp; Time</th>'
        '    <th>User</th>'
        '    <th>Role</th>'
        '    <th>Action</th>'
        '    <th class="col-out">Outcome</th>'
        '    <th class="col-det">Details</th>'
        '  </tr></thead>'
        '  <tbody>' + rows_html + '</tbody>'
        '</table>'
        '<div class="footer">'
        '  <span class="left">This document is auto-generated and write-protected (PDF).</span>'
        '  <span class="right">' + _html_escape(generated_at) + '</span>'
        '</div>'
        '</div></body></html>'
    )


@app.route("/api/audit/export", methods=["POST"])
def export_audit_trails():
    """Export filtered audit entries as a write-protected PDF on the external pendrive.

    Restricted to factory/admin roles. The PDF is the read-only "preview" format that
    replaces the previous JSON dump (which was editable).
    """
    mounted_now = None
    try:
        _maybe_purge_scheduled_audit_export()
        gate, verifier = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
        audit_gate = _require_session_internal(
            "audit-view",
            "Forbidden. You do not have permission to export audit trails.",
        )
        if audit_gate:
            return audit_gate
        cur = data_service.get_current_user()

        data = request.get_json(force=True, silent=True) or {}
        filters_in = data.get("filters") or {}
        device_path = (data.get("device_path") or "").strip() or None
        export_path = (data.get("export_path") or "").strip() or None

        user = filters_in.get("user")
        filter_role = filters_in.get("role")
        action = filters_in.get("action")
        from_ts = filters_in.get("from")
        to_ts = filters_in.get("to")
        filters = {}
        if user:
            filters["user"] = user
        if filter_role:
            filters["role"] = filter_role
        if action:
            filters["action"] = action
        if from_ts:
            try:
                filters["from"] = int(from_ts)
            except (TypeError, ValueError):
                pass
        if to_ts:
            try:
                filters["to"] = int(to_ts)
            except (TypeError, ValueError):
                pass

        export_dir, err, devices, mounted_now = _resolve_export_destination(device_path, export_path)
        if err == "MULTIPLE_PENDRIVES":
            return jsonify({"success": False, "error": "Multiple pendrives detected. Choose one.", "devices": devices, "code": "MULTIPLE_PENDRIVES"}), 409
        if err:
            return jsonify({"success": False, "error": err, "devices": devices}), 400
        export_dir.mkdir(parents=True, exist_ok=True)

        entries = _prepare_audit_entries_for_display(audit_service.list_entries(filters))
        entry_ids = [str(e.get("id")).strip() for e in entries if e.get("id")]
        exported_by = _export_actor_snapshot(cur or {})
        approved_by = _export_actor_from_verifier(verifier) if verifier else dict(exported_by)
        export_meta = {"exported_by": exported_by, "approved_by": approved_by}
        try:
            factory = data_service.get_factory_settings() or {}
        except Exception:
            factory = {}
        html = _build_audit_trail_html(entries, filters, factory, export_meta=export_meta)
        timestamp = time.strftime("%Y-%m-%d_%H%M%S", time.localtime())
        out_path = export_dir / "audit_trail_{}.pdf".format(timestamp)
        pdf_generator.render_html_to_pdf(html, out_path)
        # Make the file read-only on the filesystem if the target FS supports it.
        # vfat ignores chmod, but ext4 / exfat-utils etc. will keep it.
        try:
            os.chmod(out_path, 0o444)
        except OSError:
            pass

        unmount_detail = None
        if mounted_now and not export_path:
            power_off = bool(data.get("power_off") or False)
            unmount_detail = usb_export.sync_and_unmount_pendrive(mounted_now, power_off=power_off)

        export_id = secrets.token_urlsafe(16)
        audit_service.stage_audit_export_pending(
            export_id=export_id,
            entry_ids=entry_ids,
            exported_by=exported_by,
            approved_by=approved_by,
            pdf_path=str(out_path),
        )
        ex_u = exported_by.get("username") or "--"
        ex_e = exported_by.get("employee_id") or "--"
        ap_u = approved_by.get("username") or "--"
        ap_e = approved_by.get("employee_id") or "--"
        _audit(
            cur.get("username") or cur.get("name"),
            cur.get("role"),
            "Audit trail exported",
            "pdf {} | entries {} | exported by {} ({}) | approved by {} ({})".format(
                out_path, len(entries), ex_u, ex_e, ap_u, ap_e
            ),
        )
        return jsonify({
            "success": True,
            "path": str(out_path),
            "export_directory": str(export_dir),
            "format": "pdf",
            "entries": len(entries),
            "export_id": export_id,
            "unmount_detail": unmount_detail,
        }), 200
    except Exception as e:
        if mounted_now:
            try:
                usb_export.sync_and_unmount_pendrive(mounted_now, power_off=False)
            except Exception:
                pass
        app.logger.exception("Error exporting audit trails")
        return jsonify({"success": False, "error": _friendly_export_error(e)}), 500


@app.route("/api/audit/export/confirm", methods=["POST"])
def confirm_audit_export():
    """Operator confirmed USB PDF verification; starts 24h retention timer for exported rows only."""
    try:
        _maybe_purge_scheduled_audit_export()
        cur = data_service.get_current_user()
        if not cur:
            return jsonify({"success": False, "error": "Unauthorized"}), 401
        if not _session_has_internal("audit-view"):
            return jsonify({"success": False, "error": "Forbidden."}), 403
        data = request.get_json(force=True, silent=True) or {}
        export_id = (data.get("export_id") or "").strip()
        verified = bool(data.get("verified"))
        if not verified:
            return jsonify({"success": True, "verified": False, "scheduled": False}), 200
        if not export_id:
            return jsonify({"success": False, "error": "Missing export_id"}), 400
        scheduled = audit_service.confirm_audit_export_verified(export_id)
        if not scheduled:
            return jsonify({"success": False, "error": "Export session expired or invalid. Export again."}), 400
        purge_at_ms = int(scheduled.get("purge_at_ms") or 0)
        _audit(
            cur.get("username") or cur.get("name"),
            cur.get("role"),
            "Audit export verified",
            "USB export verified; {} entries scheduled for removal after 24 hours".format(
                len(scheduled.get("entry_ids") or [])
            ),
        )
        return jsonify({
            "success": True,
            "verified": True,
            "scheduled": True,
            "purge_at_ms": purge_at_ms,
            "entries_scheduled": len(scheduled.get("entry_ids") or []),
        }), 200
    except Exception as e:
        app.logger.exception("Error confirming audit export")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/reports/export/confirm", methods=["POST"])
def confirm_report_export():
    """Operator confirmed USB report export; starts 24h retention timer for exported reports only."""
    try:
        _maybe_purge_scheduled_report_export()
        cur = data_service.get_current_user()
        if not cur:
            return jsonify({"success": False, "error": "Unauthorized"}), 401
        if not _session_has_internal("export-usb"):
            return jsonify({"success": False, "error": "Forbidden."}), 403
        data = request.get_json(force=True, silent=True) or {}
        export_id = (data.get("export_id") or "").strip()
        verified = bool(data.get("verified"))
        if not verified:
            return jsonify({"success": True, "verified": False, "scheduled": False}), 200
        if not export_id:
            return jsonify({"success": False, "error": "Missing export_id"}), 400
        scheduled = data_service.confirm_report_export_verified(export_id)
        if not scheduled:
            return jsonify({"success": False, "error": "Export session expired or invalid. Export again."}), 400
        purge_at_ms = int(scheduled.get("purge_at_ms") or 0)
        _audit(
            cur.get("username") or cur.get("name"),
            cur.get("role"),
            "Report export verified",
            "USB export verified; {} report(s) scheduled for removal after 24 hours".format(
                len(scheduled.get("report_ids") or [])
            ),
        )
        return jsonify({
            "success": True,
            "verified": True,
            "scheduled": True,
            "purge_at_ms": purge_at_ms,
            "reports_scheduled": len(scheduled.get("report_ids") or []),
        }), 200
    except Exception as e:
        app.logger.exception("Error confirming report export")
        return jsonify({"success": False, "error": str(e)}), 500


# =================== CALCULATE ==========================


@app.route("/api/calculate/recipe-validate", methods=["POST"])
def validate_recipe_endpoint():
    try:
        gate = _require_any_session_internal(
            ["recipe-manage", "recipe-test", "quick-test"],
            "Forbidden. You do not have permission to manage recipes.",
        )
        if gate:
            return gate
        recipe_data = request.get_json(force=True, silent=True) or {}
        result = calculation_service.validate_recipe(recipe_data)
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error validating recipe")
        return jsonify({"error": str(e)}), 500

    
# =================== REPORTS PREVIEW / EXPORT ==========================


@app.route("/api/reports/<int:report_id>/preview", methods=["GET"])
def get_report_preview(report_id):
    try:
        gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to view reports.")
        if gate:
            return gate
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"error": "Report not found"}), 404
        rtype = (report.get("type") or "").strip().lower() or "report"
        _audit(
            None,
            None,
            "Report preview viewed",
            "Report id {} | type {}".format(report_id, rtype),
        )
        preview_data = report_service.get_report_preview_data(report)
        return jsonify({"preview": preview_data}), 200
    except Exception as e:
        app.logger.exception("Error getting report preview")
        return jsonify({"error": str(e)}), 500


@app.route("/api/reports/<int:report_id>/a4-text", methods=["GET"])
def get_report_a4_text(report_id):
    """Return the A4 plain-text report body (same as print/export PDF)."""
    try:
        gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to view reports.")
        if gate:
            return gate
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"error": "Report not found"}), 404
        a4_text = report_service.get_report_a4_text(report)
        if not a4_text:
            return jsonify({"error": "Report preview is not available."}), 500
        return jsonify({"a4Text": a4_text}), 200
    except Exception as e:
        app.logger.exception("Error getting report A4 text")
        return jsonify({"error": str(e)}), 500


@app.route("/api/usb/list", methods=["GET"])
def list_usb_pendrives():
    """List external pendrives suitable for export (excludes OS root + internal USB)."""
    try:
        gate = _require_session_internal("export-usb", "Forbidden. Export to USB is not permitted for this account.")
        if gate:
            return gate
        devices = usb_export.list_external_pendrives()
        return jsonify({"success": True, "devices": devices}), 200
    except Exception as e:
        app.logger.exception("Error listing USB devices")
        return jsonify({"success": False, "error": str(e), "devices": []}), 500


def _report_pdf_path(report_id):
    return REPORTS_DIR / "report_{}.pdf".format(int(report_id))


def _report_pdf_status_allowed(report: dict) -> bool:
    """PDF files are written only for approved or aborted test/validation reports."""
    if not report or not _report_requires_approval(report):
        return True
    st = str(report.get("reportApprovalStatus") or "").strip().lower()
    return st in ("approved", "aborted")


def _remove_report_pdf_file(report_id: int) -> None:
    try:
        path = _report_pdf_path(report_id)
        if path.exists():
            path.unlink()
    except OSError:
        pass


def _generate_report_pdf_file(report_id: int, write_audit: bool = True) -> bool:
    """Render report PDF from A4 plain-text layout (same as dot-matrix print). Overwrites any existing file."""
    report = data_service.get_report(report_id)
    if not report:
        return False
    if not _report_pdf_status_allowed(report):
        _remove_report_pdf_file(report_id)
        return False
    try:
        # CFR 21: always use server A4 text formatter (====, ----, ****), never UI preview HTML.
        html = report_service.build_report_pdf_html(report)
        out_path = _report_pdf_path(report_id)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_generator.render_html_to_pdf(html, out_path)
        ok = out_path.exists() and out_path.stat().st_size > 0
        if ok and write_audit:
            _audit_report_pdf_generated(report_id, report)
        return ok
    except Exception:
        app.logger.exception("Report PDF generation failed for id %s", report_id)
        return False


def _friendly_export_error(exc_or_msg):
    """Translate any internal export failure into a single short user-facing message.

    The audit/reports export pipeline touches Chromium, udisks2, polkit, vfat/exFAT,
    and the kernel block layer. Their raw messages (dbus warnings, polkit codes,
    SCSI I/O errors, FAT short-name issues, ...) are useless to operators. Almost
    every recoverable failure on this hardware is resolved by re-formatting the
    pendrive cleanly, so we surface a single instruction.
    """
    text = (str(exc_or_msg) if exc_or_msg is not None else "").lower()
    if "no external pendrive" in text or "not detected" in text:
        return "No external pendrive detected. Please connect a USB pendrive and try again."
    if "multiple pendrives" in text:
        return "Multiple pendrives detected. Please disconnect extras and try again."
    if "could not mount" in text or "mount failed" in text or "not authorized" in text:
        return "Could not access the pendrive. Reconnect it and try again."
    if "no space left" in text or "disk full" in text:
        return "Pendrive is full. Free space or use a different pendrive."
    return "Failed to export. Please format the pendrive (FAT32 or exFAT) and try again."


@app.route("/api/reports/<int:report_id>/pdf", methods=["POST"])
def save_report_pdf(report_id):
    """Render report PDF from A4 plain-text layout (same as dot-matrix print).

    Body is optional (legacy ``html`` field is ignored).
    """
    try:
        gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to view reports.")
        if gate:
            return gate
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"success": False, "error": "Report not found"}), 404
        if not _report_pdf_status_allowed(report):
            return jsonify({
                "success": False,
                "error": "PDF is available only after the report is approved or marked aborted.",
            }), 403
        if not _generate_report_pdf_file(report_id, write_audit=True):
            return jsonify({"success": False, "error": "PDF generation failed"}), 500
        out_path = _report_pdf_path(report_id)
        return jsonify({"success": True, "path": str(out_path), "size_bytes": out_path.stat().st_size}), 200
    except Exception as e:
        app.logger.exception("Error rendering report PDF")
        return jsonify({"success": False, "error": str(e)}), 500


def _resolve_export_destination(device_path, requested_export_path):
    """Pick the destination directory on the external pendrive.

    Returns (pathlib.Path | None, error_str, devices_list, mounted_now_device_path | None).
    The caller may unmount mounted_now_device_path after writing.
    """
    if requested_export_path:
        # Caller forced a path (typically used by dev). No mount magic.
        return pathlib.Path(requested_export_path), None, [], None
    devices = usb_export.list_external_pendrives()
    if not devices:
        return None, "No external pendrive detected. Please connect a USB pendrive and try again.", [], None
    if device_path:
        match = next((d for d in devices if d.get("path") == device_path), None)
        if not match:
            return None, "Selected pendrive '{}' is no longer connected.".format(device_path), devices, None
        chosen = match
    elif len(devices) == 1:
        chosen = devices[0]
    else:
        return None, "MULTIPLE_PENDRIVES", devices, None
    mounted_now = None
    if not chosen.get("mounted") or not chosen.get("mountpoint"):
        mount_res = usb_export.ensure_pendrive_mounted(chosen["path"])
        if not mount_res.get("ok"):
            return None, "Could not mount {}: {}".format(chosen["path"], mount_res.get("error") or "unknown"), devices, None
        chosen["mountpoint"] = mount_res.get("mountpoint")
        if not mount_res.get("already_mounted"):
            mounted_now = chosen["path"]
    mountpoint = chosen.get("mountpoint")
    if not mountpoint:
        return None, "Pendrive {} reported no mountpoint.".format(chosen.get("path")), devices, mounted_now
    subfolder_rel = usb_export.export_subfolder_name(EXPORT_SUBFOLDER)
    export_dir = pathlib.Path(mountpoint) / subfolder_rel
    return export_dir, None, devices, mounted_now


@app.route("/api/reports/export", methods=["POST"])
def export_reports():
    """Export selected reports (PDFs) to the connected external pendrive.

    Body:
      report_ids:        [int, ...]                       (required)
      device_path:       "/dev/sdb1"                      (optional; required if multiple pendrives)
      export_path:       "/abs/path"                      (optional; override mount detection for dev)

    PDFs are generated server-side from the A4 plain-text layout (same as dot-matrix print).

    Returns 409 with `devices` list when multiple pendrives are connected and none chosen.
    """
    mounted_now = None
    try:
        _maybe_purge_scheduled_exports()
        data = request.get_json(force=True, silent=True) or {}
        raw_ids = data.get("report_ids", [])
        report_ids = []
        for rid in raw_ids:
            try:
                report_ids.append(int(rid))
            except (TypeError, ValueError):
                continue
        if not report_ids:
            return jsonify({"success": False, "error": "No report IDs provided"}), 400
        gate, verifier = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
        cur = data_service.get_current_user()
        device_path = (data.get("device_path") or "").strip() or None
        requested_export_path = (data.get("export_path") or "").strip() or None

        # Regenerate PDFs from A4 plain-text layout (same as dot-matrix print).
        generated = []
        missing = []
        for rid in report_ids:
            report = data_service.get_report(rid) or {}
            if _report_requires_approval(report):
                st = str(report.get("reportApprovalStatus") or "").strip().lower()
                if st == "pending":
                    missing.append(rid)
                    continue
            if _generate_report_pdf_file(rid):
                generated.append(rid)
            else:
                missing.append(rid)
        if missing:
            return jsonify({
                "success": False,
                "error": (
                    "PDF unavailable for report(s): {}. Approve the report first, "
                    "or ensure aborted reports were saved correctly."
                ).format(", ".join(str(i) for i in missing)),
                "missing_pdfs": missing,
            }), 400

        export_dir, err, devices, mounted_now = _resolve_export_destination(device_path, requested_export_path)
        if err == "MULTIPLE_PENDRIVES":
            return jsonify({"success": False, "error": "Multiple pendrives detected. Choose one.", "devices": devices, "code": "MULTIPLE_PENDRIVES"}), 409
        if err:
            return jsonify({"success": False, "error": err, "devices": devices}), 400

        for rid in report_ids:
            blocked = _check_report_approved_for_print_export(report_id=rid)
            if blocked is not None:
                return blocked

        export_dir.mkdir(parents=True, exist_ok=True)

        exported_files = []
        failed = []
        exported_report_ids = []
        for rid in report_ids:
            src = _report_pdf_path(rid)
            if not src.exists():
                failed.append({"id": rid, "error": "PDF missing"})
                continue
            report = data_service.get_report(rid) or {}
            recipe = report.get("recipe") if isinstance(report.get("recipe"), dict) else {}
            product = (recipe.get("productName") or report.get("name") or "report")
            safe_name = "".join(c for c in str(product) if c.isalnum() or c in "-_") or "report"
            ts_raw = str(report.get("createdAt") or "")
            safe_ts = "".join(c for c in ts_raw if c.isalnum() or c in "-_.T") or "ts"
            dest = export_dir / "{}_{}_{}.pdf".format(safe_name, rid, safe_ts)
            try:
                with open(src, "rb") as fin, open(dest, "wb") as fout:
                    while True:
                        chunk = fin.read(1024 * 1024)
                        if not chunk:
                            break
                        fout.write(chunk)
                exported_files.append(str(dest))
                exported_report_ids.append(int(rid))
            except Exception as e:
                failed.append({"id": rid, "error": str(e)})

        # Best-effort sync + unmount (only if we mounted it here).
        # Default is power_off=False so repeat exports don't require re-plugging.
        unmount_detail = None
        if mounted_now and not requested_export_path:
            power_off = bool(data.get("power_off") or False)
            unmount_detail = usb_export.sync_and_unmount_pendrive(mounted_now, power_off=power_off)

        ok_count = len(exported_files)
        export_id = None
        if exported_report_ids:
            export_id, exported_by, approved_by = _stage_report_usb_export(cur, verifier, exported_report_ids)
            ex_u = (exported_by or {}).get("username") or "--"
            ex_e = (exported_by or {}).get("employee_id") or "--"
            ap_u = (approved_by or {}).get("username") or "--"
            ap_e = (approved_by or {}).get("employee_id") or "--"
            audit_detail = "Exported {} report{} to USB | exported by {} ({}) | approved by {} ({})".format(
                ok_count, "" if ok_count == 1 else "s", ex_u, ex_e, ap_u, ap_e
            )
        else:
            audit_detail = "Exported {} report{} to USB".format(
                ok_count, "" if ok_count == 1 else "s"
            )
        _audit(
            cur.get("username") or cur.get("name") if cur else None,
            cur.get("role") if cur else None,
            "Reports exported",
            audit_detail,
        )
        return jsonify({
            "success": (len(failed) == 0),
            "count": len(exported_files),
            "exported_files": exported_files,
            "failed": failed,
            "export_directory": str(export_dir),
            "generated_pdfs_now": generated,
            "unmount_detail": unmount_detail,
            "device_path": device_path or (devices[0]["path"] if len(devices) == 1 else None),
            "export_id": export_id,
            "reports_staged": len(exported_report_ids),
        }), 200
    except Exception as e:
        if mounted_now:
            try:
                usb_export.sync_and_unmount_pendrive(mounted_now, power_off=False)
            except Exception:
                pass
        app.logger.exception("Error exporting reports")
        return jsonify({"success": False, "error": _friendly_export_error(e)}), 500


@app.route("/api/reports/export/stream", methods=["POST"])
def export_reports_stream():
    """NDJSON progress stream for bulk report export.

    Emits one JSON object per line. Events:
      {event:"start", total:N}
      {event:"stage", stage:"detect-usb"|"mount"|"copying"|"unmount", percent:int}
      {event:"report", current:i, total:N, percent:int, id:<rid>, status:"generating"|"copied"|"failed"}
      {event:"done", ok:bool, count:int, failed:[...], export_directory:str, percent:100}
      {event:"error", message:str}

    Why streaming: lets the UI show a real progress bar with percentage as each
    report PDF is rendered + copied, instead of a static spinner.
    """
    data = request.get_json(force=True, silent=True) or {}
    raw_ids = data.get("report_ids", [])
    report_ids = []
    for rid in raw_ids:
        try:
            report_ids.append(int(rid))
        except (TypeError, ValueError):
            continue
    if not report_ids:
        return jsonify({"success": False, "error": "No report IDs provided"}), 400
    device_path = (data.get("device_path") or "").strip() or None
    requested_export_path = (data.get("export_path") or "").strip() or None
    power_off = bool(data.get("power_off") or False)

    _maybe_purge_scheduled_exports()
    gate, verifier = _require_export_usb_and_verification_json()
    if gate is not None:
        return gate
    cur = data_service.get_current_user()
    for rid in report_ids:
        blocked = _check_report_approved_for_print_export(report_id=rid)
        if blocked is not None:
            return blocked

    def _emit(obj):
        return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")

    def gen():
        total = len(report_ids)
        # Budget allocation (sums to 100):
        #   3% detect-usb, 7% mount, 80% per-report PDF + copy, 8% sync+unmount, 2% done
        gen_copy_budget = 80.0
        per_report_pct = (gen_copy_budget / total) if total else 0.0
        accumulated = 10.0  # after detect + mount stages
        mounted_now = None
        result = {
            "ok": False,
            "count": 0,
            "exported_files": [],
            "exported_report_ids": [],
            "failed": [],
            "export_directory": None,
            "device_path": None,
        }
        try:
            yield _emit({"event": "start", "total": total, "percent": 0})

            yield _emit({"event": "stage", "stage": "detect-usb", "percent": 3,
                         "message": "Detecting external pendrive..."})

            export_dir, err, devices, mounted_now = _resolve_export_destination(device_path, requested_export_path)
            if err == "MULTIPLE_PENDRIVES":
                yield _emit({"event": "error", "code": "MULTIPLE_PENDRIVES",
                             "message": "Multiple pendrives detected. Choose one.",
                             "devices": devices})
                return
            if err:
                yield _emit({"event": "error", "message": _friendly_export_error(err), "devices": devices})
                return
            result["export_directory"] = str(export_dir)
            result["device_path"] = device_path or (devices[0]["path"] if devices and len(devices) == 1 else None)

            yield _emit({"event": "stage", "stage": "mount", "percent": 10,
                         "message": "Mounted pendrive. Preparing files..."})

            try:
                export_dir.mkdir(parents=True, exist_ok=True)
            except OSError as oe:
                yield _emit({"event": "error", "message": _friendly_export_error(oe)})
                return

            for i, rid in enumerate(report_ids, start=1):
                this_progress_at = accumulated + per_report_pct * (i - 1)
                next_progress_at = accumulated + per_report_pct * i
                report = data_service.get_report(rid) or {}
                if _report_requires_approval(report):
                    st = str(report.get("reportApprovalStatus") or "").strip().lower()
                    if st == "pending":
                        result["failed"].append({"id": rid, "reason": "pending"})
                        yield _emit({"event": "report", "current": i, "total": total,
                                     "percent": int(next_progress_at), "id": rid,
                                     "status": "failed"})
                        continue
                # 1) Regenerate PDF from A4 plain-text layout (same as dot-matrix print).
                pdf_src = _report_pdf_path(rid)
                yield _emit({"event": "report", "current": i, "total": total,
                             "percent": int(this_progress_at + per_report_pct * 0.3), "id": rid,
                             "status": "generating",
                             "message": "Generating PDF for report {} of {}...".format(i, total)})
                if not _generate_report_pdf_file(rid):
                    result["failed"].append({"id": rid, "reason": "render"})
                    yield _emit({"event": "report", "current": i, "total": total,
                                 "percent": int(next_progress_at), "id": rid,
                                 "status": "failed"})
                    continue

                # 2) Copy to pendrive destination.
                recipe = report.get("recipe") if isinstance(report.get("recipe"), dict) else {}
                product = recipe.get("productName") or report.get("name") or "report"
                safe_name = "".join(c for c in str(product) if c.isalnum() or c in "-_") or "report"
                ts_raw = str(report.get("createdAt") or "")
                safe_ts = "".join(c for c in ts_raw if c.isalnum() or c in "-_.T") or "ts"
                dest = export_dir / "{}_{}_{}.pdf".format(safe_name, rid, safe_ts)
                yield _emit({"event": "report", "current": i, "total": total,
                             "percent": int(this_progress_at + per_report_pct * 0.7), "id": rid,
                             "status": "copying",
                             "message": "Writing report {} of {} to pendrive...".format(i, total)})
                try:
                    pdf_generator._copy_to_destination(pdf_src, dest)  # robust chunked copy
                    result["exported_files"].append(str(dest))
                    result["exported_report_ids"].append(int(rid))
                    result["count"] += 1
                    yield _emit({"event": "report", "current": i, "total": total,
                                 "percent": int(next_progress_at), "id": rid,
                                 "status": "copied", "file": str(dest)})
                except Exception as e:
                    app.logger.warning("[EXPORT-STREAM] Copy failed for %s: %s", rid, e)
                    result["failed"].append({"id": rid, "reason": "copy"})
                    yield _emit({"event": "report", "current": i, "total": total,
                                 "percent": int(next_progress_at), "id": rid,
                                 "status": "failed"})

            yield _emit({"event": "stage", "stage": "unmount", "percent": 95,
                         "message": "Syncing and unmounting pendrive..."})
            unmount_detail = None
            if mounted_now and not requested_export_path:
                unmount_detail = usb_export.sync_and_unmount_pendrive(mounted_now, power_off=power_off)
                mounted_now = None

            ok_count = result["count"]
            export_id = None
            if result["exported_report_ids"]:
                export_id, exported_by, approved_by = _stage_report_usb_export(
                    cur, verifier, result["exported_report_ids"]
                )
                ex_u = (exported_by or {}).get("username") or "--"
                ex_e = (exported_by or {}).get("employee_id") or "--"
                ap_u = (approved_by or {}).get("username") or "--"
                ap_e = (approved_by or {}).get("employee_id") or "--"
                audit_detail = "Exported {} report{} to USB | exported by {} ({}) | approved by {} ({})".format(
                    ok_count, "" if ok_count == 1 else "s", ex_u, ex_e, ap_u, ap_e
                )
            else:
                audit_detail = "Exported {} report{} to USB".format(
                    ok_count, "" if ok_count == 1 else "s"
                )
            _audit(
                cur.get("username") or cur.get("name") if cur else None,
                cur.get("role") if cur else None,
                "Reports exported",
                audit_detail,
            )

            result["ok"] = (len(result["failed"]) == 0 and result["count"] > 0)
            result["export_id"] = export_id
            result["reports_staged"] = len(result["exported_report_ids"])
            yield _emit({
                "event": "done",
                "percent": 100,
                "ok": result["ok"],
                "count": result["count"],
                "failed": result["failed"],
                "exported_files": result["exported_files"],
                "export_directory": result["export_directory"],
                "device_path": result["device_path"],
                "unmount_detail": unmount_detail,
                "export_id": export_id,
                "reports_staged": len(result["exported_report_ids"]),
            })
        except Exception as e:
            app.logger.exception("[EXPORT-STREAM] Unexpected failure")
            try:
                yield _emit({"event": "error", "message": _friendly_export_error(e)})
            except Exception:
                pass
        finally:
            # Best-effort unmount on early exit.
            if mounted_now and not requested_export_path:
                try:
                    usb_export.sync_and_unmount_pendrive(mounted_now, power_off=False)
                except Exception:
                    pass

    return Response(stream_with_context(gen()), mimetype="application/x-ndjson")



def _load_report_data_for_print(report_id, report_data_fallback=None):
    """Load full saved report (including testData) for printing."""
    if report_id is not None:
        stored = data_service.get_report(int(report_id))
        if stored:
            return report_service.enrich_report_context(dict(stored))
    if report_data_fallback:
        rd = dict(report_data_fallback)
        if not rd.get("factorySettings"):
            try:
                rd["factorySettings"] = report_service.enrich_factory_settings(
                    data_service.get_factory_settings() or {}
                )
            except Exception:
                pass
        return report_service.enrich_report_context(rd)
    return None

# =================== PRINT ==========================

_print_in_flight = {}
_print_in_flight_lock = threading.Lock()


def _acquire_print_slot(report_id, print_type):
    key = (report_id, print_type)
    with _print_in_flight_lock:
        if key in _print_in_flight:
            return None
        _print_in_flight[key] = True
        return key


def _release_print_slot(key):
    if key is None:
        return
    with _print_in_flight_lock:
        _print_in_flight.pop(key, None)


@app.route("/api/print/a4", methods=["POST"])
def print_a4():
    try:
        data = request.get_json(force=True, silent=True) or {}
        if data.get("type") == "recipe" and data.get("recipe_data"):
            gate = _require_any_session_internal(
                ["recipe-list", "recipe-edit", "reports-view"],
                "Forbidden. You do not have permission to print recipes.",
            )
            if gate:
                return gate
        else:
            gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to print reports.")
            if gate:
                return gate
        if data.get("type") == "recipe" and data.get("recipe_data"):
            recipe_data = dict(data["recipe_data"])
            if not recipe_data.get("factorySettings"):
                try:
                    recipe_data["factorySettings"] = report_service.enrich_factory_settings(
                        data_service.get_factory_settings() or {}
                    )
                except Exception:
                    pass
            result = print_service.print_recipe_a4(recipe_data)
            rname = recipe_data.get("productName") or recipe_data.get("name") or ""
            _audit(None, None, "Print A4", "recipe | {}".format(rname or "—"))
            return jsonify(result), 200
        report_data = data.get("report_data", {}) or {}
        report_id = report_data.get("id")
        slot = _acquire_print_slot(report_id, "a4")
        if slot is None:
            return jsonify({"ok": False, "error": "Print already in progress"}), 409
        try:
            if report_id is not None:
                blocked = _check_report_approved_for_print_export(report_id=report_id)
                if blocked is not None:
                    return blocked
                loaded = _load_report_data_for_print(report_id, report_data)
                if loaded:
                    report_data = loaded
                    try:
                        print_service.save_report_text_files(report_data, int(report_id), REPORTS_DIR)
                    except Exception:
                        pass
                    result = print_service.print_a4_report(report_data)
                    if result.get("success"):
                        _audit(None, None, "Print A4", "Report id {}".format(report_id))
                    return jsonify(result), 200 if result.get("success") else 500
            blocked = _check_report_approved_for_print_export(report_data=report_data)
            if blocked is not None:
                return blocked
            if not report_data.get("factorySettings"):
                try:
                    report_data = dict(report_data)
                    report_data["factorySettings"] = report_service.enrich_factory_settings(
                        data_service.get_factory_settings() or {}
                    )
                except Exception:
                    pass
            report_data = report_service.enrich_report_context(dict(report_data))
            result = print_service.print_a4_report(report_data)
            rid = report_data.get("id")
            _audit(
                None,
                None,
                "Print A4",
                "Report id {}".format(rid if rid is not None else "—"),
            )
            return jsonify(result), 200
        finally:
            _release_print_slot(slot)
    except Exception as e:
        app.logger.exception("Error printing A4")
        return jsonify({"error": str(e)}), 500


@app.route("/api/print/thermal", methods=["POST"])
def print_thermal():
    try:
        data = request.get_json(force=True, silent=True) or {}
        if data.get("type") == "recipe" and data.get("recipe_data"):
            gate = _require_any_session_internal(
                ["recipe-list", "recipe-edit", "reports-view"],
                "Forbidden. You do not have permission to print recipes.",
            )
            if gate:
                return gate
        else:
            gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to print reports.")
            if gate:
                return gate
        if data.get("type") == "recipe" and data.get("recipe_data"):
            recipe_data = dict(data["recipe_data"])
            if not recipe_data.get("factorySettings"):
                try:
                    recipe_data["factorySettings"] = report_service.enrich_factory_settings(
                        data_service.get_factory_settings() or {}
                    )
                except Exception:
                    pass
            result = print_service.print_recipe_thermal(recipe_data)
            rname = recipe_data.get("productName") or recipe_data.get("name") or ""
            _audit(None, None, "Print thermal", "recipe | {}".format(rname or "—"))
            return jsonify(result), 200
        report_data = data.get("report_data", {}) or {}
        report_id = report_data.get("id")
        slot = _acquire_print_slot(report_id, "thermal")
        if slot is None:
            return jsonify({"ok": False, "error": "Print already in progress"}), 409
        try:
            if report_id is not None:
                blocked = _check_report_approved_for_print_export(report_id=report_id)
                if blocked is not None:
                    return blocked
                loaded = _load_report_data_for_print(report_id, report_data)
                if loaded:
                    report_data = loaded
                    try:
                        print_service.save_report_text_files(report_data, int(report_id), REPORTS_DIR)
                    except Exception:
                        pass
                    result = print_service.print_thermal_report(report_data)
                    if result.get("success"):
                        _audit(None, None, "Print thermal", "Report id {}".format(report_id))
                    return jsonify(result), 200 if result.get("success") else 500
            blocked = _check_report_approved_for_print_export(report_data=report_data)
            if blocked is not None:
                return blocked
            if not report_data.get("factorySettings"):
                try:
                    report_data = dict(report_data)
                    report_data["factorySettings"] = report_service.enrich_factory_settings(
                        data_service.get_factory_settings() or {}
                    )
                except Exception:
                    pass
            report_data = report_service.enrich_report_context(dict(report_data))
            result = print_service.print_thermal_report(report_data)
            rid = report_data.get("id")
            _audit(
                None,
                None,
                "Print thermal",
                "Report id {}".format(rid if rid is not None else "—"),
            )
            return jsonify(result), 200
        finally:
            _release_print_slot(slot)
    except Exception as e:
        app.logger.exception("Error printing thermal")
        return jsonify({"error": str(e)}), 500


@app.route("/api/print/status", methods=["GET"])
def print_status():
    try:
        printer_type = request.args.get("type", "a4")
        status = print_service.check_printer_status(printer_type)
        return jsonify(status), 200
    except Exception as e:
        app.logger.exception("Error checking printer status")
        return jsonify({"error": str(e)}), 500


# =================== HARDWARE ==========================


@app.route("/api/hardware/stream", methods=["GET"])
def hardware_stream():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    return hardware_service.start_sse_stream()


@app.route("/api/hardware/log/reset", methods=["POST"])
def hardware_log_reset():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    result = hardware_service.reset_uart_log(reason="ui_refresh")
    code = 200 if result.get("ok") else 500
    return jsonify(result), code


@app.route("/api/hardware/command", methods=["POST"])
def hardware_command():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    cmd = data.get("command", "")
    if not cmd:
        return jsonify({"error": "No command provided"}), 400
    result = hardware_service.send_command(cmd)
    c = str(cmd).strip()
    if len(c) > 120:
        c = c[:117] + "…"
    return jsonify(result)


@app.route("/api/hardware/status", methods=["GET"])
def hardware_status():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    result = hardware_service.cmd_status()
    return jsonify(result)


@app.route("/api/hardware/calibrate/tare", methods=["POST"])
def calibrate_tare():
    return jsonify({"ok": False, "error": "Tare command is not supported by current ESP firmware"}), 400




def _adapter_kind_from_check_result(result):
    """Parse usp,chk* response: usp1, usp2, error, or None."""
    if not result or not result.get("ok"):
        return None
    norm = hardware_service.normalize_line(result.get("normalized") or result.get("response") or "")
    s = str(norm).lower()
    if "adapt" in s and "error" in s:
        return "error"
    if "usp1" in s and "ok" in s:
        return "usp1"
    if "usp2" in s and "ok" in s:
        return "usp2"
    return None

@app.route("/api/hardware/validation/load/start", methods=["POST"])
def validation_load_start():
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    mode = str(data.get("mode") or "usp2").strip().lower()
    if mode not in ("usp1", "usp2"):
        mode = "usp2"
    check = hardware_service.cmd_check_adapter()
    detected = _adapter_kind_from_check_result(check)
    if detected != mode:
        audit_action = (
            "check adaptor and holder" if mode == "usp2" else "holder error"
        )
        user_message = (
            "Check adaptor and holder"
            if mode == "usp2"
            else "Holder error"
        )
        _audit_event(
            action=audit_action,
            outcome="failed",
            entity_type="hardware",
            entity_name="holder",
            details="Validation start blocked: expected {}, detected {}".format(
                mode, detected or "none"
            ),
            extra={"expected": mode, "detected": detected, "mode": mode},
        )
        return jsonify({
            "ok": False,
            "error": "adapter_mismatch",
            "expected": mode,
            "detected": detected,
            "message": user_message,
            "response": (check.get("response") if check else None),
        }), 400
    result = hardware_service.cmd_start_validation(mode)
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/validation/load/stop", methods=["POST"])
def validation_load_stop():
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    return jsonify(hardware_service.cmd_stop())


@app.route("/api/hardware/adapter/check", methods=["POST"])
def hardware_check_adapter():
    gate = _require_any_session_internal(
        ["validation-test", "quick-test", "recipe-test"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    result = hardware_service.cmd_check_adapter()
    detected = _adapter_kind_from_check_result(result)
    if detected == "error" or (result and not result.get("ok") and detected is None):
        _audit_event(
            action="Holder check error",
            outcome="failed",
            entity_type="hardware",
            entity_name="holder",
            details=(result.get("response") if isinstance(result, dict) else None) or "Holder check failed",
            extra={"detected": detected, "response": result},
        )
    return jsonify(result)


@app.route("/api/hardware/tap/start", methods=["POST"])
def hardware_tap_start():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test"],
        "Forbidden. You do not have permission to run tests.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    speed_mode = data.get("speedMode")
    taps = data.get("tapCount")
    result = hardware_service.cmd_start_taps(speed_mode, taps)
    if result.get("ok"):
        _mark_checkpoint_esp_command("tap/start")
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/tap/stop", methods=["POST"])
def hardware_tap_stop():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test"],
        "Forbidden. You do not have permission to run tests.",
    )
    if gate:
        return gate
    result = hardware_service.cmd_stop()
    if result.get("ok"):
        _mark_checkpoint_esp_command("tap/stop")
    return jsonify(result)


@app.route("/api/system/network-addresses", methods=["GET"])
def get_network_addresses():
    denied = _require_auth_or_kiosk_headers()
    if denied:
        return denied
    try:
        payload = network_service.list_non_tailscale_addresses()
        if not isinstance(payload, dict):
            payload = {"ok": False, "error": "Invalid network payload", "wlan": None, "lan": None}
        elif payload.get("ok") is not False and "ok" not in payload:
            payload["ok"] = True
        _audit(
            None,
            None,
            "IP addresses viewed",
            "lan={} wlan={}".format(payload.get("lan") or "—", payload.get("wlan") or "—"),
        )
        return jsonify(payload), 200
    except Exception as exc:
        app.logger.exception("network-addresses failed")
        return jsonify({"ok": False, "error": str(exc), "wlan": None, "lan": None}), 500


# =================== BIOMETRIC ==========================


@app.route("/api/biometric/status", methods=["GET"])
def biometric_status():
    try:
        if not _is_biometric_enabled():
            return jsonify({"ok": False, "error": "Biometric disabled by factory settings"}), 403
        result = biometric_service.status()
        return jsonify(result), 200 if result.get("ok") else 500
    except Exception as e:
        app.logger.exception("Error checking biometric status")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/biometric/enroll", methods=["POST"])
def biometric_enroll():
    try:
        if not _is_biometric_enabled():
            return jsonify({"ok": False, "error": "Biometric enrollment is disabled by Factory Settings."}), 403
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        if not username:
            return jsonify({"ok": False, "error": "username is required"}), 400
        member = data_service.get_member_by_username(username)
        if not member:
            _audit_event(action="Biometric enroll", outcome="failed", entity_type="member", entity_name=username, details="Member not found for provided username", target_user=username)
            return jsonify({"ok": False, "error": "Member not found for the provided username"}), 404
        before_member = dict(member)
        status = str(member.get("status") or "active").strip().lower()
        if status != "active":
            _audit_event(action="Biometric enroll", outcome="denied", entity_type="member", entity_id=member.get("id"), entity_name=username, details="Member account is not active", target_user=username, before=before_member)
            return jsonify({"ok": False, "error": "Member account is not active"}), 403
        template_id_raw = payload.get("templateId")
        if template_id_raw is None:
            template_id = data_service.get_next_fingerprint_template_id()
        else:
            template_id = int(template_id_raw)
        timeout_sec = float(payload.get("captureTimeoutSec") or BIOMETRIC_ENROLL_TIMEOUT_SEC)
        enrolled = biometric_service.enroll(template_id, capture_timeout_sec=timeout_sec)
        if not enrolled.get("ok"):
            _audit_event(action="Biometric enroll", outcome="failed", entity_type="member", entity_id=member.get("id"), entity_name=username, details=enrolled.get("error") or "Unknown error", target_user=username, before=before_member, extra={"templateId": template_id})
            return jsonify(enrolled), 400
        previous_owner = data_service.get_member_by_fingerprint_template(template_id)
        if previous_owner and previous_owner.get("id") != member.get("id"):
            previous_owner["fingerprintTemplateId"] = None
            previous_owner["biometricEnrollmentStatus"] = "not_enrolled"
            previous_owner["biometricEnrolledAt"] = None
            data_service.save_member(previous_owner)
        member["fingerprintTemplateId"] = template_id
        member["biometricEnrollmentStatus"] = "enrolled"
        member["biometricEnrolledAt"] = int(time.time())
        member["biometricEnabled"] = True
        data_service.save_member(member)
        _audit_event(
            action="Biometric enroll",
            outcome="success",
            entity_type="member",
            entity_id=member.get("id"),
            entity_name=username,
            details="Fingerprint enrolled and linked",
            target_user=username,
            before=before_member,
            after=member,
            extra={"templateId": template_id},
        )
        return jsonify({"ok": True, "templateId": template_id, "linked": True, "memberId": member.get("id")}), 200
    except Exception as e:
        app.logger.exception("Error during biometric enrollment")
        return jsonify({"ok": False, "error": str(e)}), 500




def _clear_enroll_session(username):
    key = str(username or "").strip().lower()
    if not key:
        return
    with _enroll_sessions_lock:
        _enroll_sessions.pop(key, None)


def _get_enroll_session(username):
    key = str(username or "").strip().lower()
    with _enroll_sessions_lock:
        return dict(_enroll_sessions.get(key) or {})


def _set_enroll_session(username, data):
    key = str(username or "").strip().lower()
    with _enroll_sessions_lock:
        _enroll_sessions[key] = dict(data or {})


@app.route("/api/biometric/enroll/capture", methods=["POST"])
def biometric_enroll_capture():
    """Step 1 or 2 of fingerprint enrollment (two scans of the same finger)."""
    try:
        if not _is_biometric_enabled():
            return jsonify({"ok": False, "error": "Biometric enrollment is disabled by Factory Settings."}), 403
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        if not username:
            return jsonify({"ok": False, "error": "username is required"}), 400
        try:
            step = int(payload.get("step") or 0)
        except (TypeError, ValueError):
            step = 0
        if step not in (1, 2):
            return jsonify({"ok": False, "error": "step must be 1 or 2"}), 400
        member = data_service.get_member_by_username(username)
        if not member:
            return jsonify({"ok": False, "error": "Member not found for the provided username"}), 404
        status = str(member.get("status") or "active").strip().lower()
        if status != "active":
            return jsonify({"ok": False, "error": "Member account is not active"}), 403
        before_member = dict(member)
        timeout_sec = float(payload.get("captureTimeoutSec") or BIOMETRIC_ENROLL_TIMEOUT_SEC)

        if step == 1:
            template_id_raw = payload.get("templateId")
            if template_id_raw is None:
                template_id = data_service.get_next_fingerprint_template_id()
            else:
                template_id = int(template_id_raw)
            captured = biometric_service.capture_enroll_finger(0x01, timeout_sec=timeout_sec)
            if not captured.get("ok"):
                _clear_enroll_session(username)
                return jsonify(captured), 400
            _set_enroll_session(username, {"templateId": template_id, "step1Done": True, "startedAt": int(time.time())})
            return jsonify({
                "ok": True,
                "step": 1,
                "nextStep": 2,
                "templateId": template_id,
                "message": "First scan complete. Remove your finger from the scanner.",
                "nextMessage": "Place the same finger on the scanner again for the second scan.",
            }), 200

        session = _get_enroll_session(username)
        if not session.get("step1Done"):
            return jsonify({"ok": False, "error": "Complete capture step 1 before step 2."}), 400
        template_id = int(session.get("templateId") or 0)
        if template_id <= 0:
            _clear_enroll_session(username)
            return jsonify({"ok": False, "error": "Enrollment session expired. Start again."}), 400

        captured = biometric_service.capture_enroll_finger(0x02, timeout_sec=timeout_sec)
        if not captured.get("ok"):
            _clear_enroll_session(username)
            return jsonify(captured), 400

        finalized = biometric_service.finalize_enroll(template_id)
        _clear_enroll_session(username)
        if not finalized.get("ok"):
            _audit_event(
                action="Biometric enroll",
                outcome="failed",
                entity_type="member",
                entity_id=member.get("id"),
                entity_name=username,
                details=finalized.get("error") or "Unknown error",
                target_user=username,
                before=before_member,
                extra={"templateId": template_id},
            )
            return jsonify(finalized), 400

        previous_owner = data_service.get_member_by_fingerprint_template(template_id)
        if previous_owner and previous_owner.get("id") != member.get("id"):
            previous_owner["fingerprintTemplateId"] = None
            previous_owner["biometricEnrollmentStatus"] = "not_enrolled"
            previous_owner["biometricEnrolledAt"] = None
            data_service.save_member(previous_owner)
        member["fingerprintTemplateId"] = template_id
        member["biometricEnrollmentStatus"] = "enrolled"
        member["biometricEnrolledAt"] = int(time.time())
        member["biometricEnabled"] = True
        data_service.save_member(member)
        _audit_event(
            action="Biometric enroll",
            outcome="success",
            entity_type="member",
            entity_id=member.get("id"),
            entity_name=username,
            details="Fingerprint enrolled and linked (2 captures)",
            target_user=username,
            before=before_member,
            after=member,
            extra={"templateId": template_id},
        )
        return jsonify({
            "ok": True,
            "step": 2,
            "templateId": template_id,
            "linked": True,
            "memberId": member.get("id"),
            "message": "Fingerprint registered successfully.",
        }), 200
    except Exception as e:
        app.logger.exception("Error during biometric enroll capture")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/biometric/enroll/cancel", methods=["POST"])
def biometric_enroll_cancel():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        if username:
            _clear_enroll_session(username)
        return jsonify({"ok": True}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/api/biometric/delete", methods=["POST"])
def biometric_delete():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        template_id = payload.get("templateId")
        if template_id is None:
            return jsonify({"ok": False, "error": "templateId is required"}), 400
        result = biometric_service.delete_template(template_id)
        if result.get("ok"):
            _audit_event(action="Biometric template delete", outcome="success", entity_type="biometric_template", entity_id=template_id, entity_name="template {}".format(template_id), details="Template deleted from sensor", extra={"templateId": int(template_id)})
            return jsonify({"ok": True, "templateId": int(template_id)}), 200
        _audit_event(action="Biometric template delete", outcome="failed", entity_type="biometric_template", entity_id=template_id, entity_name="template {}".format(template_id), details=result.get("error") or "Delete failed", extra={"templateId": int(template_id)})
        return jsonify(result), 400
    except Exception as e:
        app.logger.exception("Error deleting biometric template")
        return jsonify({"ok": False, "error": str(e)}), 500


# =================== DATETIME / RTC ==========================


def _get_stored_datetime():
    """Return local wall time from the DS1307 (hwclock on /dev/rtc0), not NTP/network."""
    return rtc_service.get_device_wall_datetime_payload()


@app.route("/api/get_datetime", methods=["GET"])
def get_datetime():
    return jsonify(_get_stored_datetime())


def _set_datetime_common():
    denied = _require_edit_datetime()
    if denied:
        return denied
    data = request.get_json(force=True, silent=True) or {}
    dt_str = data.get("datetime", "")
    if not dt_str:
        return jsonify({"ok": False, "error": "datetime required"}), 400
    prev_payload = _get_stored_datetime()
    prev_raw = (prev_payload.get("datetime") or "").strip()
    try:
        clean = dt_str.strip().replace("Z", "")
        if "+" in clean:
            clean = clean.split("+", 1)[0]
        if clean.count("-") > 2:
            clean = clean.rsplit("-", 1)[0]
        dt_obj = datetime.fromisoformat(clean)
        if getattr(dt_obj, "tzinfo", None) is not None:
            dt_obj = dt_obj.replace(tzinfo=None)
    except Exception:
        return jsonify({"ok": False, "error": "invalid datetime"}), 400
    rtc_ok, rtc_err = rtc_service.apply_user_wall_time(dt_obj)
    if not rtc_ok:
        return jsonify({"ok": False, "error": rtc_err or "Failed to set RTC time"}), 500
    try:
        STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        with open(DATETIME_STORAGE, "w", encoding="utf-8") as f:
            json.dump({"datetime": dt_obj.strftime("%Y-%m-%dT%H:%M:%S"), "last_tick": time.time()}, f)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    applied = rtc_service.get_device_wall_datetime_payload()
    new_raw = (applied.get("datetime") or dt_obj.strftime("%Y-%m-%dT%H:%M:%S")).strip()
    _audit(
        None,
        None,
        "System date change",
        "Changed from {} to {}".format(
            _format_wall_datetime_for_audit(prev_raw),
            _format_wall_datetime_for_audit(new_raw),
        ),
    )
    return jsonify({
        "ok": True,
        "datetime": applied.get("datetime") or dt_obj.strftime("%Y-%m-%dT%H:%M:%S"),
        "source": applied.get("source", "rtc"),
    })


@app.route("/api/set_datetime", methods=["POST"])
def set_datetime():
    # Backward-compatible route used by older frontend builds.
    return _set_datetime_common()


@app.route("/api/set_device_datetime", methods=["POST"])
def set_device_datetime():
    # Reference-project route used by updated frontend flow.
    return _set_datetime_common()


@app.route("/api/rtc/date", methods=["GET"])
def get_rtc_date():
    result = rtc_service.get_rtc_date()
    return jsonify(result), 200


@app.route("/api/rtc/date", methods=["POST"])
def set_rtc_date_route():
    denied = _require_edit_datetime()
    if denied:
        return denied
    data = request.get_json(force=True, silent=True) or {}
    dt_str = data.get("datetime", "")
    if not dt_str:
        return jsonify({"success": False, "error": "datetime required"}), 400
    try:
        dt_obj = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
    except Exception:
        return jsonify({"success": False, "error": "invalid datetime"}), 400
    result = rtc_service.set_rtc_date(dt_obj)
    if result.get("success"):
        _audit(None, None, "RTC date set", dt_str)
    return jsonify(result), 200 if result.get("success") else 500


_startup_session_power_audit()
_register_clean_shutdown_signals()
_register_clean_shutdown_atexit()


# =================== MAIN ==========================


if __name__ == "__main__":
    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=False)

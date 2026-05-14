#!/usr/bin/env python3
"""
app.py - Flask application for Tap Density
Serves static files and REST API for data, auth, audit, reports, and print.
"""

import json
import os
import pathlib
import secrets
import signal
import subprocess
import sys
import time
from datetime import datetime
from flask import Flask, jsonify, request, send_from_directory, Response, stream_with_context

try:
    from flask_cors import CORS
except ImportError:
    CORS = None

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
import pdf_generator

# ======================= CONFIG ==========================

APP_ROOT = pathlib.Path(os.environ.get("APP_ROOT", os.path.dirname(os.path.abspath(__file__))))
STORAGE_DIR = pathlib.Path(os.environ.get("STORAGE_DIR", str(APP_ROOT / "storage")))
REPORTS_DIR = pathlib.Path(os.environ.get("REPORTS_DIR", str(APP_ROOT / "reports")))
EXPORT_USB_PATH = os.environ.get("EXPORT_USB_PATH", str(APP_ROOT / "export"))
ESP_PORT = os.environ.get("ESP_PORT", "/dev/serial0")
ESP_BAUD = int(os.environ.get("ESP_BAUD", "9600"))
BIOMETRIC_PORT = os.environ.get("BIOMETRIC_PORT", "/dev/ttyAMA5")
BIOMETRIC_BAUD = int(os.environ.get("BIOMETRIC_BAUD", "57600"))
BIOMETRIC_ENROLL_TIMEOUT_SEC = float(os.environ.get("BIOMETRIC_ENROLL_TIMEOUT_SEC", "120"))
BIOMETRIC_LOGIN_TIMEOUT_SEC = float(os.environ.get("BIOMETRIC_LOGIN_TIMEOUT_SEC", "30"))
FLASK_HOST = os.environ.get("FLASK_HOST", "127.0.0.1")
FLASK_PORT = int(os.environ.get("FLASK_PORT", "5000"))
ALLOWED_DATETIME_ROLES = ("factory", "admin")
EXPORT_SUBFOLDER = "TapDensity-Reports-Exported"
DATETIME_STORAGE = STORAGE_DIR / "datetime.json"
APPROVAL_VERIFY_TTL_SECONDS = int(os.environ.get("APPROVAL_VERIFY_TTL_SECONDS", "180"))

# ==========================================================

app = Flask(__name__)
if CORS:
    CORS(app)

try:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

config = {
    "STORAGE_DIR": STORAGE_DIR,
    "REPORTS_DIR": REPORTS_DIR,
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
biometric_service.init(app, config)
rtc_service.init(app.logger)


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
    payload = _get_stored_datetime() or {}
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


def _startup_session_power_audit():
    """If the last run ended without a clean stop while a session was active, log one power-interruption row."""
    try:
        had_clean_shutdown = data_service.consume_app_clean_stop_flag()
        pending = data_service.read_session_power_audit_pending()
        if pending and not had_clean_shutdown:
            un = (pending.get("username") or "").strip()
            role = (pending.get("role") or "").strip()
            audit_time = _audit_time_fields()
            if audit_service.is_hidden_factory_actor(un, role):
                audit_service.log_structured_event(
                    user="--",
                    role="--",
                    action="Power interruption",
                    outcome="success",
                    entity_type="session",
                    entity_name="power",
                    details="Privileged factory session was active when power was interrupted or the system restarted.",
                    event_type="compliance",
                    request_source="system/startup",
                    timestamp_ms=audit_time.get("timestamp_ms"),
                    date_time=audit_time.get("date_time"),
                )
            else:
                audit_service.log_structured_event(
                    user="--",
                    role="--",
                    action="Power interruption",
                    outcome="success",
                    entity_type="session",
                    entity_name="power",
                    details="Session was active when power was interrupted or the system restarted.",
                    event_type="compliance",
                    target_user=un,
                    extra={"lastKnownRole": role} if role else None,
                    request_source="system/startup",
                    timestamp_ms=audit_time.get("timestamp_ms"),
                    date_time=audit_time.get("date_time"),
                )
        cur = data_service.get_current_user()
        if cur:
            data_service.write_session_power_audit_pending(cur)
        else:
            data_service.delete_session_power_audit_pending()
    except Exception:
        app.logger.exception("Startup session power audit failed")


def _register_clean_shutdown_signals():
    """Mark clean shutdown on SIGTERM/SIGINT so the next start does not log a false power interruption."""

    def _handler(signum, frame):
        try:
            data_service.touch_app_clean_stop_flag()
        except Exception:
            pass

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError, AttributeError):
            pass


def _require_user_admin_verification():
    return _consume_approval_verify_token("user_admin")


def _approval_verifier_eligible_for_recipe(verifier_role):
    """Recipe approval: QA or Admin when active QA exists; otherwise Admin only."""
    vr = str(verifier_role or "").strip().lower()
    session = (request.headers.get("X-User-Role") or "").strip().lower()
    if session == "factory":
        return vr == "factory"
    if data_service.count_active_qa_members() >= 1:
        return vr in ("qa", "admin")
    return vr == "admin"


def _approval_verifier_eligible_for_report(verifier_role):
    """Test report approval: Reviewer (supervisor), Admin, or factory may verify; not QA or User.

    Independent of session and reviewer count so factory UI sessions and edge counts cannot block valid verifiers."""
    vr = str(verifier_role or "").strip().lower()
    return vr in ("supervisor", "admin", "factory")


def _utc_now_iso():
    dt_payload = _get_stored_datetime() or {}
    dt_str = (dt_payload.get("datetime") or "").strip()
    if dt_str:
        return dt_str
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _norm_username(val):
    return str(val or "").strip().lower()


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
    role = _effective_request_role()
    return role in ("factory", "admin")


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


_approval_verify_tokens = {}


def _cleanup_approval_verify_tokens():
    now = int(time.time())
    stale = [token for token, payload in _approval_verify_tokens.items() if int(payload.get("expiresAt", 0)) <= now]
    for token in stale:
        _approval_verify_tokens.pop(token, None)


def _issue_approval_verify_token(verifier_user, purpose):
    _cleanup_approval_verify_tokens()
    now = int(time.time())
    token = secrets.token_urlsafe(24)
    payload = {
        "username": verifier_user.get("username") or "",
        "name": verifier_user.get("name") or verifier_user.get("username") or "",
        "role": str(verifier_user.get("role") or "").strip().lower(),
        "purpose": str(purpose or "recipe").strip().lower(),
        "issuedAt": now,
        "expiresAt": now + APPROVAL_VERIFY_TTL_SECONDS,
    }
    _approval_verify_tokens[token] = payload
    return token, payload


def _consume_approval_verify_token(expected_purpose):
    _cleanup_approval_verify_tokens()
    token = (request.headers.get("X-Approval-Verify-Token") or "").strip()
    if not token:
        return None, "Approval verification is required."
    payload = _approval_verify_tokens.pop(token, None)
    if not payload:
        return None, "Approval verification is invalid or expired."
    exp = str(expected_purpose or "").strip().lower()
    got = str(payload.get("purpose") or "").strip().lower()
    if got != exp:
        return None, "Approval verification was issued for a different action."
    if exp == "report":
        if not _verifier_payload_has_internal(payload, "test-report-approve"):
            return None, "Verifier does not have test report approval permission."
    elif exp == "recipe":
        if not _verifier_payload_has_internal(payload, "recipe-approve"):
            return None, "Verifier does not have recipe approval permission."
    elif exp == "user_admin":
        if str(payload.get("role") or "").strip().lower() not in ("admin", "factory"):
            return None, "Verification role does not match approval policy."
    elif exp == "export":
        if not _verifier_payload_has_internal(payload, "export-approve"):
            return None, "Verifier does not have export approval permission."
    else:
        return None, "Invalid approval purpose."
    return payload, None


def _format_report_audit_details(report_id, enriched):
    """Build audit trail details: saved report name, recipe, batch."""
    if not enriched:
        return str(report_id)
    parts = []
    name = enriched.get("name")
    if name:
        parts.append("report: {}".format(name))
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


# =================== STATIC ==========================


@app.route("/api/health")
def health():
    return jsonify({"status": "ok"}), 200


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
        recipes = data_service.list_recipes()
        return jsonify({"recipes": recipes}), 200
    except Exception as e:
        app.logger.exception("Error listing recipes")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes", methods=["POST"])
def create_recipe():
    try:
        recipe_data = request.get_json(force=True, silent=True) or {}
        validation_result = calculation_service.validate_recipe(recipe_data)
        if not validation_result.get("valid", False):
            return jsonify({"error": validation_result.get("error", "Invalid recipe data")}), 400
        processed = calculation_service.process_recipe_form_data(recipe_data)
        _apply_recipe_approval_for_session_creator(processed)
        recipe_id = data_service.save_recipe(processed)
        rlabel = processed.get("name") or processed.get("productName") or ""
        rd = "Recipe id {}".format(recipe_id)
        if rlabel:
            rd = "{}: {}".format(rd, rlabel)
        _audit(None, None, "Recipe created", rd)
        if processed.get("recipeApprovalStatus") == "approved":
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
        recipe = data_service.get_recipe(recipe_id)
        if recipe:
            return jsonify({"recipe": recipe}), 200
        return jsonify({"error": "Recipe not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["PUT"])
def update_recipe(recipe_id):
    try:
        recipe_data = request.get_json(force=True, silent=True) or {}
        recipe_data["id"] = recipe_id
        validation_result = calculation_service.validate_recipe(recipe_data)
        if not validation_result.get("valid", False):
            return jsonify({"error": validation_result.get("error", "Invalid recipe data")}), 400
        processed = calculation_service.process_recipe_form_data(recipe_data)
        _apply_recipe_approval_for_session_creator(processed)
        data_service.save_recipe(processed)
        rlabel = processed.get("name") or processed.get("productName") or ""
        rd = "Recipe id {}".format(recipe_id)
        if rlabel:
            rd = "{}: {}".format(rd, rlabel)
        _audit(None, None, "Recipe edited", rd)
        if processed.get("recipeApprovalStatus") == "approved":
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
        existing = data_service.get_recipe(recipe_id)
        success = data_service.delete_recipe(recipe_id)
        if success:
            rlabel = ""
            if existing:
                rlabel = existing.get("productName") or existing.get("name") or ""
            details = "Recipe id {}".format(recipe_id)
            if rlabel:
                details = "{}: {}".format(details, rlabel)
            _audit(None, None, "Disable Recipe", details)
            return jsonify({"success": True}), 200
        return jsonify({"error": "Recipe not found"}), 404
    except Exception as e:
        app.logger.exception("Error deleting recipe")
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
        rdetail = "Recipe id {} | verified by {}".format(recipe_id, verified_name)
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


# =================== DATA: REPORTS ==========================


@app.route("/api/data/reports", methods=["GET"])
def get_reports():
    try:
        filter_type = request.args.get("filter", "all")
        reports = data_service.list_reports(filter_type)
        return jsonify({"reports": reports}), 200
    except Exception as e:
        app.logger.exception("Error listing reports")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/reports", methods=["POST"])
def create_report():
    try:
        report_data = request.get_json(force=True, silent=True) or {}
        recipe = report_data.get("recipe") or (report_data.get("testData") or {}).get("recipe")
        enriched = report_service.generate_report(
            report_data,
            recipe=recipe,
            factory_settings=report_data.get("factorySettings"),
        )
        if (enriched.get("type") or "").strip().lower() in ("test", "validation"):
            enriched["reportApprovalStatus"] = "pending"
            for k in ("approvalPassFail", "approvalRemarks", "approvedBy", "approvedAt"):
                enriched.pop(k, None)
        report_id = data_service.save_report(enriched)
        try:
            print_service.save_report_text_files(enriched, report_id, REPORTS_DIR)
        except Exception:
            pass
        details = _format_report_audit_details(report_id, enriched)
        if (enriched.get("type") or "").strip().lower() == "test":
            _audit(None, None, "Test performed", details)
        else:
            _audit(None, None, "Report generated", details)
        return jsonify({"id": report_id, "report": enriched}), 201
    except Exception as e:
        app.logger.exception("Error creating report")
        return jsonify({"error": str(e)}), 500


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
        if pf not in ("PASS", "FAIL"):
            return jsonify({"ok": False, "error": "passFail must be PASS or FAIL"}), 400
        remarks = (body.get("remarks") or "").strip()
        approver_name = (body.get("approverName") or "").strip()
        role_header = (request.headers.get("X-User-Role") or "").strip()
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"ok": False, "error": "Report not found"}), 404
        verified_username = _norm_username(verified.get("username"))
        st = report.get("reportApprovalStatus")
        if st is None:
            return jsonify({"ok": False, "error": "Report does not require approval"}), 400
        if st == "approved":
            existing_approver = _norm_username(report.get("approvedByUsername"))
            if existing_approver and existing_approver == verified_username:
                return jsonify({"ok": False, "error": "Same person cannot approve twice"}), 409
            return jsonify({"ok": True, "report": report}), 200
        if st != "pending":
            return jsonify({"ok": False, "error": "Invalid approval state"}), 400
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
        ctx = _format_report_audit_details(report_id, report)
        appr_detail = "{} | {} | verified by {}".format(ctx, pf, verified_name)
        v_audit_user = verified.get("username") or verified_username or verified_name
        v_audit_role = (verified.get("role") or "").strip() or "--"
        _audit(
            v_audit_user,
            v_audit_role,
            "Report approved",
            appr_detail,
        )
        return jsonify({"ok": True, "report": report}), 200
    except Exception as e:
        app.logger.exception("Error approving report")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>", methods=["GET"])
def get_report(report_id):
    try:
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
        members = data_service.list_members()
        safe = [data_service.sanitize_member_for_client(m) or m for m in members]
        return jsonify({"members": safe}), 200
    except Exception as e:
        app.logger.exception("Error listing members")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members", methods=["POST"])
def create_member():
    try:
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
        _audit_event(
            action="User create",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=created.get("username") or created.get("name") or "",
            details="Member created",
            target_user=created.get("username") or "",
            after=data_service.sanitize_member_for_client(created) or created,
            signature=sig,
        )
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
        member_data = request.get_json(force=True, silent=True) or {}
        before_member = data_service.get_member(member_id)
        if _payload_has_protected_feature_overrides(member_data):
            return jsonify({"error": "Protected features cannot be overridden."}), 400
        if data_service.has_non_empty_feature_overrides(member_data) and not _can_assign_feature_overrides():
            return jsonify({"error": "Forbidden. Only Factory/Admin can assign feature overrides."}), 403
        member_data["id"] = member_id
        cur = data_service.get_current_user() or {}
        acting_id = cur.get("id")
        data_service.save_member(member_data, acting_user_id=acting_id)
        updated = data_service.get_member(member_id) or dict(member_data)
        sig = {
            "mode": "session",
            "username": (cur.get("username") or cur.get("name") or "").strip() or "--",
            "role": (cur.get("role") or "").strip() or "--",
        }
        _audit_event(
            action="User update",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=updated.get("username") or updated.get("name") or "",
            details="Member updated",
            target_user=updated.get("username") or "",
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
        member = data_service.get_member(member_id)
        if not member:
            return jsonify({"error": "Member not found"}), 404
        verified, verify_err = _require_user_admin_verification()
        if not verified:
            _audit_event(
                action="User disable",
                outcome="denied",
                entity_type="member",
                entity_id=member_id,
                entity_name=member.get("username") or member.get("name") or "",
                details=verify_err or "Approval verification required",
                target_user=member.get("username") or "",
                before=member,
            )
            return jsonify({"error": verify_err}), 403
        before_member = dict(member)
        template_id = member.get("fingerprintTemplateId")
        if template_id is not None:
            deleted = biometric_service.delete_template(template_id)
            if not deleted.get("ok"):
                _audit_event(
                    action="User disable",
                    outcome="failed",
                    entity_type="member",
                    entity_id=member_id,
                    entity_name=member.get("username") or member.get("name") or "",
                    details=deleted.get("error") or "Failed to delete fingerprint template from sensor",
                    target_user=member.get("username") or "",
                    before=before_member,
                    signature={"mode": "password_reconfirm", "username": verified.get("username"), "role": verified.get("role")},
                    extra={"templateId": template_id},
                )
                return jsonify({
                    "error": deleted.get("error") or "Failed to delete fingerprint template from sensor",
                    "templateId": int(template_id)
                }), 400
            data_service.clear_member_biometric(member_id)
        member = data_service.disable_member(member_id)
        _audit_event(
            action="User disable",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=member.get("username") or member.get("name") or "",
            details="Member disabled",
            target_user=member.get("username") or "",
            before=before_member,
            after=member,
            signature={"mode": "password_reconfirm", "username": verified.get("username"), "role": verified.get("role")},
            extra={"templateIdFreed": template_id},
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
        _audit_event(
            action="User unlock",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=member.get("username") or member.get("name") or "",
            details="Member unlocked",
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
        _audit_event(
            action="User enable",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=member.get("username") or member.get("name") or "",
            details="Member enabled",
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
        settings = data_service.get_factory_settings()
        return jsonify({"settings": settings}), 200
    except Exception as e:
        app.logger.exception("Error getting factory settings")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/factory-settings", methods=["POST"])
def save_factory_settings():
    try:
        settings = request.get_json(force=True, silent=True) or {}
        data_service.save_factory_settings(settings)
        _audit(None, None, "Factory settings changed", "")
        return jsonify({"success": True, "settings": settings}), 200
    except Exception as e:
        app.logger.exception("Error saving factory settings")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/factory-reset", methods=["POST"])
def factory_reset():
    try:
        user = data_service.get_current_user()
        if not user or (user.get("role") or "").strip().lower() != "factory":
            return jsonify({"error": "Forbidden. Factory role required."}), 403

        # Find when the current login session began so we can keep its rows.
        # write_session_power_audit_pending is set on every successful login
        # (password, biometric, password-expired-reset), so ts_ms is reliable.
        pending = data_service.read_session_power_audit_pending() or {}
        try:
            session_start_ms = int(pending.get("ts_ms") or 0)
        except (TypeError, ValueError):
            session_start_ms = 0

        # Delete recipes, reports, members, report files (existing behaviour;
        # does NOT touch current_user.json or session_power_audit_pending.json,
        # so the user stays signed in).
        result = data_service.factory_reset()

        # Wipe audit rows older than the current session start.
        # If session_start_ms is missing/zero we wipe EVERYTHING per the
        # 'delete the rest' directive.
        audit_removed = audit_service.clear_entries_before(session_start_ms)

        # Write the post-reset audit row AFTER the wipe so it survives.
        # If the actor is the hidden factory user, write an anonymised row so
        # it is not stripped by the RLERLT/Factory suppression filter.
        un = (user.get("username") or user.get("name") or "").strip()
        role = (user.get("role") or "").strip()
        audit_time = _audit_time_fields()
        if audit_service.is_hidden_factory_actor(un, role):
            audit_service.log_structured_event(
                user="--",
                role="--",
                action="Factory reset performed",
                outcome="success",
                entity_type="system",
                entity_name="factory-reset",
                details="Factory reset performed; audit history older than the current session was erased.",
                event_type="compliance",
                request_source=_audit_request_source(),
                extra={
                    "deleted": result.get("deleted") or {},
                    "auditRowsRemoved": audit_removed,
                    "sessionStartMs": session_start_ms,
                },
                timestamp_ms=audit_time.get("timestamp_ms"),
                date_time=audit_time.get("date_time"),
            )
        else:
            _audit_event(
                action="Factory reset performed",
                outcome="success",
                entity_type="system",
                entity_name="factory-reset",
                details="Factory reset performed; audit history older than the current session was erased.",
                extra={
                    "deleted": result.get("deleted") or {},
                    "auditRowsRemoved": audit_removed,
                    "sessionStartMs": session_start_ms,
                },
            )

        return jsonify({
            "success": True,
            "deleted": result["deleted"],
            "auditRowsRemoved": audit_removed,
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
        # Temporary test login "," / "," — same as factory (no member-table / lock / expiry path)
        if data_service.is_test_comma_login(username, password):
            user = data_service.get_test_comma_session_user()
            data_service.save_current_user(user)
            data_service.write_session_power_audit_pending(user)
            _audit_event(
                action="Login",
                outcome="success",
                entity_type="session",
                entity_name="password",
                details="Password login succeeded (test comma)",
                target_user=username,
                after={"username": user.get("username"), "role": user.get("role")},
            )
            return jsonify({"success": True, "user": data_service.sanitize_member_for_client(user) or user}), 200
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
                    details="Password login succeeded",
                    target_user=username,
                    after={"username": user.get("username"), "role": user.get("role")},
                )
                return jsonify({"success": True, "user": data_service.sanitize_member_for_client(user) or user}), 200
            _audit_event(
                action="Login",
                outcome="failed",
                entity_type="session",
                entity_name="password",
                details="Invalid username or password",
                target_user=username,
            )
            return jsonify({"error": "Invalid username or password"}), 401

        # Normal member: check status first
        member = data_service.get_member_by_username(username)
        if member:
            status = str(member.get("status") or "active").strip().lower()
            if status == "locked":
                _audit_event(action="Login", outcome="denied", entity_type="session", entity_name="password", details="Account locked", target_user=username)
                return jsonify({"error": "Account locked. Contact admin."}), 403
            if status == "disabled":
                _audit_event(action="Login", outcome="denied", entity_type="session", entity_name="password", details="Account disabled", target_user=username)
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
            data_service.write_session_power_audit_pending(user)
            _audit_event(
                action="Login",
                outcome="success",
                entity_type="session",
                entity_name="password",
                details="Password login succeeded",
                target_user=username,
                after={"username": user.get("username"), "role": user.get("role")},
            )
            safe_user = data_service.sanitize_member_for_client(user) or user
            return jsonify({"success": True, "user": safe_user}), 200

        # Wrong password: increment failedAttempts (may lock at 3)
        updated = data_service.record_failed_login(username)
        if updated:
            status = str(updated.get("status") or "").strip().lower()
            try:
                fa = int(updated.get("failedAttempts") or 0)
            except (TypeError, ValueError):
                fa = 0
            remaining = max(0, 3 - fa)
            # If this attempt caused the account to become locked, show lockout immediately
            if status == "locked":
                _audit_event(action="Login", outcome="denied", entity_type="session", entity_name="password", details="Account locked after failed attempts", target_user=username)
                return jsonify({
                    "error": "Account locked. Contact admin.",
                    "remainingAttempts": 0
                }), 403
            _audit_event(action="Login", outcome="failed", entity_type="session", entity_name="password", details="Invalid username or password", target_user=username, extra={"remainingAttempts": remaining})
            return jsonify({
                "error": "Invalid username or password.",
                "remainingAttempts": remaining
            }), 401
        _audit_event(action="Login", outcome="failed", entity_type="session", entity_name="password", details="Invalid username or password", target_user=username)
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
            details="Biometric login succeeded",
            target_user=username,
            after={"username": user.get("username"), "role": user.get("role")},
            extra={"templateId": template_id, "confidence": identified.get("confidence")},
        )
        return jsonify({"success": True, "user": data_service.sanitize_member_for_client(user) or user, "templateId": template_id, "confidence": identified.get("confidence")}), 200
    except Exception as e:
        app.logger.exception("Error during biometric login")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/logout", methods=["POST"])
def logout():
    try:
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
                _audit_event(
                    action="Logout",
                    outcome="success",
                    entity_type="session",
                    entity_name="logout",
                    details="User logged out",
                    target_user=user.get("username") or user.get("name") or "",
                )
        data_service.delete_session_power_audit_pending()
        data_service.clear_current_user()
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
        if purpose not in ("recipe", "report", "user_admin", "export"):
            return jsonify({"ok": False, "error": "purpose must be recipe, report, or user_admin"}), 400
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
            eligible = _approval_verifier_eligible_for_report(verifier_role)
        elif purpose == "recipe":
            eligible = _approval_verifier_eligible_for_recipe(verifier_role)
        else:
            eligible = verifier_role in ("admin", "factory")
        if not eligible:
            _audit_event(
                action="Approval verification",
                outcome="denied",
                entity_type="verification",
                entity_name=purpose,
                details="Role not eligible for approval",
                target_user=verifier.get("username") or username,
                extra={"purpose": purpose, "verifierRole": verifier_role, "method": method},
            )
            return jsonify({"ok": False, "error": "Verifier role is not allowed for approval"}), 403

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
        return jsonify(
            {
                "ok": True,
                "token": token,
                "expiresInSec": APPROVAL_VERIFY_TTL_SECONDS,
                "verifier": {
                    "username": token_payload.get("username"),
                    "name": token_payload.get("name"),
                    "role": token_payload.get("role"),
                },
            }
        ), 200
    except Exception as e:
        app.logger.exception("Error during approval verification")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/auth/current-user", methods=["GET"])
def get_current_user_route():
    try:
        user = data_service.get_current_user()
        if user:
            user = data_service.sanitize_member_for_client(user) or user
        return jsonify({"user": user}), 200
    except Exception as e:
        app.logger.exception("Error getting current user")
        return jsonify({"error": str(e)}), 500


# =================== DATA: AUDIT LOG ==========================


def _require_export_usb_and_verification_json():
    cur = data_service.get_current_user()
    if not cur:
        return jsonify({"success": False, "error": "Unauthorized"}), 401
    if not _session_has_internal("export-usb"):
        return jsonify({"success": False, "error": "Forbidden. Export to USB is not permitted for this account."}), 403
    role = str(cur.get("role") or "").strip().lower()
    if role != "factory":
        _verified, verify_err = _consume_approval_verify_token("export")
        if verify_err:
            return jsonify({"success": False, "error": verify_err}), 401
    return None


@app.route("/api/data/audit-log", methods=["GET"])
def get_audit_log():
    """Return audit log entries. Requires audit-view permission (Factory bypass in RBAC)."""
    try:
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
        return jsonify({"entries": entries}), 200
    except Exception as e:
        app.logger.exception("Error listing audit log")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/audit-log/event", methods=["POST"])
def create_client_audit_event():
    """Allow UI to emit lifecycle audit events for run navigation/actions."""
    try:
        payload = request.get_json(force=True, silent=True) or {}
        action = str(payload.get("action") or "").strip()
        details = str(payload.get("details") or "").strip()
        if not action:
            return jsonify({"ok": False, "error": "action is required"}), 400
        _audit(None, None, action, details)
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


def _build_audit_trail_html(entries, filters, factory):
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
        '@page { size: A4 landscape; margin: 10mm 8mm; }'
        'html, body { margin: 0; padding: 0; background:#ffffff; color:#111;'
        '   font-family: "Inter", "Segoe UI", Roboto, Arial, sans-serif; font-size: 9.5pt; }'
        'h1 { font-size: 14pt; margin: 0 0 4px 0; letter-spacing: 0.5px; }'
        'h2 { font-size: 11pt; margin: 0 0 8px 0; color:#444; font-weight: 600; }'
        '.brand { display:flex; justify-content:space-between; align-items:flex-end; '
        '         border-bottom: 2px solid #111; padding-bottom: 6px; margin-bottom: 8px; }'
        '.brand .meta { text-align: right; font-size: 9pt; color:#333; }'
        '.brand .meta div { line-height: 1.35; }'
        '.brand .meta strong { color:#111; }'
        '.chips { margin: 4px 0 8px 0; }'
        '.chip { display:inline-block; padding: 2px 8px; margin-right: 6px; margin-bottom: 4px;'
        '        background:#eef2ff; color:#1e3a8a; border-radius: 12px; font-size: 8.5pt; }'
        '.muted { color:#666; font-style: italic; font-size: 8.5pt; }'
        'table { width:100%; border-collapse: collapse; table-layout: fixed; }'
        'thead th { background:#111827; color:#fff; padding: 6px 6px; text-align: left;'
        '           font-weight:600; font-size: 9pt; border: 1px solid #111827; }'
        'tbody td { border: 1px solid #d1d5db; padding: 5px 6px; vertical-align: top;'
        '           word-wrap: break-word; overflow-wrap: break-word; }'
        'tbody tr:nth-child(even) td { background: #f9fafb; }'
        '.col-sl  { width: 4%; text-align: right; font-variant-numeric: tabular-nums; }'
        '.col-dt  { width: 11%; font-variant-numeric: tabular-nums; line-height: 1.25; }'
        '.col-dt .dt-date { display: block; white-space: nowrap; font-weight: 600; }'
        '.col-dt .dt-time { display: block; white-space: nowrap; font-size: 8.5pt; color: #444; }'
        '.col-out { width: 9%; }'
        '.col-det { width: 36%; }'
        '.empty { text-align: center; padding: 18px 0; color:#666; font-style: italic; }'
        '.footer { margin-top: 10px; font-size: 8pt; color:#555; '
        '          border-top: 1px solid #d1d5db; padding-top: 6px; }'
        '.footer .left  { float: left; }'
        '.footer .right { float: right; }'
        '.footer::after { content: ""; display: block; clear: both; }'
        '</style></head><body>'
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
        '</body></html>'
    )


@app.route("/api/audit/export", methods=["POST"])
def export_audit_trails():
    """Export filtered audit entries as a write-protected PDF on the external pendrive.

    Restricted to factory/admin roles. The PDF is the read-only "preview" format that
    replaces the previous JSON dump (which was editable).
    """
    mounted_now = None
    try:
        gate = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
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

        entries = audit_service.list_entries(filters)
        try:
            factory = data_service.get_factory_settings() or {}
        except Exception:
            factory = {}
        html = _build_audit_trail_html(entries, filters, factory)
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

        _audit(
            cur.get("username") or cur.get("name"),
            cur.get("role"),
            "Audit trail exported",
            "pdf {} | entries {}".format(out_path, len(entries)),
        )
        return jsonify({
            "success": True,
            "path": str(out_path),
            "export_directory": str(export_dir),
            "format": "pdf",
            "entries": len(entries),
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


# =================== CALCULATE ==========================


@app.route("/api/calculate/recipe-validate", methods=["POST"])
def validate_recipe_endpoint():
    try:
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


@app.route("/api/usb/list", methods=["GET"])
def list_usb_pendrives():
    """List external pendrives suitable for export (excludes OS root + internal USB)."""
    try:
        devices = usb_export.list_external_pendrives()
        return jsonify({"success": True, "devices": devices}), 200
    except Exception as e:
        app.logger.exception("Error listing USB devices")
        return jsonify({"success": False, "error": str(e), "devices": []}), 500


def _report_pdf_path(report_id):
    return REPORTS_DIR / "report_{}.pdf".format(int(report_id))


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
    """Render the supplied HTML for a report to PDF and store it next to the .txt files.

    Body: { "html": "<full document or fragment>" }
    """
    try:
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"success": False, "error": "Report not found"}), 404
        payload = request.get_json(force=True, silent=True) or {}
        html = payload.get("html")
        if not isinstance(html, str) or not html.strip():
            return jsonify({"success": False, "error": "html is required"}), 400
        out_path = _report_pdf_path(report_id)
        pdf_generator.render_html_to_pdf(html, out_path)
        _audit(None, None, "Report PDF generated", "report {} -> {}".format(report_id, out_path))
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
      pdf_html_by_id:    { "<report_id>": "<html>", ... } (optional; auto-generate any missing PDFs)
      export_path:       "/abs/path"                      (optional; override mount detection for dev)

    Returns 409 with `devices` list when multiple pendrives are connected and none chosen.
    """
    mounted_now = None
    try:
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
        gate = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
        device_path = (data.get("device_path") or "").strip() or None
        requested_export_path = (data.get("export_path") or "").strip() or None
        pdf_html_by_id = data.get("pdf_html_by_id") or {}
        if isinstance(pdf_html_by_id, dict):
            pdf_html_by_id = {str(k): v for k, v in pdf_html_by_id.items() if isinstance(v, str) and v.strip()}
        else:
            pdf_html_by_id = {}

        # Generate any missing PDFs (best-effort; collect missing list for clear errors).
        generated = []
        missing = []
        for rid in report_ids:
            pdf_path = _report_pdf_path(rid)
            if pdf_path.exists() and pdf_path.stat().st_size > 0:
                continue
            html = pdf_html_by_id.get(str(rid))
            if html:
                try:
                    pdf_generator.render_html_to_pdf(html, pdf_path)
                    generated.append(rid)
                except Exception as e:
                    app.logger.warning("[EXPORT] PDF generation failed for report %s: %s", rid, e)
                    missing.append(rid)
            else:
                missing.append(rid)
        if missing:
            return jsonify({
                "success": False,
                "error": (
                    "PDF unavailable for report(s): {}. Open each report in the app first, "
                    "or re-export after saving."
                ).format(", ".join(str(i) for i in missing)),
                "missing_pdfs": missing,
            }), 400

        export_dir, err, devices, mounted_now = _resolve_export_destination(device_path, requested_export_path)
        if err == "MULTIPLE_PENDRIVES":
            return jsonify({"success": False, "error": "Multiple pendrives detected. Choose one.", "devices": devices, "code": "MULTIPLE_PENDRIVES"}), 409
        if err:
            return jsonify({"success": False, "error": err, "devices": devices}), 400

        export_dir.mkdir(parents=True, exist_ok=True)

        exported_files = []
        failed = []
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
            except Exception as e:
                failed.append({"id": rid, "error": str(e)})

        # Best-effort sync + unmount (only if we mounted it here).
        # Default is power_off=False so repeat exports don't require re-plugging.
        unmount_detail = None
        if mounted_now and not requested_export_path:
            power_off = bool(data.get("power_off") or False)
            unmount_detail = usb_export.sync_and_unmount_pendrive(mounted_now, power_off=power_off)

        id_part = ",".join(str(i) for i in report_ids[:20])
        if len(report_ids) > 20:
            id_part += ",…"
        _audit(
            None, None,
            "Reports exported",
            "count {} ok={} fail={} | ids [{}] | dir {}".format(
                len(report_ids), len(exported_files), len(failed), id_part, export_dir
            ),
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
    pdf_html_by_id_raw = data.get("pdf_html_by_id") or {}
    if isinstance(pdf_html_by_id_raw, dict):
        pdf_html_by_id = {str(k): v for k, v in pdf_html_by_id_raw.items() if isinstance(v, str) and v.strip()}
    else:
        pdf_html_by_id = {}
    power_off = bool(data.get("power_off") or False)

    gate = _require_export_usb_and_verification_json()
    if gate is not None:
        return gate

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
                # 1) Ensure a PDF exists for this report (generate if needed).
                pdf_src = _report_pdf_path(rid)
                if not (pdf_src.exists() and pdf_src.stat().st_size > 0):
                    html = pdf_html_by_id.get(str(rid))
                    if not html:
                        result["failed"].append({"id": rid, "reason": "PDF not cached and no HTML supplied"})
                        yield _emit({"event": "report", "current": i, "total": total,
                                     "percent": int(next_progress_at), "id": rid,
                                     "status": "failed"})
                        continue
                    yield _emit({"event": "report", "current": i, "total": total,
                                 "percent": int(this_progress_at + per_report_pct * 0.3), "id": rid,
                                 "status": "generating",
                                 "message": "Generating PDF for report {} of {}...".format(i, total)})
                    try:
                        pdf_generator.render_html_to_pdf(html, pdf_src)
                    except Exception as e:
                        app.logger.warning("[EXPORT-STREAM] PDF render failed for %s: %s", rid, e)
                        result["failed"].append({"id": rid, "reason": "render"})
                        yield _emit({"event": "report", "current": i, "total": total,
                                     "percent": int(next_progress_at), "id": rid,
                                     "status": "failed"})
                        continue

                # 2) Copy to pendrive destination.
                report = data_service.get_report(rid) or {}
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

            id_part = ",".join(str(i) for i in report_ids[:20])
            if len(report_ids) > 20:
                id_part += ",..."
            _audit(
                None, None,
                "Reports exported",
                "stream count {} ok={} fail={} | ids [{}] | dir {}".format(
                    total, result["count"], len(result["failed"]), id_part, result["export_directory"]
                ),
            )

            result["ok"] = (len(result["failed"]) == 0 and result["count"] > 0)
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


# =================== PRINT ==========================


@app.route("/api/print/a4", methods=["POST"])
def print_a4():
    try:
        data = request.get_json(force=True, silent=True) or {}
        if data.get("type") == "recipe" and data.get("recipe_data"):
            recipe_data = dict(data["recipe_data"])
            if not recipe_data.get("factorySettings"):
                try:
                    recipe_data["factorySettings"] = data_service.get_factory_settings()
                except Exception:
                    pass
            result = print_service.print_recipe_a4(recipe_data)
            rname = recipe_data.get("productName") or recipe_data.get("name") or ""
            _audit(None, None, "Print A4", "recipe | {}".format(rname or "—"))
            return jsonify(result), 200
        report_data = data.get("report_data", {}) or {}
        report_id = report_data.get("id")
        if report_id is not None:
            path_a4 = REPORTS_DIR / f"report_{report_id}_a4.txt"
            if path_a4.exists():
                result = print_service.print_report_from_file(
                    path_a4, config.get("A4_PORT", ""), config.get("A4_BAUD", 9600), "a4"
                )
                if result.get("success"):
                    _audit(None, None, "Print A4", "report id {} | from file".format(report_id))
                return jsonify(result), 200 if result.get("success") else 500
        if not report_data.get("factorySettings"):
            try:
                report_data = dict(report_data)
                report_data["factorySettings"] = data_service.get_factory_settings()
            except Exception:
                pass
        result = print_service.print_a4_report(report_data)
        rid = report_data.get("id")
        _audit(
            None,
            None,
            "Print A4",
            "report id {} | inline".format(rid if rid is not None else "—"),
        )
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error printing A4")
        return jsonify({"error": str(e)}), 500


@app.route("/api/print/thermal", methods=["POST"])
def print_thermal():
    try:
        data = request.get_json(force=True, silent=True) or {}
        if data.get("type") == "recipe" and data.get("recipe_data"):
            recipe_data = dict(data["recipe_data"])
            if not recipe_data.get("factorySettings"):
                try:
                    recipe_data["factorySettings"] = data_service.get_factory_settings()
                except Exception:
                    pass
            result = print_service.print_recipe_thermal(recipe_data)
            rname = recipe_data.get("productName") or recipe_data.get("name") or ""
            _audit(None, None, "Print thermal", "recipe | {}".format(rname or "—"))
            return jsonify(result), 200
        report_data = data.get("report_data", {}) or {}
        report_id = report_data.get("id")
        if report_id is not None:
            path_thermal = REPORTS_DIR / f"report_{report_id}_thermal.txt"
            if path_thermal.exists():
                result = print_service.print_report_from_file(
                    path_thermal, config.get("THERMAL_PORT", ""), config.get("THERMAL_BAUD", 9600), "thermal"
                )
                if result.get("success"):
                    _audit(None, None, "Print thermal", "report id {} | from file".format(report_id))
                return jsonify(result), 200 if result.get("success") else 500
        if not report_data.get("factorySettings"):
            try:
                report_data = dict(report_data)
                report_data["factorySettings"] = data_service.get_factory_settings()
            except Exception:
                pass
        result = print_service.print_thermal_report(report_data)
        rid = report_data.get("id")
        _audit(
            None,
            None,
            "Print thermal",
            "report id {} | inline".format(rid if rid is not None else "—"),
        )
        return jsonify(result), 200
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
    return hardware_service.start_sse_stream()


@app.route("/api/hardware/log/reset", methods=["POST"])
def hardware_log_reset():
    result = hardware_service.reset_uart_log(reason="ui_refresh")
    code = 200 if result.get("ok") else 500
    return jsonify(result), code


@app.route("/api/hardware/command", methods=["POST"])
def hardware_command():
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
    result = hardware_service.cmd_status()
    return jsonify(result)


@app.route("/api/hardware/calibrate/tare", methods=["POST"])
def calibrate_tare():
    return jsonify({"ok": False, "error": "Tare command is not supported by current ESP firmware"}), 400


@app.route("/api/hardware/validation/load/start", methods=["POST"])
def validation_load_start():
    data = request.get_json(force=True, silent=True) or {}
    mode = str(data.get("mode") or "usp2").strip().lower()
    if mode not in ("usp1", "usp2"):
        mode = "usp2"
    result = hardware_service.cmd_start_validation(mode)
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/validation/load/stop", methods=["POST"])
def validation_load_stop():
    return jsonify(hardware_service.cmd_stop())


@app.route("/api/hardware/adapter/check", methods=["POST"])
def hardware_check_adapter():
    result = hardware_service.cmd_check_adapter()
    return jsonify(result)


@app.route("/api/hardware/tap/start", methods=["POST"])
def hardware_tap_start():
    data = request.get_json(force=True, silent=True) or {}
    speed_mode = data.get("speedMode")
    taps = data.get("tapCount")
    result = hardware_service.cmd_start_taps(speed_mode, taps)
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/tap/stop", methods=["POST"])
def hardware_tap_stop():
    result = hardware_service.cmd_stop()
    return jsonify(result)


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
    import time
    from datetime import timedelta
    now_ts = time.time()
    try:
        if DATETIME_STORAGE.exists():
            with open(DATETIME_STORAGE, "r", encoding="utf-8") as f:
                data = json.load(f)
            dt_str = data.get("datetime", "")
            last_tick = data.get("last_tick", now_ts)
            if dt_str:
                from datetime import datetime
                dt_obj = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
                elapsed = max(0, now_ts - last_tick)
                dt_obj = dt_obj + timedelta(seconds=elapsed)
                with open(DATETIME_STORAGE, "w", encoding="utf-8") as f:
                    json.dump({"datetime": dt_obj.strftime("%Y-%m-%dT%H:%M:%S"), "last_tick": now_ts}, f)
                return {
                    "datetime": dt_obj.strftime("%Y-%m-%dT%H:%M:%S"),
                    "date": dt_obj.strftime("%d-%m-%Y"),
                    "time": dt_obj.strftime("%H:%M"),
                }
    except Exception:
        pass
    from datetime import datetime
    now = datetime.now()
    return {
        "datetime": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "date": now.strftime("%d-%m-%Y"),
        "time": now.strftime("%H:%M"),
    }


@app.route("/api/get_datetime", methods=["GET"])
def get_datetime():
    return jsonify(_get_stored_datetime())


def _set_datetime_common():
    role = (request.headers.get("X-User-Role") or "").strip().lower()
    if role not in ALLOWED_DATETIME_ROLES:
        return jsonify({"ok": False, "error": "forbidden"}), 403
    data = request.get_json(force=True, silent=True) or {}
    dt_str = data.get("datetime", "")
    if not dt_str:
        return jsonify({"ok": False, "error": "datetime required"}), 400
    try:
        from datetime import datetime
        dt_obj = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
    except Exception:
        return jsonify({"ok": False, "error": "invalid datetime"}), 400
    system_ok, system_err = _set_system_datetime(dt_obj)
    if not system_ok:
        return jsonify({"ok": False, "error": system_err or "Failed to set system time"}), 500
    try:
        STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        with open(DATETIME_STORAGE, "w", encoding="utf-8") as f:
            json.dump({"datetime": dt_obj.strftime("%Y-%m-%dT%H:%M:%S"), "last_tick": time.time()}, f)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    _sync_rtc_after_datetime_set(dt_obj)
    _audit(None, None, "System date change", dt_str)
    return jsonify({"ok": True, "datetime": dt_obj.strftime("%Y-%m-%dT%H:%M:%S")})


def _run_datetime_command(cmd, timeout_sec=5):
    """Run date/time command with direct and sudo fallback."""
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec, check=True)
        return True, ""
    except Exception as first_err:
        if cmd and cmd[0] == "sudo":
            return False, str(first_err)
        try:
            subprocess.run(["sudo"] + list(cmd), capture_output=True, text=True, timeout=timeout_sec, check=True)
            return True, ""
        except Exception as sudo_err:
            return False, str(sudo_err or first_err)


def _set_system_datetime(dt_obj):
    """Set OS clock from provided datetime (Pi/Linux)."""
    if sys.platform == "win32":
        return True, ""
    date_cmd_str = dt_obj.strftime("%Y-%m-%d %H:%M:%S")
    ok, err = _run_datetime_command(["date", "-s", date_cmd_str], timeout_sec=5)
    if ok:
        return True, ""
    ok2, err2 = _run_datetime_command(["timedatectl", "set-time", date_cmd_str], timeout_sec=5)
    if ok2:
        return True, ""
    return False, ("date failed: {} ; timedatectl failed: {}".format(err, err2)).strip()


def _sync_rtc_after_datetime_set(dt_obj):
    """Best-effort RTC sync after system datetime update."""
    # 1) Sync DS1307 via I2C (if available).
    try:
        rtc_res = rtc_service.set_rtc_date(dt_obj)
        if not rtc_res.get("success"):
            app.logger.warning("RTC I2C sync failed after datetime set: %s", rtc_res.get("error"))
    except Exception as rtc_err:
        app.logger.warning("RTC I2C sync exception after datetime set: %s", rtc_err)
    # 2) Sync OS hardware clock for boot-time restore.
    if sys.platform == "win32":
        return
    ok, err = _run_datetime_command(["hwclock", "--systohc"], timeout_sec=5)
    if not ok:
        app.logger.warning("hwclock sync failed after datetime set: %s", err)


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
    role = (request.headers.get("X-User-Role") or "").strip().lower()
    if role not in ALLOWED_DATETIME_ROLES:
        return jsonify({"ok": False, "error": "forbidden"}), 403
    data = request.get_json(force=True, silent=True) or {}
    dt_str = data.get("datetime", "")
    if not dt_str:
        return jsonify({"success": False, "error": "datetime required"}), 400
    try:
        from datetime import datetime
        dt_obj = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
    except Exception:
        return jsonify({"success": False, "error": "invalid datetime"}), 400
    result = rtc_service.set_rtc_date(dt_obj)
    if result.get("success"):
        _audit(None, None, "RTC date set", dt_str)
    return jsonify(result), 200 if result.get("success") else 500


_startup_session_power_audit()
_register_clean_shutdown_signals()


# =================== MAIN ==========================


if __name__ == "__main__":
    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=False)

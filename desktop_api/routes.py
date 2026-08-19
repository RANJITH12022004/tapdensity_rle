"""Bearer-token desktop API routes. Delegates PDF/audit rendering to existing app helpers."""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import tempfile
import time
import zipfile
from datetime import datetime

from flask import Blueprint, after_this_request, jsonify, request, send_file

import audit_service
import data_service
import pdf_generator
import rbac_service

from desktop_api import auth_store
from desktop_api.members_routes import register_members_routes
from desktop_api.recipes_routes import register_recipes_routes


def _filter_range(filters: dict) -> dict:
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


def _send_temp(path, download_name, mimetype):
    path = pathlib.Path(path)

    @after_this_request
    def _cleanup(response):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return response

    return send_file(path, mimetype=mimetype, as_attachment=True, download_name=download_name)


def _is_display_ipv4(ip: str) -> bool:
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


def _collect_ipv4_addresses():
    found = []
    seen = set()
    source = ""

    def add_ip(ip):
        if not _is_display_ipv4(ip):
            return
        if ip in seen:
            return
        seen.add(ip)
        found.append(ip)

    try:
        proc = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=10)
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
                proc = subprocess.run(ip_cmd, capture_output=True, text=True, timeout=10)
                if proc.returncode != 0:
                    continue
                source = " ".join(ip_cmd)
                for line in (proc.stdout or "").splitlines():
                    parts = line.split()
                    for part in parts:
                        if "/" in part and re.match(r"^\d+\.\d+\.\d+\.\d+/\d+$", part):
                            add_ip(part.split("/")[0])
                if found:
                    break
            except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
                continue

    return found, source


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


def _locked_login_audit_details(member, username):
    member = member or {}
    attempted_username = str(member.get("username") or username or "").strip() or "--"
    attempted_name = str(member.get("name") or "").strip() or "--"
    return "Locked account {} ({}) tried to log in".format(attempted_username, attempted_name)


def _disabled_login_audit_details(member, username):
    member = member or {}
    attempted_username = str(member.get("username") or username or "").strip() or "--"
    attempted_name = str(member.get("name") or "").strip() or "--"
    return "Disabled account {} ({}) tried to log in".format(attempted_username, attempted_name)


def create_blueprint(kiosk):
    """Build blueprint; kiosk is the loaded app module for shared PDF/audit helpers."""
    bp = Blueprint("rle_desktop_api", __name__, url_prefix="/api/desktop/v1")

    audit_event = getattr(kiosk, "_audit_event", None)
    audit_log = getattr(kiosk, "_audit", None)

    def log_audit(user, action, details, **kwargs):
        if audit_event:
            audit_event(
                action=action,
                outcome=kwargs.get("outcome", "success"),
                entity_type=kwargs.get("entity_type", "desktop"),
                entity_name=kwargs.get("entity_name", "desktop"),
                details=details,
                target_user=kwargs.get("target_user") or (user.get("username") if user else None),
                extra=kwargs.get("extra"),
            )
        elif audit_log and user:
            audit_log(user.get("username") or user.get("name"), user.get("role"), action, details)

    @bp.route("/health", methods=["GET"])
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

    @bp.route("/auth/login", methods=["POST"])
    def desktop_auth_login():
        try:
            credentials = request.get_json(force=True, silent=True) or {}
            username = str(credentials.get("username") or "").strip()
            password = credentials.get("password") if isinstance(credentials.get("password"), str) else str(credentials.get("password") or "")
            if not username:
                return jsonify({"error": "Username is required."}), 400

            if username.upper() == data_service.FACTORY_USERNAME.upper():
                user = data_service.authenticate_user(username, password)
                if user:
                    data_service.record_successful_login(username)
                    token, safe_user = auth_store.issue_token(user)
                    log_audit(safe_user, "Desktop login", "Desktop user logged in: {}".format(username))
                    return jsonify({"success": True, "token": token, "user": safe_user}), 200
                log_audit(
                    None,
                    "Desktop login",
                    "User {} (Factory) entered the wrong password; attempt not counted for the factory account".format(
                        username or data_service.FACTORY_USERNAME
                    ),
                    outcome="denied",
                    target_user=username or data_service.FACTORY_USERNAME,
                )
                return jsonify({"error": "Invalid username or password."}), 401

            member = data_service.get_member_by_username(username)
            if member:
                status = str(member.get("status") or "active").strip().lower()
                if status == "locked":
                    log_audit(
                        None,
                        "Desktop login",
                        _locked_login_audit_details(member, username),
                        outcome="denied",
                        target_user=username,
                    )
                    return jsonify({"error": "Account locked. Contact admin."}), 403
                if status == "disabled":
                    log_audit(
                        None,
                        "Desktop login",
                        _disabled_login_audit_details(member, username),
                        outcome="denied",
                        target_user=username,
                    )
                    return jsonify({"error": "Account disabled by admin."}), 403

            user = data_service.authenticate_user(username, password)
            if not user:
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
                    log_audit(
                        None,
                        "Desktop login",
                        details,
                        outcome="denied",
                        target_user=updated.get("username") or username,
                        extra={
                            "failedAttempts": fa,
                            "maximumAttempts": maximum,
                            "remainingAttempts": remaining,
                        },
                    )
                    if status == "locked":
                        return jsonify({"error": "Account locked. Contact admin.", "remainingAttempts": 0}), 403
                    return jsonify({"error": "Invalid username or password.", "remainingAttempts": remaining}), 401
                return jsonify({"error": "Invalid username or password."}), 401

            member = data_service.get_member_by_username(username)
            if member:
                if bool(member.get("mustChangePassword")):
                    return jsonify({"error": "Password change required before login.", "passwordChangeRequired": True}), 403
                expiry = data_service.get_member_password_expiry_state(member)
                if bool(expiry.get("expired")):
                    return jsonify({"error": "Password expired. Reset required.", "passwordExpired": True, "expiry": expiry}), 403

            data_service.record_successful_login(username)
            token, safe_user = auth_store.issue_token(user)
            log_audit(safe_user, "Desktop login", "Desktop user logged in: {}".format(username))
            return jsonify({"success": True, "token": token, "user": safe_user}), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/auth/me", methods=["GET"])
    @auth_store.require_auth
    def desktop_auth_me(user):
        return jsonify({"user": user}), 200

    @bp.route("/auth/logout", methods=["POST"])
    @auth_store.require_auth
    def desktop_auth_logout(user):
        auth_store.revoke_token(auth_store.token_from_request())
        log_audit(user, "Desktop logout", "Desktop user logged out: {}".format(user.get("username") or user.get("name") or "--"))
        return jsonify({"success": True}), 200

    @bp.route("/reports", methods=["GET"])
    @auth_store.require_internal("reports-view")
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

    @bp.route("/reports/<int:report_id>/pdf", methods=["GET"])
    @auth_store.require_internal("reports-view")
    def desktop_report_pdf(user, report_id):
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"error": "Report not found"}), 404
        if not kiosk._report_pdf_status_allowed(report):
            return jsonify({"error": "PDF is available only after the report is approved or marked aborted."}), 403
        if not kiosk._generate_report_pdf_file(report_id, write_audit=True):
            return jsonify({"error": "PDF generation failed"}), 500
        path = kiosk._report_pdf_path(report_id)
        return send_file(path, mimetype="application/pdf", as_attachment=False, download_name="report-{}.pdf".format(report_id))

    @bp.route("/reports/download", methods=["POST"])
    @auth_store.require_internal("reports-view")
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
        else:
            wanted = [int(r.get("id")) for r in data_service.list_reports("all") if r.get("id") is not None]
        fd, tmp_path = tempfile.mkstemp(suffix=".zip")
        os.close(fd)
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for rid in wanted:
                if kiosk._generate_report_pdf_file(rid, write_audit=False):
                    pdf_path = kiosk._report_pdf_path(rid)
                    if pdf_path.exists():
                        zf.write(pdf_path, arcname="report-{}.pdf".format(rid))
        return _send_temp(tmp_path, "tap-density-reports.zip", "application/zip")

    @bp.route("/audit", methods=["GET"])
    @auth_store.require_internal("audit-view")
    def desktop_audit(user):
        filters = _filter_range(request.args.to_dict(flat=True))
        entries = audit_service.list_entries(filters)
        return jsonify({"entries": entries}), 200

    @bp.route("/audit/download", methods=["POST"])
    @auth_store.require_internal("audit-view")
    def desktop_audit_download(user):
        payload = request.get_json(force=True, silent=True) or {}
        filters = _filter_range(payload)
        entries = audit_service.list_entries(filters)
        pdf_bytes = pdf_generator.generate_audit_trail_pdf(entries)
        fd, tmp_path = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)
        pathlib.Path(tmp_path).write_bytes(pdf_bytes)
        log_audit(user, "Desktop audit export", "Desktop audit trail downloaded ({} rows)".format(len(entries)))
        return _send_temp(tmp_path, "audit-trail.pdf", "application/pdf")

    @bp.route("/network/ips", methods=["GET"])
    @auth_store.require_auth
    def desktop_network_ips(user):
        addresses, source = _collect_ipv4_addresses()
        return jsonify({"ok": True, "addresses": addresses, "source": source or "unknown"}), 200

    @bp.route("/factory-settings", methods=["GET"])
    @auth_store.require_auth
    def desktop_factory_settings(user):
        settings = data_service.get_factory_settings() or {}
        return jsonify({"settings": settings}), 200

    @bp.route("/backup/download", methods=["POST"])
    @auth_store.require_internal("factory-settings")
    def desktop_backup_download(user):
        paths = kiosk._desktop_zip_paths()
        fd, tmp_path = tempfile.mkstemp(suffix=".zip")
        os.close(fd)
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for label, path in paths.items():
                p = pathlib.Path(path)
                if p.is_file():
                    zf.write(p, arcname="{}/{}".format(label, p.name))
                elif p.is_dir():
                    for child in p.rglob("*"):
                        if child.is_file():
                            zf.write(child, arcname="{}/{}".format(label, child.relative_to(p)))
        log_audit(user, "Desktop backup", "Desktop backup downloaded")
        return _send_temp(tmp_path, "tap-density-backup.zip", "application/zip")

    register_members_routes(bp, kiosk)
    register_recipes_routes(bp, kiosk)

    return bp

#!/usr/bin/env python3
"""
data_service.py - Data storage and management service for Tap Density
Handles CRUD for recipes, reports, members, and factory settings.
All data stored as JSON files under STORAGE_DIR.
"""

import json
import pathlib
from datetime import datetime, timedelta
from typing import Optional, Dict, List, Any

_config = {}
_storage_dir = None
_reports_dir = None
_current_user = None

FACTORY_USERNAME = "RLERLT"
FACTORY_PASSWORD = "Rahul"
FACTORY_USER = {
    "id": 0,
    "name": "Factory",
    "username": FACTORY_USERNAME,
    "role": "Factory",
}

import rbac_service

PERMISSIONS_VERSION = rbac_service.PERMISSIONS_VERSION
FEATURE_CATALOG_KEYS = rbac_service.FEATURE_CATALOG_KEYS


def init(config):
    """Initialize data service with config."""
    global _config, _storage_dir, _reports_dir
    _config = dict(config)
    _storage_dir = pathlib.Path(_config.get("STORAGE_DIR", "./storage"))
    _reports_dir = pathlib.Path(_config.get("REPORTS_DIR", "./reports"))
    _storage_dir.mkdir(parents=True, exist_ok=True)
    _reports_dir.mkdir(parents=True, exist_ok=True)


def _get_storage_path(filename: str) -> pathlib.Path:
    safe_name = "".join(c for c in filename if c.isalnum() or c in "-_.")
    return _storage_dir / safe_name


def _load_json_file(filepath: pathlib.Path, default=None):
    if default is None:
        default = []
    if not filepath.exists():
        return default
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if data is not None else default
    except Exception:
        return default


def _save_json_file(filepath: pathlib.Path, data):
    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# =================== RECIPE OPERATIONS ==========================


def list_recipes(filter_type=None):
    """List all recipes, optionally filtered by type."""
    recipes_path = _get_storage_path("recipes.json")
    recipes = _load_json_file(recipes_path, default=[])
    if not isinstance(recipes, list):
        recipes = []
    if filter_type:
        recipes = [r for r in recipes if r.get("type") == filter_type]
    return recipes


def get_recipe(recipe_id: int):
    """Get recipe by ID."""
    recipes = list_recipes()
    for recipe in recipes:
        if recipe.get("id") == recipe_id:
            return recipe
    return None


def save_recipe(recipe_data: Dict[str, Any]) -> int:
    """Save recipe (create or update). Enforces maxRecipes from factory settings."""
    recipes_path = _get_storage_path("recipes.json")
    recipes = list_recipes()
    recipe_id = recipe_data.get("id")
    is_update = recipe_id and any(r.get("id") == recipe_id for r in recipes)

    if not is_update:
        fs = get_factory_settings()
        max_recipes = int(fs.get("maxRecipes") or 150)
        if len(recipes) >= max_recipes:
            raise ValueError("Your limit for recipes reached. Contact support for upgrade.")

    if recipe_id and is_update:
        for i, r in enumerate(recipes):
            if r.get("id") == recipe_id:
                recipes[i] = recipe_data
                _save_json_file(recipes_path, recipes)
                return recipe_id

    if recipe_id and not is_update:
        recipe_data["id"] = recipe_id
        recipes.append(recipe_data)
    else:
        max_id = max([r.get("id", 0) for r in recipes], default=0)
        recipe_id = max_id + 1
        recipe_data["id"] = recipe_id
        recipes.append(recipe_data)

    _save_json_file(recipes_path, recipes)
    return recipe_id


def delete_recipe(recipe_id: int) -> bool:
    """Delete recipe by ID."""
    recipes_path = _get_storage_path("recipes.json")
    recipes = list_recipes()
    original_len = len(recipes)
    recipes = [r for r in recipes if r.get("id") != recipe_id]
    if len(recipes) < original_len:
        _save_json_file(recipes_path, recipes)
        return True
    return False


# =================== REPORT OPERATIONS ==========================


def list_reports(filter_type="all"):
    """List reports, optionally filtered by type."""
    reports_path = _get_storage_path("reports.json")
    reports = _load_json_file(reports_path, default=[])
    if not isinstance(reports, list):
        reports = []
    if filter_type and filter_type != "all":
        reports = [r for r in reports if r.get("type") == filter_type]

    def sort_key(r):
        ts = r.get("createdAt") or r.get("completedAt") or ""
        try:
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            if dt.tzinfo is not None:
                dt = dt.astimezone().replace(tzinfo=None)
            return dt.timestamp()
        except Exception:
            return float("-inf")

    reports.sort(key=sort_key, reverse=True)
    return reports


def get_report(report_id: int):
    """Get report by ID."""
    reports = list_reports()
    for report in reports:
        if report.get("id") == report_id:
            return report
    return None


def save_report(report_data: Dict[str, Any]) -> int:
    """Save report (create or update)."""
    reports_path = _get_storage_path("reports.json")
    reports = list_reports("all")
    report_id = report_data.get("id")
    if not report_id:
        max_id = max([r.get("id", 0) for r in reports], default=0)
        report_id = max_id + 1
        report_data["id"] = report_id
    if not report_data.get("createdAt"):
        report_data["createdAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    found = False
    for i, r in enumerate(reports):
        if r.get("id") == report_id:
            reports[i] = report_data
            found = True
            break
    if not found:
        reports.append(report_data)
    _save_json_file(reports_path, reports)
    return report_id


def delete_report(report_id: int) -> bool:
    """Delete report by ID."""
    reports_path = _get_storage_path("reports.json")
    reports = list_reports("all")
    original_len = len(reports)
    reports = [r for r in reports if r.get("id") != report_id]
    if len(reports) < original_len:
        _save_json_file(reports_path, reports)
        return True
    return False


# =================== MEMBER OPERATIONS ==========================


def list_members():
    """List all members. Excludes hidden factory user. Normalizes status/failedAttempts."""
    members_path = _get_storage_path("members.json")
    members = _load_json_file(members_path, default=[])
    if not isinstance(members, list):
        members = []

    normalized: List[Dict[str, Any]] = []
    for m in members:
        if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
            continue
        status = str(m.get("status") or "active").strip().lower()
        if status not in ("active", "locked", "disabled"):
            status = "active"
        m["status"] = status
        try:
            fa = int(m.get("failedAttempts") or 0)
        except (TypeError, ValueError):
            fa = 0
        if fa < 0:
            fa = 0
        m["failedAttempts"] = fa
        _normalize_member_biometric_fields(m)
        _normalize_member_feature_overrides(m)
        _normalize_member_password_fields(m)
        normalized.append(m)
    return normalized


def get_member(member_id: int):
    """Get member by ID."""
    members = list_members()
    for member in members:
        if member.get("id") == member_id:
            return member
    return None


def count_active_qa_members() -> int:
    """Count members with role QA and status active (not locked/disabled)."""
    members = list_members()
    n = 0
    for m in members:
        if str(m.get("role", "")).strip().lower() != "qa":
            continue
        if str(m.get("status", "active")).strip().lower() == "active":
            n += 1
    return n


def count_active_supervisor_members() -> int:
    """Count members with role Supervisor (Reviewer) and status active."""
    members = list_members()
    n = 0
    for m in members:
        if str(m.get("role", "")).strip().lower() != "supervisor":
            continue
        if str(m.get("status", "active")).strip().lower() == "active":
            n += 1
    return n


def _check_member_limits(members: List[Dict], member_data: Dict[str, Any], existing_member: Optional[Dict] = None):
    """Check factory limits for users, admins, supervisors. Raise ValueError if exceeded."""
    fs = get_factory_settings()
    max_users = int(fs.get("maxUsers") or 10)
    max_admins = int(fs.get("maxAdmins") or 2)
    max_supervisors = int(fs.get("maxSupervisors") or 3)

    def count_role(ms: List, r: str) -> int:
        return sum(1 for m in ms if str(m.get("role", "")).strip().lower() == r)

    new_role = str(member_data.get("role", "User")).strip().lower()
    users = count_role(members, "user")
    admins = count_role(members, "admin")
    supervisors = count_role(members, "supervisor")

    if existing_member:
        old_role = str(existing_member.get("role", "")).strip().lower()
        if old_role == "user":
            users -= 1
        elif old_role == "admin":
            admins -= 1
        elif old_role == "supervisor":
            supervisors -= 1

    if new_role == "user":
        users += 1
    elif new_role == "admin":
        admins += 1
    elif new_role == "supervisor":
        supervisors += 1

    if users > max_users:
        raise ValueError("Your limit for users reached. Contact support for upgrade.")
    if admins > max_admins:
        raise ValueError("Your limit for admins reached. Contact support for upgrade.")
    if supervisors > max_supervisors:
        raise ValueError("Your limit for reviewers reached. Contact support for upgrade.")


def _member_username_key(member: Dict[str, Any]) -> str:
    return str(member.get("username", "")).strip().lower()


def _to_bool(v, default=True):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        t = v.strip().lower()
        if t in ("false", "0", "off", "no", "disabled"):
            return False
        if t in ("true", "1", "on", "yes", "enabled"):
            return True
    return bool(default)


def _normalize_member_biometric_fields(member: Dict[str, Any]) -> None:
    member["biometricEnabled"] = _to_bool(member.get("biometricEnabled", True), default=True)
    t = member.get("fingerprintTemplateId")
    if t is None or t == "":
        member["fingerprintTemplateId"] = None
    else:
        try:
            member["fingerprintTemplateId"] = int(t)
        except (TypeError, ValueError):
            member["fingerprintTemplateId"] = None
    if "biometricEnrolledAt" not in member:
        member["biometricEnrolledAt"] = None
    if "biometricEnrollmentStatus" not in member:
        member["biometricEnrollmentStatus"] = "not_enrolled"


def _normalize_member_feature_overrides(member: Dict[str, Any]) -> None:
    rbac_service.migrate_member_permissions_v1_to_v2(member)
    member["permissionsVersion"] = int(member.get("permissionsVersion") or PERMISSIONS_VERSION)
    raw = member.get("featureOverrides")
    if not isinstance(raw, dict):
        raw = {}
    allow_in = raw.get("allow")
    deny_in = raw.get("deny")
    allow = []
    deny = []
    if isinstance(allow_in, list):
        for item in allow_in:
            key = str(item or "").strip()
            if key and key in FEATURE_CATALOG_KEYS and key not in allow:
                allow.append(key)
    if isinstance(deny_in, list):
        for item in deny_in:
            key = str(item or "").strip()
            if key and key in FEATURE_CATALOG_KEYS and key not in deny:
                deny.append(key)
    # deny wins in allow/deny conflict
    allow = [k for k in allow if k not in deny]
    member["featureOverrides"] = {
        "allow": sorted(allow),
        "deny": sorted(deny),
    }


def _normalize_member_password_fields(member: Dict[str, Any]) -> None:
    """Normalize member password metadata used for expiry policy."""
    created_at = str(member.get("createdAt") or "").strip()
    if not created_at:
        created_at = datetime.utcnow().isoformat() + "Z"
        member["createdAt"] = created_at
    plc = str(member.get("passwordLastChangedAt") or "").strip()
    if not plc:
        member["passwordLastChangedAt"] = created_at


def _parse_isoish_datetime(value: Any) -> Optional[datetime]:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        # Normalize to naive datetime for safe comparisons with local-naive policy dates.
        if dt.tzinfo is not None:
            dt = dt.replace(tzinfo=None)
        return dt
    except Exception:
        return None


def _parse_installation_date(value: Any) -> Optional[datetime]:
    """Parse installation date from yyyy-mm-dd or dd-mm-yyyy."""
    s = str(value or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt)
        except Exception:
            continue
    return None


def get_password_policy_for_members() -> Dict[str, Any]:
    """Return parsed password policy from factory settings."""
    fs = get_factory_settings()
    install_dt = _parse_installation_date(fs.get("installationDate"))
    try:
        period_days = int(fs.get("passwordResetPeriodDays"))
    except (TypeError, ValueError):
        period_days = 0
    if period_days < 1:
        period_days = 0
    enabled = bool(install_dt and period_days > 0)
    return {
        "enabled": enabled,
        "installationDate": install_dt,
        "periodDays": period_days,
    }


def get_member_password_expiry_state(member: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    Compute password expiry status for a non-factory member.
    Global cycle anchor: installationDate + N * periodDays.
    """
    policy = get_password_policy_for_members()
    if not policy.get("enabled"):
        return {"expired": False, "reason": "policy-disabled"}
    anchor = policy.get("installationDate")
    period_days = int(policy.get("periodDays") or 0)
    now_dt = now or datetime.now()
    if now_dt.tzinfo is not None:
        now_dt = now_dt.replace(tzinfo=None)
    if not anchor or period_days < 1:
        return {"expired": False, "reason": "invalid-policy"}
    if now_dt < anchor:
        return {"expired": False, "reason": "before-anchor"}
    # First enforcement boundary uses "after N full days from installation".
    # Example: 01-03 + 30 days => enforce from 01-04.
    cycle_start = anchor + timedelta(days=period_days + 1)
    plc_dt = _parse_isoish_datetime(member.get("passwordLastChangedAt")) or _parse_isoish_datetime(member.get("createdAt"))
    if not plc_dt:
        plc_dt = datetime.min
    expired = now_dt >= cycle_start and plc_dt < cycle_start
    return {
        "expired": bool(expired),
        "expiresOn": cycle_start.strftime("%Y-%m-%d"),
        "cycleStart": cycle_start.strftime("%Y-%m-%dT%H:%M:%S"),
        "passwordLastChangedAt": plc_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "periodDays": period_days,
    }


def save_member(member_data: Dict[str, Any]) -> int:
    """Save member (create or update). Cannot create or modify factory user."""
    username = str(member_data.get("username", "")).strip().upper()
    if username == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be created or modified.")
    members_path = _get_storage_path("members.json")
    members = _load_json_file(members_path, default=[])
    if not isinstance(members, list):
        members = []
    key_new = _member_username_key(member_data)
    if not key_new:
        raise ValueError("User ID is required.")
    member_id = member_data.get("id")
    existing = next((m for m in members if m.get("id") == member_id), None) if member_id else None
    if existing:
        for m in members:
            if m.get("id") != member_id and _member_username_key(m) == key_new:
                raise ValueError("Another member already uses this User ID.")
        _check_member_limits(members, member_data, existing_member=existing)
        # Preserve existing status/failedAttempts unless explicitly provided
        if "status" not in member_data:
            member_data["status"] = existing.get("status", "active")
        if "failedAttempts" not in member_data:
            member_data["failedAttempts"] = existing.get("failedAttempts", 0)
        if "biometricEnabled" not in member_data:
            member_data["biometricEnabled"] = existing.get("biometricEnabled", True)
        if "fingerprintTemplateId" not in member_data:
            member_data["fingerprintTemplateId"] = existing.get("fingerprintTemplateId")
        if "biometricEnrolledAt" not in member_data:
            member_data["biometricEnrolledAt"] = existing.get("biometricEnrolledAt")
        if "biometricEnrollmentStatus" not in member_data:
            member_data["biometricEnrollmentStatus"] = existing.get("biometricEnrollmentStatus", "not_enrolled")
        if "permissionsVersion" not in member_data:
            member_data["permissionsVersion"] = existing.get("permissionsVersion", PERMISSIONS_VERSION)
        if "featureOverrides" not in member_data:
            member_data["featureOverrides"] = existing.get("featureOverrides", {"allow": [], "deny": []})
        if "password" not in member_data:
            member_data["password"] = existing.get("password", "")
        old_pwd = str(existing.get("password", ""))
        new_pwd = str(member_data.get("password", ""))
        if "passwordLastChangedAt" not in member_data:
            if new_pwd != old_pwd:
                member_data["passwordLastChangedAt"] = datetime.utcnow().isoformat() + "Z"
            else:
                member_data["passwordLastChangedAt"] = existing.get("passwordLastChangedAt") or existing.get("createdAt") or datetime.utcnow().isoformat() + "Z"
        if "createdAt" not in member_data:
            member_data["createdAt"] = existing.get("createdAt") or datetime.utcnow().isoformat() + "Z"
        _normalize_member_biometric_fields(member_data)
        _normalize_member_feature_overrides(member_data)
        _normalize_member_password_fields(member_data)
        for i, m in enumerate(members):
            if m.get("id") == member_id:
                members[i] = member_data
                break
        _save_json_file(members_path, members)
        return member_id

    for m in members:
        if _member_username_key(m) == key_new:
            raise ValueError("Another member already uses this User ID.")
    _check_member_limits(members, member_data)
    max_id = max([m.get("id", 0) for m in members], default=0)
    member_id = max_id + 1
    member_data["id"] = member_id
    # Defaults for new member
    status = str(member_data.get("status") or "active").strip().lower()
    if status not in ("active", "locked", "disabled"):
        status = "active"
    member_data["status"] = status
    try:
        fa = int(member_data.get("failedAttempts") or 0)
    except (TypeError, ValueError):
        fa = 0
    if fa < 0:
        fa = 0
    member_data["failedAttempts"] = fa
    if "createdAt" not in member_data:
        member_data["createdAt"] = datetime.utcnow().isoformat() + "Z"
    if "passwordLastChangedAt" not in member_data:
        member_data["passwordLastChangedAt"] = member_data.get("createdAt")
    _normalize_member_biometric_fields(member_data)
    _normalize_member_feature_overrides(member_data)
    _normalize_member_password_fields(member_data)
    members.append(member_data)
    _save_json_file(members_path, members)
    return member_id


def delete_member(member_id: int) -> bool:
    """Delete member by ID. Cannot delete factory user."""
    members_path = _get_storage_path("members.json")
    members = _load_json_file(members_path, default=[])
    if not isinstance(members, list):
        members = []
    member_to_delete = next((m for m in members if m.get("id") == member_id), None)
    if member_to_delete and str(member_to_delete.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be deleted.")
    original_len = len(members)
    members = [m for m in members if m.get("id") != member_id]
    if len(members) < original_len:
        _save_json_file(members_path, members)
        return True
    return False


def clear_member_biometric(member_id: int) -> Dict[str, Any]:
    """Clear biometric template linkage and enrollment metadata for a member."""
    m = get_member(member_id)
    if not m:
        raise ValueError("Member not found")
    if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be modified.")
    m["fingerprintTemplateId"] = None
    m["biometricEnrollmentStatus"] = "not_enrolled"
    m["biometricEnrolledAt"] = None
    _save_member_record(m)
    return m


def authenticate_user(username: str, password: str) -> Optional[Dict[str, Any]]:
    """Authenticate user by username and password. Hardcoded factory user always valid."""
    username_clean = username.strip()
    if username_clean.upper() == FACTORY_USERNAME.upper() and password == FACTORY_PASSWORD:
        return dict(FACTORY_USER)
    members = list_members()
    username_lower = username_clean.lower()
    for member in members:
        member_username = str(member.get("username", "")).strip().lower()
        member_password = str(member.get("password", ""))
        if member_username == username_lower and member_password == password:
            user = dict(member)
            user.pop("password", None)
            return user
    return None


def get_member_by_username(username: str) -> Optional[Dict[str, Any]]:
    """Lookup member by username (case-insensitive, excluding factory user)."""
    username_clean = (username or "").strip()
    if not username_clean:
        return None
    if username_clean.upper() == FACTORY_USERNAME.upper():
        return None
    username_lower = username_clean.lower()
    members_path = _get_storage_path("members.json")
    members = _load_json_file(members_path, default=[])
    if not isinstance(members, list):
        members = []
    for m in members:
        u = str(m.get("username", "")).strip().lower()
        if u == username_lower:
            _normalize_member_biometric_fields(m)
            _normalize_member_feature_overrides(m)
            _normalize_member_password_fields(m)
            return m
    return None


def has_non_empty_feature_overrides(member_data: Dict[str, Any]) -> bool:
    """True when payload attempts to persist allow/deny feature overrides."""
    if not isinstance(member_data, dict):
        return False
    raw = member_data.get("featureOverrides")
    if not isinstance(raw, dict):
        return False
    allow = raw.get("allow")
    deny = raw.get("deny")
    return bool((isinstance(allow, list) and len(allow) > 0) or (isinstance(deny, list) and len(deny) > 0))


def get_member_by_fingerprint_template(template_id: int) -> Optional[Dict[str, Any]]:
    """Lookup member by fingerprint template id."""
    try:
        tid = int(template_id)
    except (TypeError, ValueError):
        return None
    members = list_members()
    for m in members:
        t = m.get("fingerprintTemplateId")
        if t is None:
            continue
        try:
            if int(t) == tid:
                return m
        except (TypeError, ValueError):
            continue
    return None


def get_next_fingerprint_template_id(max_templates: int = 1000) -> int:
    """Find next available template id in [1, max_templates]."""
    used = set()
    for m in list_members():
        t = m.get("fingerprintTemplateId")
        if t is None:
            continue
        try:
            tid = int(t)
            if 1 <= tid <= max_templates:
                used.add(tid)
        except (TypeError, ValueError):
            continue
    for candidate in range(1, max_templates + 1):
        if candidate not in used:
            return candidate
    raise ValueError("No biometric template slots available.")


def _save_member_record(updated: Dict[str, Any]) -> None:
    """Internal helper to persist a single member record by id."""
    members_path = _get_storage_path("members.json")
    members = _load_json_file(members_path, default=[])
    if not isinstance(members, list):
        members = []
    _normalize_member_password_fields(updated)
    mid = updated.get("id")
    replaced = False
    for i, m in enumerate(members):
        if m.get("id") == mid:
            members[i] = updated
            replaced = True
            break
    if not replaced:
        members.append(updated)
    _save_json_file(members_path, members)


def set_member_password(member_id: int, new_password: str, changed_at: Optional[str] = None) -> Dict[str, Any]:
    """Set password for member and stamp passwordLastChangedAt."""
    m = get_member(member_id)
    if not m:
        raise ValueError("Member not found")
    if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("Factory user password cannot be changed from this flow.")
    m["password"] = str(new_password or "")
    m["passwordLastChangedAt"] = str(changed_at or (datetime.utcnow().isoformat() + "Z"))
    _save_member_record(m)
    return m


def record_failed_login(username: str) -> Optional[Dict[str, Any]]:
    """Increment failedAttempts and return updated member (if exists and not factory)."""
    m = get_member_by_username(username)
    if not m:
        return None
    status = str(m.get("status") or "active").strip().lower()
    if status not in ("active", "locked", "disabled"):
        status = "active"
    try:
        fa = int(m.get("failedAttempts") or 0)
    except (TypeError, ValueError):
        fa = 0
    fa += 1
    if fa >= 3 and status == "active":
        status = "locked"
    m["failedAttempts"] = fa
    m["status"] = status
    _save_member_record(m)
    return m


def record_successful_login(username: str) -> Optional[Dict[str, Any]]:
    """Reset failedAttempts on successful login for non-factory users."""
    m = get_member_by_username(username)
    if not m:
        return None
    m["failedAttempts"] = 0
    if str(m.get("status") or "").strip().lower() == "locked":
        # Do not silently unlock locked accounts; admin must unlock.
        pass
    _save_member_record(m)
    return m


def unlock_member(member_id: int) -> Dict[str, Any]:
    """Set member status to active. Preserves failedAttempts."""
    m = get_member(member_id)
    if not m:
        raise ValueError("Member not found")
    if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be modified.")
    m["status"] = "active"
    _save_member_record(m)
    return m


def disable_member(member_id: int) -> Dict[str, Any]:
    """Set member status to disabled. Preserves remaining member data."""
    m = get_member(member_id)
    if not m:
        raise ValueError("Member not found")
    if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be modified.")
    m["status"] = "disabled"
    _save_member_record(m)
    return m


def enable_member(member_id: int) -> Dict[str, Any]:
    """Set member status to active. Preserves failedAttempts."""
    m = get_member(member_id)
    if not m:
        raise ValueError("Member not found")
    if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be modified.")
    m["status"] = "active"
    _save_member_record(m)
    return m


def factory_reset() -> Dict[str, Any]:
    """Delete all reports, recipes, and members. Preserves factory settings and factory user."""
    recipes_path = _get_storage_path("recipes.json")
    reports_path = _get_storage_path("reports.json")
    members_path = _get_storage_path("members.json")
    recipes = _load_json_file(recipes_path, default=[])
    reports = _load_json_file(reports_path, default=[])
    members = _load_json_file(members_path, default=[])
    n_recipes = len(recipes) if isinstance(recipes, list) else 0
    n_reports = len(reports) if isinstance(reports, list) else 0
    n_members = len(members) if isinstance(members, list) else 0
    _save_json_file(recipes_path, [])
    _save_json_file(reports_path, [])
    _save_json_file(members_path, [])
    n_report_files = 0
    if _reports_dir and _reports_dir.exists():
        for f in list(_reports_dir.iterdir()):
            if f.is_file() and f.suffix.lower() in (".pdf", ".json", ".txt"):
                try:
                    f.unlink()
                    n_report_files += 1
                except Exception:
                    pass
    return {
        "deleted": {
            "recipes": n_recipes,
            "reports": n_reports,
            "members": n_members,
            "reportFiles": n_report_files,
        }
    }


# =================== FACTORY SETTINGS ==========================


def get_factory_settings() -> Dict[str, Any]:
    """Get factory settings."""
    settings_path = _get_storage_path("factorySettings.json")
    settings = _load_json_file(settings_path, default={})
    if not isinstance(settings, dict):
        settings = {}
    if "biometricEnabled" not in settings:
        settings["biometricEnabled"] = True
    if "passwordResetPeriodDays" not in settings:
        settings["passwordResetPeriodDays"] = 30
    return settings


def save_factory_settings(settings: Dict[str, Any]):
    """Save factory settings with validation. Merges with existing file; drops deprecated loadCellRange."""
    def _to_bool(v):
        if isinstance(v, bool):
            return v
        if isinstance(v, (int, float)):
            return bool(v)
        if isinstance(v, str):
            t = v.strip().lower()
            if t in ("false", "0", "off", "no", "disabled"):
                return False
            if t in ("true", "1", "on", "yes", "enabled"):
                return True
        return True

    if not isinstance(settings, dict):
        settings = {}
    merged = dict(get_factory_settings())
    merged.update(settings)
    merged.pop("loadCellRange", None)
    merged["biometricEnabled"] = _to_bool(merged.get("biometricEnabled", True))
    for key, default, min_val, max_val in [
        ("maxRecipes", 150, 1, 999),
        ("maxUsers", 10, 1, 999),
        ("maxAdmins", 2, 1, 99),
        ("maxSupervisors", 3, 1, 99),
        ("passwordResetPeriodDays", 30, 1, 3650),
    ]:
        val = merged.get(key)
        if val is not None:
            try:
                val = max(min_val, min(max_val, int(val)))
            except (ValueError, TypeError):
                val = default
            merged[key] = val
    settings_path = _get_storage_path("factorySettings.json")
    _save_json_file(settings_path, merged)


# =================== SESSION ==========================


def save_current_user(user: Dict[str, Any]):
    """Save current logged-in user session."""
    global _current_user
    _current_user = dict(user)
    session_path = _get_storage_path("current_user.json")
    _save_json_file(session_path, _current_user)


def get_current_user() -> Optional[Dict[str, Any]]:
    """Get current logged-in user."""
    global _current_user
    if _current_user:
        return _current_user
    session_path = _get_storage_path("current_user.json")
    _current_user = _load_json_file(session_path, default=None)
    return _current_user


def clear_current_user():
    """Clear current user session."""
    global _current_user
    _current_user = None
    session_path = _get_storage_path("current_user.json")
    if session_path.exists():
        try:
            session_path.unlink()
        except Exception:
            pass


_SESSION_POWER_AUDIT_PENDING = "session_power_audit_pending.json"
_APP_CLEAN_STOP_FLAG = "app_clean_stop.flag"


def write_session_power_audit_pending(user: Dict[str, Any]):
    """Mark an open logged-in session for unclean-shutdown detection on next process start."""
    path = _get_storage_path(_SESSION_POWER_AUDIT_PENDING)
    payload = {
        "username": (user.get("username") or user.get("name") or "").strip(),
        "role": (user.get("role") or "").strip(),
        "ts_ms": int(datetime.now().timestamp() * 1000),
    }
    _save_json_file(path, payload)


def read_session_power_audit_pending() -> Optional[Dict[str, Any]]:
    path = _get_storage_path(_SESSION_POWER_AUDIT_PENDING)
    if not path.exists():
        return None
    data = _load_json_file(path, default=None)
    return data if isinstance(data, dict) else None


def delete_session_power_audit_pending():
    path = _get_storage_path(_SESSION_POWER_AUDIT_PENDING)
    if path.exists():
        try:
            path.unlink()
        except Exception:
            pass


def consume_app_clean_stop_flag() -> bool:
    """If the previous process exit was marked clean (SIGTERM/SIGINT), return True and remove the flag."""
    path = _get_storage_path(_APP_CLEAN_STOP_FLAG)
    if not path.exists():
        return False
    try:
        path.unlink()
        return True
    except Exception:
        return False


def touch_app_clean_stop_flag():
    """Mark a clean application shutdown (best-effort; used to avoid false power-interruption audits)."""
    path = _get_storage_path(_APP_CLEAN_STOP_FLAG)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    except Exception:
        pass


# =================== TEST RUN DATA ==========================


def save_test_run_data(test_data: Dict[str, Any]):
    """Save quick test run data."""
    test_path = _get_storage_path("test_run.json")
    _save_json_file(test_path, test_data)


def get_test_run_data() -> Dict[str, Any]:
    """Get last test run data."""
    test_path = _get_storage_path("test_run.json")
    return _load_json_file(test_path, default={})

"""
Server-side permission expansion (mirrors rbac.js card model).
Used by data_service normalization and app.py route guards.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

PERMISSIONS_VERSION = 2

PERMISSION_CARD_KEYS = [
    "perm_test_access",
    "perm_test_report_approve",
    "perm_recipe_manage",
    "perm_recipe_approve",
    "perm_profile_admin",
    "perm_validation_test",
    "perm_validation_report_approve",
    "perm_datetime",
    "perm_reports_view",
    "perm_audit_view",
    "perm_export_usb",
    "perm_export_approve",
]

PERM_CARD_EXPAND: Dict[str, List[str]] = {
    "perm_test_access": ["quick-test", "recipe-test"],
    "perm_test_report_approve": ["test-report-approve"],
    "perm_recipe_manage": ["recipe-manage", "recipe-list", "recipe-edit", "settings"],
    "perm_recipe_approve": ["recipe-approve"],
    "perm_profile_admin": [
        "user-manage",
        "user-add",
        "user-delete",
        "user-unlock",
        "user-enable",
        "user-change-role",
        "settings",
    ],
    "perm_validation_test": ["validation-test", "settings"],
    "perm_validation_report_approve": ["validation-report-approve"],
    "perm_datetime": ["edit-datetime", "settings"],
    "perm_reports_view": ["reports-view"],
    "perm_audit_view": ["audit-view"],
    "perm_export_usb": ["export-usb"],
    "perm_export_approve": ["export-approve"],
}

LEGACY_INTERNAL_KEYS = [
    "quick-test",
    "recipe-list",
    "recipe-manage",
    "recipe-edit",
    "recipe-delete",
    "reports-view",
    "reports-delete",
    "validate-menu",
    "settings",
    "edit-datetime",
    "profile",
    "user-manage",
    "user-add",
    "user-delete",
    "user-unlock",
    "user-enable",
    "user-change-role",
    "disable-recipes",
]

FEATURE_CATALOG_KEYS = sorted(set(PERMISSION_CARD_KEYS + LEGACY_INTERNAL_KEYS))

# --- Legacy role table (same semantics as rbac.js ROLE_RESTRICTIONS) ---

ROLE_RESTRICTIONS: Dict[str, Dict[str, str]] = {
    "admin": {
        "factory-settings": "no-access",
        "factory-reset": "no-access",
    },
    "supervisor": {
        "user-manage": "view-only",
        "user-add": "no-access",
        "user-delete": "no-access",
        "user-unlock": "no-access",
        "user-enable": "no-access",
        "user-change-role": "no-access",
        "factory-settings": "view-only",
        "factory-reset": "no-access",
        "edit-datetime": "no-access",
        "reports-delete": "no-access",
        "recipe-delete": "no-access",
    },
    "user": {
        "user-manage": "no-access",
        "user-add": "no-access",
        "user-delete": "no-access",
        "user-unlock": "no-access",
        "user-enable": "no-access",
        "user-change-role": "no-access",
        "factory-settings": "no-access",
        "factory-reset": "no-access",
        "edit-datetime": "no-access",
        "recipe-edit": "no-access",
        "recipe-delete": "no-access",
        "reports-delete": "no-access",
        "validate-menu": "no-access",
        "disable-recipes": "no-access",
    },
    "factory": {},
    "qa": {},
}

MASTER_INTERNAL_MIGRATION = [
    "quick-test",
    "recipe-list",
    "recipe-manage",
    "recipe-edit",
    "recipe-delete",
    "recipe-test",
    "reports-view",
    "reports-delete",
    "validate-menu",
    "validation-test",
    "calibration-menu",
    "settings",
    "edit-datetime",
    "profile",
    "user-manage",
    "user-add",
    "user-delete",
    "user-unlock",
    "user-enable",
    "user-change-role",
    "disable-recipes",
    "test-report-approve",
    "recipe-approve",
    "validation-report-approve",
    "audit-view",
    "export-usb",
    "export-approve",
]


def _legacy_key_allowed(role: str, feature_key: str) -> bool:
    r = str(role or "").strip().lower()
    rules = ROLE_RESTRICTIONS.get(r) or {}
    return rules.get(feature_key) != "no-access"


def expand_allow_list(allow: List[str]) -> Set[str]:
    out: Set[str] = set()
    for raw in allow or []:
        k = str(raw or "").strip()
        if not k:
            continue
        if k in PERM_CARD_EXPAND:
            out.update(PERM_CARD_EXPAND[k])
        elif k in LEGACY_INTERNAL_KEYS or k in (
            "recipe-test",
            "validation-test",
            "calibration-menu",
            "test-report-approve",
            "recipe-approve",
            "validation-report-approve",
            "audit-view",
            "export-usb",
            "export-approve",
        ):
            out.add(k)
    return out


def member_expanded_internal_keys(member: Dict[str, Any]) -> Set[str]:
    role = str((member or {}).get("role") or "").strip().lower()
    un = str((member or {}).get("username") or "").strip().upper()
    if role == "factory" or un == "RLERLT":
        return set(MASTER_INTERNAL_MIGRATION)  # factory bypass handled per-route for factory-settings
    raw = (member or {}).get("featureOverrides") or {}
    allow_in = raw.get("allow") if isinstance(raw.get("allow"), list) else []
    return expand_allow_list([str(x or "").strip() for x in allow_in])


def member_has_internal(member: Dict[str, Any], internal_key: str) -> bool:
    if not internal_key:
        return False
    role = str((member or {}).get("role") or "").strip().lower()
    un = str((member or {}).get("username") or "").strip().upper()
    if role == "factory" or un == "RLERLT":
        return True
    if internal_key in ("dashboard", "login", "profile"):
        return True
    return internal_key in member_expanded_internal_keys(member)


def _internal_to_perm_cards_strict(internal: Set[str]) -> List[str]:
    """Grant a permission card only if every expanded internal key is present."""
    cards: List[str] = []
    for card, keys in PERM_CARD_EXPAND.items():
        if keys and all(k in internal for k in keys):
            cards.append(card)
    return sorted(cards)


def migrate_member_permissions_v1_to_v2(member: Dict[str, Any]) -> None:
    """If permissionsVersion < 2, derive card allow-list from legacy role+overrides."""
    try:
        ver = int(member.get("permissionsVersion") or 0)
    except (TypeError, ValueError):
        ver = 0
    if ver >= PERMISSIONS_VERSION:
        return
    role = str(member.get("role") or "User").strip()
    role_l = role.lower()
    raw = member.get("featureOverrides")
    if not isinstance(raw, dict):
        raw = {}
    allow_old = [str(x).strip() for x in (raw.get("allow") or []) if str(x or "").strip()]
    deny_old = {str(x).strip() for x in (raw.get("deny") or []) if str(x or "").strip()}
    internal: Set[str] = set()
    for k in allow_old:
        if k == "validate-menu":
            internal.add("validation-test")
            internal.add("calibration-menu")
            continue
        if k in PERM_CARD_EXPAND:
            internal.update(PERM_CARD_EXPAND[k])
        elif k in MASTER_INTERNAL_MIGRATION:
            internal.add(k)
    internal -= deny_old
    if role_l == "factory":
        new_allow = list(PERMISSION_CARD_KEYS)
    else:
        new_allow = _internal_to_perm_cards_strict(internal)
    member["featureOverrides"] = {"allow": sorted(set(new_allow)), "deny": []}
    member["permissionsVersion"] = PERMISSIONS_VERSION


PERMISSION_CARD_LABELS: Dict[str, str] = {
    "perm_test_access": "Test access",
    "perm_test_report_approve": "Test report approval",
    "perm_recipe_manage": "Manage recipes",
    "perm_recipe_approve": "Recipe approval",
    "perm_profile_admin": "Profile management",
    "perm_validation_test": "Validation test access",
    "perm_validation_report_approve": "Validation report approval",
    "perm_datetime": "Edit date and time",
    "perm_reports_view": "View and print reports",
    "perm_audit_view": "View and export audit trails",
    "perm_export_usb": "Export reports and audit (USB)",
    "perm_export_approve": "Export approval",
}


def permission_allow_cards(member: Optional[Dict[str, Any]]) -> List[str]:
    """Normalized permission card keys granted to a member."""
    if not isinstance(member, dict):
        return []
    raw = member.get("featureOverrides") or {}
    allow_in = raw.get("allow") if isinstance(raw.get("allow"), list) else []
    cards = sorted(
        {
            str(x).strip()
            for x in allow_in
            if str(x or "").strip() in PERM_CARD_EXPAND
        }
    )
    return cards


def _permission_card_labels(card_keys: List[str]) -> List[str]:
    return [PERMISSION_CARD_LABELS.get(k, k) for k in card_keys]


def member_permissions_audit_snapshot(member: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(member, dict):
        return {"role": "", "permissions": []}
    return {
        "role": str(member.get("role") or "").strip(),
        "permissions": permission_allow_cards(member),
    }


def build_permission_change_audit(
    before_member: Optional[Dict[str, Any]],
    after_member: Optional[Dict[str, Any]],
    target_username: str = "",
) -> Optional[Dict[str, Any]]:
    """
    Build audit details when permission cards and/or role changed.
    Returns None if there was no permissions/role change.
    """
    before_allow = set(permission_allow_cards(before_member))
    after_allow = set(permission_allow_cards(after_member))
    before_role = str((before_member or {}).get("role") or "").strip()
    after_role = str((after_member or {}).get("role") or "").strip()
    granted = sorted(after_allow - before_allow)
    revoked = sorted(before_allow - after_allow)
    role_changed = before_role.lower() != after_role.lower()
    if not granted and not revoked and not role_changed:
        return None
    uname = (target_username or "").strip() or str(
        (after_member or {}).get("username") or (after_member or {}).get("name") or ""
    ).strip()
    parts: List[str] = []
    if role_changed:
        parts.append("role {} → {}".format(before_role or "—", after_role or "—"))
    if granted:
        parts.append("granted: {}".format(", ".join(_permission_card_labels(granted))))
    if revoked:
        parts.append("revoked: {}".format(", ".join(_permission_card_labels(revoked))))
    return {
        "details": "User permissions updated for {}: {}".format(uname or "—", "; ".join(parts)),
        "extra": {
            "granted": granted,
            "revoked": revoked,
            "roleBefore": before_role,
            "roleAfter": after_role,
        },
        "before": member_permissions_audit_snapshot(before_member),
        "after": member_permissions_audit_snapshot(after_member),
    }

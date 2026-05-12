#!/usr/bin/env python3
"""
calculation_service.py - Tap Density recipe validation and form processing.
"""

from datetime import datetime
from typing import Dict, List, Any, Optional


def init():
    pass


def validate_recipe(recipe_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate tap-density recipe. Required: productName or name; steps (array) with speed, dropHeight, tapCount; cylinder.
    Returns { "valid": bool, "error": str }.
    """
    errors = []
    name = (recipe_data.get("productName") or recipe_data.get("name") or "").strip()
    if not name:
        errors.append("Product name is required")

    steps = recipe_data.get("steps")
    if steps is not None and not isinstance(steps, list):
        errors.append("Steps must be an array")
    elif isinstance(steps, list):
        for i, s in enumerate(steps):
            if not isinstance(s, dict):
                errors.append(f"Step {i + 1}: invalid format")
                continue
            try:
                sp = s.get("speed") if s.get("speed") is not None else s.get("tapsPerMin")
                if sp is not None and (int(sp) < 1 or int(sp) > 500):
                    errors.append(f"Step {i + 1}: speed/taps per min must be 1-500")
            except (TypeError, ValueError):
                pass
            try:
                dh = s.get("dropHeight") or s.get("heightMm")
                if dh is not None and (float(dh) < 0 or float(dh) > 50):
                    errors.append(f"Step {i + 1}: drop height must be 0-50 mm")
            except (TypeError, ValueError):
                pass
            try:
                tc = s.get("tapCount") or s.get("taps")
                if tc is not None and (int(tc) < 0 or int(tc) > 10000):
                    errors.append(f"Step {i + 1}: tap count must be 0-10000")
            except (TypeError, ValueError):
                pass        

    cylinder = recipe_data.get("cylinder") or recipe_data.get("cylinderSize")
    if cylinder is not None and isinstance(cylinder, dict):
        vol = cylinder.get("volume") or cylinder.get("volumeMl")
        if vol is not None:
            try:
                v = float(vol)
                if v <= 0 or v > 1000:
                    errors.append("Cylinder volume must be 0-1000 ml")
            except (TypeError, ValueError):
                errors.append("Invalid cylinder volume")

    mode = str(recipe_data.get("uspMode") or "").strip().upper()
    if mode == "CUSTOM":
        try:
            ct = recipe_data.get("customTotalTaps")
            if ct is None:
                errors.append("Custom total taps is required when uspMode is Custom")
            else:
                n = int(ct)
                sc = recipe_data.get("stepCount")
                steps_len = len(recipe_data.get("steps") or []) if isinstance(recipe_data.get("steps"), list) else 0
                n_steps = int(sc) if sc is not None else (steps_len or 0)
                if n < 1:
                    errors.append("Custom total taps must be at least 1")
                elif n_steps >= 1 and n < n_steps:
                    errors.append("Custom total taps must be at least the number of steps")
        except (TypeError, ValueError):
            errors.append("Invalid customTotalTaps")

    if errors:
        return {"valid": False, "error": "; ".join(errors)}
    return {"valid": True}


def process_recipe_form_data(form_data: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize recipe form data for storage."""
    recipe = dict(form_data)
    if "createdAt" not in recipe:
        recipe["createdAt"] = datetime.utcnow().isoformat() + "Z"
    if "lastUsed" not in recipe:
        recipe["lastUsed"] = recipe.get("createdAt", "")
    return recipe

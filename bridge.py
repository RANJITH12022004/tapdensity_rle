#!/usr/bin/env python3
"""
bridge.py - Kiosk entry point for Tap Density. Sets APP_ROOT and runs Flask app.
Registers the isolated RLE Desktop Client API without modifying app.py routes.
"""

import os
import pathlib

if "APP_ROOT" not in os.environ:
    _script_dir = pathlib.Path(__file__).resolve().parent
    if str(_script_dir).startswith("/opt/kiosk"):
        os.environ.setdefault("APP_ROOT", "/opt/kiosk")
    else:
        os.environ.setdefault("APP_ROOT", str(_script_dir))

import app as kiosk_app
from app import app

try:
    from desktop_api import register as register_desktop_api

    register_desktop_api(app, kiosk_app)
except Exception as exc:
    app.logger.warning("Desktop API not loaded: %s", exc)

if __name__ == "__main__":
    host = os.environ.get("FLASK_HOST", "0.0.0.0")
    port = int(os.environ.get("FLASK_PORT", "5000"))
    app.run(host=host, port=port, debug=False)

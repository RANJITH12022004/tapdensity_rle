#!/usr/bin/env python3
"""
print_service.py - Printing operations service
Reference-aligned A4 and thermal printing over serial.
"""

import logging
import os
import pathlib
import time
from datetime import datetime
from typing import Any, Dict, Optional

try:
    import serial
except ImportError:
    serial = None

try:
    import bridge_services
except ImportError:
    bridge_services = None

A4_CANDIDATES = ["/dev/ttyAMA4", "/dev/ttyUSB0", "/dev/ttyUSB1", "COM3", "COM4"]
THERMAL_CANDIDATES = ["/dev/ttyAMA3", "/dev/ttyUSB0", "/dev/ttyUSB1", "COM3", "COM4"]

_PRINTER_INIT_SEQ = b"\x1b\x40"
_log = logging.getLogger(__name__)

_config = {}
_a4_port = None
_a4_baud = None
_thermal_port = None
_thermal_baud = None


def init(config):
    global _config, _a4_port, _a4_baud, _thermal_port, _thermal_baud
    _config = dict(config)
    _a4_port = _config.get("A4_PORT", "/dev/ttyAMA4")
    _a4_baud = int(_config.get("A4_BAUD", 9600))
    _thermal_port = _config.get("THERMAL_PORT", "/dev/ttyAMA3")
    _thermal_baud = int(_config.get("THERMAL_BAUD", 9600))


def _is_windows_com_port(port: str) -> bool:
    return bool(port and str(port).strip().upper().startswith("COM"))


def _port_exists(port: str) -> bool:
    if not port:
        return False
    if _is_windows_com_port(port):
        return True
    return os.path.exists(port)


def _probe_port(port: str, candidates: list) -> str:
    cands = ([port] if port else []) + [c for c in candidates if c and c != port]
    if bridge_services:
        return bridge_services.probe_and_choose_port(port, candidates=cands)
    if port and _port_exists(port):
        return port
    for p in candidates:
        if p and _port_exists(p):
            return p
    raise FileNotFoundError(2, "Serial device not found", port or "no-config")


def check_printer_status(printer_type: str = "a4") -> Dict[str, Any]:
    port = _a4_port if printer_type == "a4" else _thermal_port
    baud = _a4_baud if printer_type == "a4" else _thermal_baud
    if not serial:
        return {"available": False, "error": "pyserial not installed", "port": port}
    if not _port_exists(port):
        return {"available": False, "error": f"Printer port not found: {port}", "port": port}
    try:
        ser = serial.Serial(port=port, baudrate=baud, timeout=1.0)
        ser.close()
        return {"available": True, "port": port, "baud": baud}
    except Exception as e:
        return {"available": False, "error": str(e), "port": port}


def _open_a4_serial(port: str, baud: int):
    params = dict(
        port=port,
        baudrate=baud,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        timeout=2,
        write_timeout=2,
    )
    try:
        return serial.Serial(**params)
    except Exception:
        time.sleep(0.5)
        return serial.Serial(**params)


def _send_printer_init(ser) -> None:
    ser.write(_PRINTER_INIT_SEQ)
    ser.flush()
    time.sleep(0.05)


def _send_bytes_chunked(ser, data: bytes, baud: int, chunk_size: int = 64) -> None:
    delay = 0.08 if baud <= 9600 else 0.04
    for i in range(0, len(data), chunk_size):
        ser.write(data[i : i + chunk_size])
        ser.flush()
        if i + chunk_size < len(data):
            time.sleep(delay)
    time.sleep(0.1)


def _send_text_chunked(ser, text: str, baud: int, chunk_size: int = 64) -> None:
    try:
        data = text.encode("utf-8", errors="replace")
    except Exception:
        data = text.encode("latin-1", errors="replace")
    _send_bytes_chunked(ser, data, baud, chunk_size=chunk_size)


def _send_text_to_a4(ser, text: str, baud: int) -> int:
    text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    data = text.encode("utf-8", errors="replace")
    _send_bytes_chunked(ser, data, baud, chunk_size=512)
    return len(data)


def _format_ts_readable(ts: Any) -> str:
    if ts is None:
        return "--"
    if isinstance(ts, datetime):
        dt = ts.astimezone() if ts.tzinfo is not None else ts
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    s = str(ts).strip()
    if not s:
        return "--"
    try:
        s = s[:-1] + "+00:00" if s[-1:] in ("Z", "z") else s.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is not None:
            dt = dt.astimezone()
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return str(ts)


def _wrap_lines(lines: list, width: int) -> list:
    out = []
    for line in lines:
        if len(line) <= width:
            out.append(line)
            continue
        words = line.split()
        if not words:
            out.append("")
            continue
        cur = ""
        for w in words:
            nxt = w if not cur else (cur + " " + w)
            if len(nxt) <= width:
                cur = nxt
            else:
                if cur:
                    out.append(cur)
                cur = w
        if cur:
            out.append(cur)
    return out



def _fmt_density_val(val: Any) -> str:
    if val is None or val == "":
        return "--"
    try:
        f = float(val)
        return f"{f:.3f}".rstrip("0").rstrip(".") if f != int(f) else str(int(f))
    except (TypeError, ValueError):
        return str(val)


def _append_test_report_details(lines: list, td: Dict[str, Any], report_data: Dict[str, Any], width: int, thermal: bool) -> None:
    """Append remarks, step results, and statistics (matches on-screen report preview)."""
    dash = "" if thermal else ("-" * min(width, 70))
    remarks = report_data.get("remarks")
    if remarks is None and isinstance(td, dict):
        remarks = td.get("remarks")
    if remarks not in (None, ""):
        lines.extend(["", "REMARKS:", str(remarks), ""])

    if not isinstance(td, dict):
        td = {}
    step_count = td.get("stepCount")
    results = td.get("stepResults") or []
    if step_count is None and results:
        step_count = len(results)
    try:
        step_count = int(step_count or 0)
    except (TypeError, ValueError):
        step_count = len(results) if results else 0

    duration_sec = td.get("durationSeconds")
    if duration_sec is not None:
        try:
            lines.append(f"Test Duration: {int(duration_sec)} s")
        except (TypeError, ValueError):
            pass

    if step_count > 0 or results:
        lines.extend(["", "TEST DATA:" if thermal else "TEST DATA", dash if dash else ""])
        if not thermal:
            hdr = f"{'S':>2} {'Vol(ml)':>8} {'dVol':>7} {'Bulk':>8} {'Tap':>8} {'Result':>8}"
            lines.append(hdr)
            if dash:
                lines.append(dash)
        for i in range(max(step_count, len(results))):
            r = results[i] if i < len(results) and isinstance(results[i], dict) else {}
            vol = r.get("volumeMl", "__")
            dvol = r.get("volumeDeltaMl", "__")
            if dvol not in (None, "", "__"):
                dvol = _fmt_density_val(dvol)
            bulk = r.get("bulkDensity", "__")
            tap = r.get("tapDensity", "__")
            res = r.get("resultText", "__")
            sn = i + 1
            if thermal:
                lines.append(
                    f"{sn}. Vol:{vol} dVol:{dvol} Bulk:{bulk} Tap:{tap} Res:{res}"
                )
            else:
                lines.append(
                    f"{sn:2d} {str(vol):>8} {str(dvol):>7} {str(bulk):>8} {str(tap):>8} {str(res):>8}"
                )
    elif str(report_data.get("type") or "test").strip().lower() == "test":
        lines.extend(["", "TEST DATA: No test data recorded"])

    stats = report_data.get("statistics") or td.get("statistics") or {}
    if isinstance(stats, dict) and stats:
        lines.extend(["", "STATISTICS:" if thermal else "STATISTICS", dash if dash else ""])
        if not thermal:
            lines.append(f"{'Parameter':<16} {'Mean':>10} {'Min':>10} {'Max':>10}")
            if dash:
                lines.append(dash)
        for key, val in stats.items():
            if not isinstance(val, dict):
                continue
            mean = val.get("mean", val.get("Mean", "--"))
            mn = val.get("min", val.get("Min", "--"))
            mx = val.get("max", val.get("Max", "--"))
            if thermal:
                lines.append(f"{key}: mean={mean} min={mn} max={mx}")
            else:
                lines.append(f"{str(key):<16} {str(mean):>10} {str(mn):>10} {str(mx):>10}")


def _format_report_text(report_data: Dict[str, Any], width: int = 70) -> str:
    thermal = width < 70
    sep = "" if thermal else ("=" * width)
    td = report_data.get("testData") or report_data
    fs = report_data.get("factorySettings") or {}
    rtype = str(report_data.get("type") or "test").strip().lower()
    title = "TAP DENSITY VALIDATION REPORT" if rtype == "validation" else "TAP DENSITY TEST REPORT"
    lines = [
        sep,
        title if thermal else title.center(width),
        sep,
        f"Company: {fs.get('companyName', 'N/A')}",
        f"Model No: {fs.get('modelNo', 'N/A')}",
        f"Serial No: {fs.get('serialNo', 'N/A')}",
        f"Location: {fs.get('companyLocation', fs.get('location', 'N/A'))}",
        f"Instrument ID: {fs.get('instrumentId', 'N/A')}",
        f"Last Validation Date: {fs.get('lastValidationDate', 'N/A')}",
        f"Next Validation Due: {fs.get('nextValidationDate', 'N/A')}",
        "",
    ]
    if rtype == "validation":
        runs = td.get("validationRuns") or report_data.get("validationRuns")
        if runs and isinstance(runs, list) and len(runs) > 0:
            for idx, run in enumerate(runs):
                if idx > 0:
                    lines.append("")
                run = run if isinstance(run, dict) else {}
                usp = run.get("usp") or ("USP 2" if run.get("validationSubtype") == "load" else "USP 1")
                expected = run.get("expectedTapCount", "--")
                tol = run.get("expectedTolerance")
                if tol is not None and expected not in (None, "--"):
                    expected = f"{expected} (+/- {tol})"
                lines.extend(
                    [
                        f"--- {usp} validation ---",
                        f"Date / Time: {_format_ts_readable(run.get('completedAt') or td.get('completedAt') or report_data.get('completedAt') or report_data.get('createdAt'))}",
                        f"USP: {usp}",
                        f"Taps/Min: {run.get('tapsMin', '--')}",
                        f"Drop Height (mm): {run.get('dropHeight', '--')}",
                        f"Expected Tap Count: {expected}",
                        f"Actual Tap Count: {run.get('actualTapCount', '--')}",
                        f"Status: {run.get('status', '--')}",
                    ]
                )
            lines.append(f"Overall Status: {td.get('status', report_data.get('status', '--'))}")
        else:
            lines.extend(
                [
                    f"Date / Time: {_format_ts_readable(td.get('completedAt') or report_data.get('completedAt') or report_data.get('createdAt'))}",
                    f"USP: {td.get('usp', report_data.get('usp', '--'))}",
                    f"Taps/Min: {td.get('tapsMin', report_data.get('tapsMin', '--'))}",
                    f"Drop Height (mm): {td.get('dropHeight', report_data.get('dropHeight', '--'))}",
                    f"Expected Tap Count: {td.get('expectedTapCount', report_data.get('expectedTapCount', '--'))}",
                    f"Actual Tap Count: {td.get('actualTapCount', report_data.get('actualTapCount', '--'))}",
                    f"Status: {td.get('status', report_data.get('status', '--'))}",
                ]
            )
    else:
        recipe = report_data.get("recipe") or td.get("recipe") or td
        if not isinstance(recipe, dict):
            recipe = {}
        status_raw = str(td.get("status", "")).lower() if isinstance(td, dict) else ""
        status_label = "Aborted" if status_raw == "aborted" else "Completed"
        sc = td.get("completedSteps") if isinstance(td, dict) else None
        stc = td.get("stepCount") if isinstance(td, dict) else None
        if sc is not None and stc is not None:
            status_label = f"{status_label} ({sc}/{stc} steps)"
        lines.extend(
            [
                f"Product: {recipe.get('productName', td.get('productName', 'N/A'))}",
                f"Batch: {recipe.get('batchNumber', td.get('batchNumber', 'N/A'))}",
                f"Report/Test Start: {_format_ts_readable(td.get('testStartTime') or report_data.get('createdAt'))}",
                f"Generated: {_format_ts_readable(td.get('testEndTime') or report_data.get('completedAt') or report_data.get('createdAt'))}",
                f"Test Status: {status_label}",
            ]
        )
        _append_test_report_details(lines, td if isinstance(td, dict) else {}, report_data, width, thermal)
    lines.extend(
        [
            "",
            f"Operated by: {report_data.get('operatorName') or td.get('operatorName', '--')}",
            f"Employee ID: {td.get('employeeId', '--')}",
            f"Approval Status: {report_data.get('reportApprovalStatus', '--')}",
            f"Approval Result: {report_data.get('approvalPassFail', '--')}",
            f"Approved By: {report_data.get('approvedBy', '--')}",
            f"Approved At: {_format_ts_readable(report_data.get('approvedAt'))}",
            f"Approval Remarks: {report_data.get('approvalRemarks', '')}",
            sep,
        ]
    )
    return "\n".join(_wrap_lines(lines, width))


def format_for_a4_printer(report_data: Dict[str, Any]) -> str:
    return _format_report_text(report_data, width=70)


def format_for_thermal_printer(report_data: Dict[str, Any]) -> str:
    return _format_report_text(report_data, width=48)


def save_report_text_files(report_data: Dict[str, Any], report_id: int, reports_dir: pathlib.Path) -> None:
    if not report_data or report_id is None:
        return
    try:
        reports_dir = pathlib.Path(reports_dir)
        reports_dir.mkdir(parents=True, exist_ok=True)
        text_48 = _format_report_text(report_data, width=48)
        text_70 = _format_report_text(report_data, width=70).rstrip() + "\r\n\x0c"
        (reports_dir / f"report_{report_id}_a4.txt").write_text(text_70, encoding="utf-8")
        (reports_dir / f"report_{report_id}_thermal.txt").write_text(text_48, encoding="utf-8")
    except Exception as e:
        _log.warning("save_report_text_files failed: %s", e)


def print_report_from_file(txt_path: pathlib.Path, port: str, baud: int, printer_type: str = "a4") -> Dict[str, Any]:
    txt_path = pathlib.Path(txt_path)
    if not txt_path.exists() or not txt_path.is_file():
        return {"success": False, "error": f"Report file not found: {txt_path}", "port": port}
    if not serial:
        return {"success": False, "error": "pyserial not installed", "port": port}
    if printer_type == "thermal":
        try:
            port = _probe_port(port, THERMAL_CANDIDATES)
        except FileNotFoundError as e:
            return {"success": False, "error": f"Printer port not found: {e.filename or port}", "port": port}
    elif not _port_exists(port):
        return {"success": False, "error": f"Printer port not found: {port}", "port": port}
    try:
        data = txt_path.read_bytes()
        if printer_type == "a4":
            ser = _open_a4_serial(port, baud)
            try:
                ser.reset_output_buffer()
                ser.flush()
                _send_printer_init(ser)
                _send_bytes_chunked(ser, data, baud, chunk_size=512)
                time.sleep(0.5)
                return {"success": True, "port": port}
            finally:
                ser.close()
        ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
        try:
            _send_printer_init(ser)
            _send_bytes_chunked(ser, data, baud, chunk_size=64)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}


def print_a4_report(report_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    port = printer_port or _a4_port
    baud = _a4_baud
    if not serial:
        return {"success": False, "error": "pyserial not installed", "port": port}
    if not _port_exists(port):
        return {"success": False, "error": f"A4 printer port not found: {port}", "port": port}
    try:
        text = format_for_a4_printer(report_data).rstrip() + "\r\n\x0c"
        ser = _open_a4_serial(port, baud)
        try:
            ser.reset_output_buffer()
            ser.flush()
            _send_printer_init(ser)
            _send_text_to_a4(ser, text, baud)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}


def print_thermal_report(report_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    port = printer_port or _thermal_port
    baud = _thermal_baud
    if not serial:
        return {"success": False, "error": "pyserial not installed", "port": port}
    try:
        port = _probe_port(port, THERMAL_CANDIDATES)
    except FileNotFoundError as e:
        return {"success": False, "error": f"Thermal printer port not found: {e.filename or port}", "port": port}
    try:
        text = format_for_thermal_printer(report_data).rstrip("\n") + "\n\n"
        ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
        try:
            _send_printer_init(ser)
            _send_text_chunked(ser, text, baud, chunk_size=64)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}


def _format_recipe_text(recipe_data: Dict[str, Any], width: int = 70) -> str:
    thermal = width < 70
    sep = "" if thermal else ("=" * width)
    fs = recipe_data.get("factorySettings") or {}
    lines = [
        sep,
        "TAP DENSITY RECIPE" if thermal else "TAP DENSITY RECIPE".center(width),
        sep,
        f"Company: {fs.get('companyName', 'N/A')}",
        f"Model No: {fs.get('modelNo', 'N/A')}",
        f"Serial No: {fs.get('serialNo', 'N/A')}",
        f"Location: {fs.get('companyLocation', fs.get('location', 'N/A'))}",
        f"Instrument ID: {fs.get('instrumentId', 'N/A')}",
        f"Last Validation Date: {fs.get('lastValidationDate', 'N/A')}",
        f"Next Validation Due: {fs.get('nextValidationDate', 'N/A')}",
        "",
        f"Product: {recipe_data.get('productName', recipe_data.get('name', 'N/A'))}",
        f"Batch: {recipe_data.get('batchNumber', 'N/A')}",
        f"Unit: {recipe_data.get('unit', 'N/A')}",
        sep,
    ]
    return "\n".join(_wrap_lines(lines, width))


def print_recipe_a4(recipe_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    port = printer_port or _a4_port
    baud = _a4_baud
    if not serial:
        return {"success": False, "error": "pyserial not installed", "port": port}
    if not _port_exists(port):
        return {"success": False, "error": f"A4 printer port not found: {port}", "port": port}
    try:
        text = _format_recipe_text(recipe_data, width=70).rstrip() + "\r\n\x0c"
        ser = _open_a4_serial(port, baud)
        try:
            ser.reset_output_buffer()
            ser.flush()
            _send_printer_init(ser)
            _send_text_to_a4(ser, text, baud)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}


def print_recipe_thermal(recipe_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    port = printer_port or _thermal_port
    baud = _thermal_baud
    if not serial:
        return {"success": False, "error": "pyserial not installed", "port": port}
    try:
        port = _probe_port(port, THERMAL_CANDIDATES)
    except FileNotFoundError as e:
        return {"success": False, "error": f"Thermal printer port not found: {e.filename or port}", "port": port}
    try:
        text = _format_recipe_text(recipe_data, width=48).rstrip("\n") + "\n\n"
        ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
        try:
            _send_printer_init(ser)
            _send_text_chunked(ser, text, baud, chunk_size=64)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}

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
THERMAL_WIDTH = 32
THERMAL_LINE_CHUNK = 32
# Blank lines after content so date/time and footer clear the cutter (avoid half-cut).
THERMAL_POST_PRINT_FEED_LINES = 10

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


def _thermal_sep(char: str, width: int = THERMAL_WIDTH) -> str:
    return (char * width)[:width]


def _fit_thermal_line(line: str, width: int = THERMAL_WIDTH) -> list:
    """Split or truncate a single logical line to at most `width` characters per row."""
    s = str(line) if line is not None else ""
    if not s.strip() and s == "":
        return [""]
    if len(s) <= width:
        return [s]
    out = []
    while s:
        out.append(s[:width])
        s = s[width:]
    return out


def _apply_thermal_line_spacing(lines: list, width: int = THERMAL_WIDTH) -> list:
    """Extra blank line after each printed row for readable line spacing."""
    out: list = []
    for line in lines:
        for part in _fit_thermal_line(line, width):
            out.append(part)
            if part.strip():
                out.append("")
    return out


def _send_text_to_thermal(ser, text: str, baud: int) -> None:
    """
    Send thermal text one line at a time (max THERMAL_WIDTH chars per row).
    Avoids buffer overrun that drops the start of long chunked writes.
    """
    line_delay = 0.06 if baud <= 9600 else 0.035
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    for line in text.split("\n"):
        if line == "":
            ser.write(b"\n")
            ser.flush()
            time.sleep(0.02)
            continue
        for chunk in _fit_thermal_line(line, THERMAL_LINE_CHUNK):
            payload = (chunk + "\n").encode("latin-1", errors="replace")
            ser.write(payload)
            ser.flush()
            time.sleep(line_delay)
    for _ in range(THERMAL_POST_PRINT_FEED_LINES):
        ser.write(b"\n")
        ser.flush()
        time.sleep(0.06)
    time.sleep(0.5)


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


def _split_ts_date_and_time(ts: Any) -> tuple:
    """Return (date, time) strings for separate thermal print lines."""
    full = _format_ts_readable(ts)
    if full == "--":
        return "--", "--"
    parts = full.split(" ", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return full, "--"


def _wrap_lines(lines: list, width: int) -> list:
    out = []
    for line in lines:
        if "\t" in line:
            out.append(line)
            continue
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


def _cell_str(val: Any) -> str:
    if val is None or val in ("", "__"):
        return "--"
    return str(val)


def _effective_step_row_count(td: Dict[str, Any]) -> int:
    """Rows to print: actual stepResults only (not recipe stepCount)."""
    if not isinstance(td, dict):
        return 0
    results = td.get("stepResults") or []
    if isinstance(results, list) and results:
        return len(results)
    cs = td.get("completedSteps")
    if cs is not None:
        try:
            return max(0, int(cs))
        except (TypeError, ValueError):
            pass
    return 0


def _section_sep(char: str, width: int, thermal: bool) -> str:
    if thermal:
        return _thermal_sep(char, width)
    return char * min(width, 70)


def _thermal_test_data_row(sn: int, vol: str, dvol: str, bulk: str, tap: str) -> str:
    """Thermal step row: one space after S.No., two spaces before Tap."""
    return f"{sn:>2} {str(vol):>5} {str(dvol):>5} {str(bulk):>5}  {str(tap):>5}"


_THERMAL_TEST_DATA_HEADER = f"{'#':>2} {'Vol':>5} {'dV':>5} {'Blk':>5}  {'Tap':>5}"


def _format_thermal_test_data_table(row_count: int, results: list, width: int = THERMAL_WIDTH) -> list:
    """Compact fixed-width step table for 32-char thermal paper."""
    w = width
    lines = [
        "",
        _section_sep("=", w, True),
        "TEST DATA",
        _section_sep("-", w, True),
        _THERMAL_TEST_DATA_HEADER,
        _section_sep("-", w, True),
    ]
    for i in range(row_count):
        r = results[i] if i < len(results) and isinstance(results[i], dict) else {}
        vol = _cell_str(r.get("volumeMl"))
        dvol = r.get("volumeDeltaMl", "__")
        if dvol not in (None, "", "__"):
            dvol = _fmt_density_val(dvol)
        else:
            dvol = _cell_str(dvol)
        bulk = r.get("bulkDensity", "__")
        if bulk not in (None, "", "__"):
            bulk = _fmt_density_val(bulk)
        else:
            bulk = _cell_str(bulk)
        tap = r.get("tapDensity", "__")
        if tap not in (None, "", "__"):
            tap = _fmt_density_val(tap)
        else:
            tap = _cell_str(tap)
        lines.append(_thermal_test_data_row(i + 1, vol, dvol, bulk, tap))
    lines.extend(["", _section_sep("-", w, True), ""])
    return lines


def _append_test_statistics_block(
    lines: list, stats: dict, width: int, thermal: bool, status_raw: str
) -> None:
    if str(status_raw or "").strip().lower() == "aborted":
        lines.extend(["", _section_sep("=", width, thermal), "STATISTICS", "N/A", _section_sep("*", width, thermal), ""])
        return
    if not isinstance(stats, dict) or not stats:
        return
    dash = _section_sep("-", width, thermal)
    eq = _section_sep("=", width, thermal)
    star = _section_sep("*", width, thermal)
    lines.extend(["", eq, "STATISTICS", dash])
    for key, val in stats.items():
        if not isinstance(val, dict):
            continue
        label = str(key)
        if val.get("value") is not None:
            lines.append(f"{label}:")
            lines.append(f"  final {_fmt_density_val(val.get('value'))}")
            continue
        mean = val.get("mean", val.get("Mean", "--"))
        mn = val.get("min", val.get("Min", "--"))
        mx = val.get("max", val.get("Max", "--"))
        if thermal:
            lines.append(label + ":")
            lines.append(f" mean {_fmt_density_val(mean)}")
            lines.append(f" min  {_fmt_density_val(mn)}")
            lines.append(f" max  {_fmt_density_val(mx)}")
        else:
            lines.append(f"{label}:")
            lines.append(
                f"  {'Mean':<8} {'Min':<8} {'Max':<8}"
            )
            lines.append(
                f"  {str(_fmt_density_val(mean)):<8} {str(_fmt_density_val(mn)):<8} {str(_fmt_density_val(mx)):<8}"
            )
    lines.extend(["", star, ""])


def _normalize_validation_runs(td: Dict[str, Any], report_data: Dict[str, Any]) -> list:
    if not isinstance(td, dict):
        td = {}
    runs = td.get("validationRuns") or report_data.get("validationRuns")
    if runs and isinstance(runs, list) and len(runs) > 0:
        return [r if isinstance(r, dict) else {} for r in runs]
    return [
        {
            "usp": td.get("usp") or report_data.get("usp"),
            "validationSubtype": td.get("validationSubtype") or report_data.get("validationSubtype"),
            "tapsMin": td.get("tapsMin", report_data.get("tapsMin")),
            "dropHeight": td.get("dropHeight", report_data.get("dropHeight")),
            "expectedTapCount": td.get("expectedTapCount", report_data.get("expectedTapCount")),
            "expectedTolerance": td.get("expectedTolerance", report_data.get("expectedTolerance")),
            "actualTapCount": td.get("actualTapCount", report_data.get("actualTapCount")),
            "validationDurationSec": td.get("validationDurationSec", report_data.get("validationDurationSec")),
            "status": td.get("status", report_data.get("status")),
            "completedAt": td.get("completedAt", report_data.get("completedAt")),
        }
    ]


def _validation_usp_label(run: Dict[str, Any]) -> str:
    usp = run.get("usp")
    if usp:
        return str(usp)
    return "USP 2" if run.get("validationSubtype") == "load" else "USP 1"


def _validation_expected_display(run: Dict[str, Any]) -> str:
    expected = run.get("expectedTapCount", "--")
    tol = run.get("expectedTolerance")
    if tol is not None and expected not in (None, "--", ""):
        try:
            return f"{expected} (+/-{tol})"
        except (TypeError, ValueError):
            pass
    return _cell_str(expected)


def _validation_overall_status_label(td: Dict[str, Any], report_data: Dict[str, Any]) -> str:
    overall = td.get("status") or report_data.get("status") or "--"
    s = str(overall).strip()
    low = s.lower()
    if low == "pass":
        return "Pass"
    if low == "fail":
        return "Fail"
    return s or "--"


def _format_thermal_validation_runs_block(runs: list, width: int = THERMAL_WIDTH) -> list:
    w = width
    lines = ["", "VALIDATION RESULTS", _thermal_sep("-", w)]
    for idx, run in enumerate(runs):
        if idx > 0:
            lines.append("")
        lines.append(_validation_usp_label(run))
        lines.append(f"Taps/Min: {_cell_str(run.get('tapsMin'))}")
        lines.append(f"Drop(mm): {_cell_str(run.get('dropHeight'))}")
        lines.append(f"Expected: {_validation_expected_display(run)}")
        lines.append(f"Actual: {_cell_str(run.get('actualTapCount'))}")
        dur = run.get("validationDurationSec")
        if dur is not None:
            try:
                lines.append(f"Duration: {int(dur)} s")
            except (TypeError, ValueError):
                pass
        lines.append(f"Status: {_cell_str(run.get('status'))}")
    lines.extend(["", _thermal_sep("-", w), ""])
    return lines


def _append_validation_report_details(
    lines: list, td: Dict[str, Any], report_data: Dict[str, Any], width: int, thermal: bool
) -> None:
    if not isinstance(td, dict):
        td = {}
    runs = _normalize_validation_runs(td, report_data)
    overall_label = _validation_overall_status_label(td, report_data)
    ts_end = (
        report_data.get("completedAt")
        or td.get("completedAt")
        or (runs[-1].get("completedAt") if runs else None)
        or report_data.get("createdAt")
        or td.get("createdAt")
    )
    remarks = report_data.get("remarks")
    if remarks is None:
        remarks = td.get("remarks")
    dash = "" if thermal else ("-" * min(width, 70))

    if thermal:
        end_date, end_time = _split_ts_date_and_time(ts_end)
        lines.extend(
            [
                "",
                "VALIDATION INFORMATION",
                f"Overall Status: {overall_label}",
                f"Completed Date: {end_date}",
                f"Completed Time: {end_time}",
                "",
            ]
        )
        if runs:
            lines.extend(_format_thermal_validation_runs_block(runs, width))
        else:
            lines.extend(["", "VALIDATION RESULTS", "No validation data", ""])
    else:
        lines.extend(
            [
                "",
                "VALIDATION INFORMATION",
                f"Overall Status: {overall_label}",
                f"Completed: {_format_ts_readable(ts_end)}",
                "",
                "VALIDATION RESULTS",
                dash if dash else "",
            ]
        )
        if not runs:
            lines.append("No validation data")
        for idx, run in enumerate(runs):
            if idx > 0:
                lines.append("")
            lines.append(_validation_usp_label(run))
            lines.append(f"  Taps/Min: {_cell_str(run.get('tapsMin'))}")
            lines.append(f"  Drop (mm): {_cell_str(run.get('dropHeight'))}")
            lines.append(f"  Expected: {_validation_expected_display(run)}")
            lines.append(f"  Actual: {_cell_str(run.get('actualTapCount'))}")
            dur = run.get("validationDurationSec")
            if dur is not None:
                try:
                    lines.append(f"  Duration: {int(dur)} s")
                except (TypeError, ValueError):
                    pass
            lines.append(f"  Status: {_cell_str(run.get('status'))}")
        lines.append("")

    if remarks not in (None, ""):
        lines.extend(["", "REMARKS:", str(remarks), ""])


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
    results = td.get("stepResults") or []
    row_count = _effective_step_row_count(td)

    duration_sec = td.get("durationSeconds")
    if duration_sec is not None:
        try:
            lines.append(f"Test Duration: {int(duration_sec)} s")
        except (TypeError, ValueError):
            pass

    status_raw = str(td.get("status") or report_data.get("status") or "").lower()
    if row_count > 0:
        if thermal:
            lines.extend(_format_thermal_test_data_table(row_count, results))
        else:
            eq = _section_sep("=", width, False)
            lines.extend(["", eq, "TEST DATA", dash if dash else ""])
            hdr = f"{'S':>2}  {'Vol(ml)':>9}  {'dVol':>8}  {'Bulk':>9}  {'Tap':>9}"
            lines.append(hdr)
            if dash:
                lines.append(dash)
            for i in range(row_count):
                r = results[i] if i < len(results) and isinstance(results[i], dict) else {}
                vol = r.get("volumeMl", "__")
                dvol = r.get("volumeDeltaMl", "__")
                if dvol not in (None, "", "__"):
                    dvol = _fmt_density_val(dvol)
                bulk = r.get("bulkDensity", "__")
                if bulk not in (None, "", "__"):
                    bulk = _fmt_density_val(bulk)
                tap = r.get("tapDensity", "__")
                if tap not in (None, "", "__"):
                    tap = _fmt_density_val(tap)
                sn = i + 1
                lines.append(
                    f"{sn:2d}  {str(vol):>9}  {str(dvol):>8}  {str(bulk):>9}  {str(tap):>9}"
                )
            lines.append(dash if dash else "")
    elif str(report_data.get("type") or "test").strip().lower() == "test":
        lines.extend(["", "TEST DATA: No test data recorded"])

    stats = report_data.get("statistics") or td.get("statistics") or {}
    _append_test_statistics_block(lines, stats, width, thermal, status_raw)


def _format_report_text(report_data: Dict[str, Any], width: int = 70) -> str:
    thermal = width < 70
    sep = _thermal_sep("=", width) if thermal else ("=" * width)
    sep_dash = _thermal_sep("-", width) if thermal else ("-" * width)
    td = report_data.get("testData") or report_data
    fs = report_data.get("factorySettings") or {}
    rtype = str(report_data.get("type") or "test").strip().lower()
    title = "TAP DENSITY VALIDATION REPORT" if rtype == "validation" else "TAP DENSITY TEST REPORT"
    lines: list = []
    if thermal:
        lines.extend([sep, "RAISE LAB EQUIPMENT", ""])
    else:
        lines.append(sep)
    lines.append(title if thermal else title.center(width))
    if thermal:
        lines.append("")
    else:
        lines.append(sep)
    lines.extend(
        [
            f"Company: {fs.get('companyName', 'N/A')}",
            f"Model No: {fs.get('modelNo', 'N/A')}",
            f"Serial No: {fs.get('serialNo', 'N/A')}",
            f"Location: {fs.get('companyLocation', fs.get('location', 'N/A'))}",
            f"Instrument ID: {fs.get('instrumentId', 'N/A')}",
            f"Last Val: {fs.get('lastValidationDate', 'N/A')}",
            f"Next Val Due: {fs.get('nextValidationDate', 'N/A')}",
        ]
    )
    if not thermal:
        lines.append("")
    if rtype == "validation":
        _append_validation_report_details(lines, td if isinstance(td, dict) else {}, report_data, width, thermal)
    else:
        recipe = report_data.get("recipe") or td.get("recipe") or td
        if not isinstance(recipe, dict):
            recipe = {}
        status_raw = str(td.get("status", "")).lower() if isinstance(td, dict) else ""
        status_label = "Aborted" if status_raw == "aborted" else "Completed"
        ts_start = td.get("testStartTime") or report_data.get("createdAt")
        ts_end = (
            td.get("testEndTime")
            or report_data.get("completedAt")
            or td.get("completedAt")
            or report_data.get("createdAt")
        )
        if thermal:
            start_date, start_time = _split_ts_date_and_time(ts_start)
            end_date, end_time = _split_ts_date_and_time(ts_end)
            lines.extend(
                [
                    "TEST INFORMATION",
                    f"Product: {recipe.get('productName', td.get('productName', 'N/A'))}",
                    f"Batch: {recipe.get('batchNumber', td.get('batchNumber', 'N/A'))}",
                    f"Test Start Date: {start_date}",
                    f"Test Start Time: {start_time}",
                    f"Completed Date: {end_date}",
                    f"Completed Time: {end_time}",
                    f"Test Status: {status_label}",
                    "",
                ]
            )
        else:
            lines.extend(
                [
                    f"Product: {recipe.get('productName', td.get('productName', 'N/A'))}",
                    f"Batch: {recipe.get('batchNumber', td.get('batchNumber', 'N/A'))}",
                    f"Test Start: {_format_ts_readable(ts_start)}",
                    f"Completed: {_format_ts_readable(ts_end)}",
                    f"Test Status: {status_label}",
                ]
            )
        _append_test_report_details(lines, td if isinstance(td, dict) else {}, report_data, width, thermal)
    if thermal:
        lines.extend(["", "APPROVAL"])
    lines.extend(
        [
            f"Operated by: {report_data.get('operatorName') or td.get('operatorName', '--')}",
            f"Employee ID: {td.get('employeeId', '--')}",
            f"Approval Result: {report_data.get('approvalPassFail', '--')}",
            f"Approved By: {report_data.get('approvedBy', '--')}",
            f"Approved At: {_format_ts_readable(report_data.get('approvedAt'))}",
            f"Approval Remarks: {report_data.get('approvalRemarks', '')}",
        ]
    )
    if thermal:
        lines.extend([sep, ""])
        flat: list = []
        for line in lines:
            flat.extend(_fit_thermal_line(line, width))
        lines = _apply_thermal_line_spacing(flat, width)
        return "\n".join(lines)
    return "\n".join(_wrap_lines(lines, width))


def format_for_a4_printer(report_data: Dict[str, Any]) -> str:
    return _format_report_text(report_data, width=70)


def _thermal_printed_timestamp_lines() -> list:
    """Printed date/time from device RTC at format time."""
    try:
        import rtc_service

        payload = rtc_service.get_device_wall_datetime_payload()
        pdate = payload.get("date") or "--"
        ptime = payload.get("time") or "--"
    except Exception:
        now = datetime.now()
        pdate = now.strftime("%d-%m-%Y")
        ptime = now.strftime("%H:%M:%S")
    return ["", f"Printed Date: {pdate}", f"Printed Time: {ptime}"]


def _thermal_trailing_feed() -> str:
    return "\n" * THERMAL_POST_PRINT_FEED_LINES


def format_for_thermal_printer(report_data: Dict[str, Any]) -> str:
    text = _format_report_text(report_data, width=THERMAL_WIDTH).rstrip("\n")
    footer = "\n".join(_thermal_printed_timestamp_lines())
    return text + "\n\n" + footer + _thermal_trailing_feed()


def save_report_text_files(report_data: Dict[str, Any], report_id: int, reports_dir: pathlib.Path) -> None:
    if not report_data or report_id is None:
        return
    try:
        reports_dir = pathlib.Path(reports_dir)
        reports_dir.mkdir(parents=True, exist_ok=True)
        text_48 = format_for_thermal_printer(report_data)
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
            time.sleep(0.2)
            _send_text_to_thermal(ser, data.decode("utf-8", errors="replace"), baud)
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
        text = format_for_thermal_printer(report_data)
        ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
        try:
            _send_printer_init(ser)
            time.sleep(0.2)
            _send_text_to_thermal(ser, text, baud)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}


def _format_recipe_text(recipe_data: Dict[str, Any], width: int = 70) -> str:
    thermal = width < 70
    sep = _thermal_sep("=", width) if thermal else ("=" * width)
    sep_dash = _thermal_sep("-", width) if thermal else ("-" * width)
    fs = recipe_data.get("factorySettings") or {}
    lines = [
        sep,
        "TAP DENSITY RECIPE" if thermal else "TAP DENSITY RECIPE".center(width),
        sep_dash if thermal else sep,
        f"Company: {fs.get('companyName', 'N/A')}",
        f"Model No: {fs.get('modelNo', 'N/A')}",
        f"Serial No: {fs.get('serialNo', 'N/A')}",
        f"Location: {fs.get('companyLocation', fs.get('location', 'N/A'))}",
        f"Instrument ID: {fs.get('instrumentId', 'N/A')}",
        f"Last Val: {fs.get('lastValidationDate', 'N/A')}",
        f"Next Val Due: {fs.get('nextValidationDate', 'N/A')}",
        sep_dash if thermal else "",
        f"Product: {recipe_data.get('productName', recipe_data.get('name', 'N/A'))}",
        f"Batch: {recipe_data.get('batchNumber', 'N/A')}",
        f"Unit: {recipe_data.get('unit', 'N/A')}",
        sep,
    ]
    if thermal:
        flat: list = []
        for line in lines:
            flat.extend(_fit_thermal_line(line, width))
        return "\n".join(_apply_thermal_line_spacing(flat, width))
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
        text = _format_recipe_text(recipe_data, width=THERMAL_WIDTH).rstrip("\n") + _thermal_trailing_feed()
        ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
        try:
            _send_printer_init(ser)
            time.sleep(0.2)
            _send_text_to_thermal(ser, text, baud)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}

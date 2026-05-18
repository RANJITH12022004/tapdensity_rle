#!/usr/bin/env python3
"""
report_service.py - Tap Density report generation and context.
"""

import html as html_module
import json
import pathlib
from datetime import datetime
from typing import Dict, Any, Optional, List

import data_service

_config = {}
_reports_dir = None
_storage_dir = None


def init(config):
    global _config, _reports_dir, _storage_dir
    _config = dict(config)
    _reports_dir = pathlib.Path(_config.get("REPORTS_DIR", "./reports"))
    _storage_dir = pathlib.Path(_config.get("STORAGE_DIR", "./storage"))
    _reports_dir.mkdir(parents=True, exist_ok=True)


def generate_report(
    test_data: Dict[str, Any],
    recipe: Optional[Dict[str, Any]] = None,
    factory_settings: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    report = dict(test_data)
    if recipe:
        report["recipe"] = {
            "id": recipe.get("id"),
            "name": recipe.get("name") or recipe.get("productName"),
            "productName": recipe.get("productName"),
            "batchNumber": recipe.get("batchNumber"),
            "unit": recipe.get("unit"),
        }
    if not factory_settings:
        factory_settings = data_service.get_factory_settings()
    report["factorySettings"] = enrich_factory_settings(factory_settings or {})
    if not report.get("createdAt"):
        report["createdAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    if not report.get("completedAt"):
        report["completedAt"] = report["createdAt"]
    report = enrich_report_context(report)
    return report


def enrich_factory_settings(factory_settings: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "companyName": factory_settings.get("companyName") or "N/A",
        "modelNo": factory_settings.get("modelNo") or "N/A",
        "serialNo": factory_settings.get("serialNo") or "N/A",
        "companyLocation": factory_settings.get("companyLocation") or factory_settings.get("location") or "N/A",
        "instrumentId": factory_settings.get("instrumentId") or "N/A",
        "lastValidationDate": factory_settings.get("lastValidationDate") or "N/A",
        "nextValidationDate": factory_settings.get("nextValidationDate") or "N/A",
    }


def _parse_density_number(val: Any) -> Optional[float]:
    if val is None or val == "" or val == "--":
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _stat_display_value(val: Dict[str, Any]) -> Any:
    if val.get("value") is not None:
        return val.get("value")
    if val.get("mean") is not None:
        return val.get("mean")
    if val.get("Mean") is not None:
        return val.get("Mean")
    return None


def _recipe_total_tap_count(recipe: Dict[str, Any]) -> Optional[int]:
    if not isinstance(recipe, dict):
        return None
    ct = recipe.get("customTotalTaps")
    if ct is not None and ct != "":
        try:
            n = int(ct)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    steps = recipe.get("steps")
    if not isinstance(steps, list) or not steps:
        return None
    total = 0
    for step in steps:
        if not isinstance(step, dict):
            continue
        try:
            total += int(step.get("tapCount") or 0)
        except (TypeError, ValueError):
            pass
    return total if total > 0 else None


def _agg_mean_min_max(values: List[float]) -> Dict[str, float]:
    if not values:
        return {}
    return {
        "mean": round(sum(values) / len(values), 3),
        "min": round(min(values), 3),
        "max": round(max(values), 3),
    }


def compute_test_report_statistics(test_data: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Option A: Hausner = tap/bulk; CI% = (tap-bulk)/tap*100; agg over completed steps; final-step CI/Hausner."""
    if not isinstance(test_data, dict):
        return None
    if str(test_data.get("status") or "").strip().lower() == "aborted":
        return None
    results = test_data.get("stepResults") or []
    if not isinstance(results, list) or not results:
        return None

    bulk_vals: List[float] = []
    tap_vals: List[float] = []
    for row in results:
        if not isinstance(row, dict):
            continue
        b = _parse_density_number(row.get("bulkDensity"))
        t = _parse_density_number(row.get("tapDensity"))
        if b is not None:
            bulk_vals.append(b)
        if t is not None:
            tap_vals.append(t)

    stats: Dict[str, Any] = {}
    bulk_agg = _agg_mean_min_max(bulk_vals)
    tap_agg = _agg_mean_min_max(tap_vals)
    if bulk_agg:
        stats["Bulk density (g/mL)"] = bulk_agg
    if tap_agg:
        stats["Tap density (g/mL)"] = tap_agg

    last = results[-1] if isinstance(results[-1], dict) else {}
    bulk_f = _parse_density_number(last.get("bulkDensity"))
    tap_f = _parse_density_number(last.get("tapDensity"))
    if bulk_f is None and bulk_vals:
        bulk_f = bulk_vals[0]
    if tap_f is None and tap_vals:
        tap_f = tap_vals[-1]
    if bulk_f is not None and tap_f is not None and tap_f > 0 and bulk_f > 0:
        stats["Compressibility index (%)"] = {
            "value": round(((tap_f - bulk_f) / tap_f) * 100.0, 2)
        }
        stats["Hausner ratio"] = {"value": round(tap_f / bulk_f, 3)}

    return stats if stats else None


def enrich_report_context(report_data: Dict[str, Any]) -> Dict[str, Any]:
    if not report_data:
        return report_data
    factory_settings = data_service.get_factory_settings()
    fs = report_data.get("factorySettings") or {}
    for k, default in [
        ("companyName", "N/A"),
        ("modelNo", "N/A"),
        ("serialNo", "N/A"),
        ("companyLocation", "N/A"),
        ("instrumentId", "N/A"),
    ]:
        if not fs.get(k):
            fs[k] = factory_settings.get(k) or default
    if factory_settings.get("lastValidationDate"):
        fs["lastValidationDate"] = factory_settings["lastValidationDate"]
    if factory_settings.get("nextValidationDate"):
        fs["nextValidationDate"] = factory_settings["nextValidationDate"]
    computed = _compute_validation_dates_from_reports()
    if computed.get("lastValidationDate"):
        fs["lastValidationDate"] = computed["lastValidationDate"]
    if computed.get("nextValidationDate"):
        fs["nextValidationDate"] = computed["nextValidationDate"]
    report_data["factorySettings"] = fs
    if str(report_data.get("type") or "").strip().lower() == "test":
        td = report_data.get("testData") if isinstance(report_data.get("testData"), dict) else report_data
        computed = compute_test_report_statistics(td if isinstance(td, dict) else None)
        if computed:
            report_data["statistics"] = computed
            if isinstance(report_data.get("testData"), dict):
                report_data["testData"]["statistics"] = computed
    return report_data


def _parse_report_datetime(value: Any) -> Optional[datetime]:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _add_months(dt: datetime, months: int) -> datetime:
    month_index = (dt.month - 1) + int(months or 0)
    year = dt.year + (month_index // 12)
    month = (month_index % 12) + 1
    day = dt.day
    if month == 2:
        leap = (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)
        max_day = 29 if leap else 28
    elif month in (4, 6, 9, 11):
        max_day = 30
    else:
        max_day = 31
    if day > max_day:
        day = max_day
    return dt.replace(year=year, month=month, day=day)


def _compute_validation_dates_from_reports() -> Dict[str, str]:
    reports = data_service.list_reports("validation")
    latest_dt = None
    for report in reports or []:
        if str(report.get("type") or "").strip().lower() != "validation":
            continue
        td = report.get("testData") or {}
        status_raw = str(td.get("status") or report.get("status") or "").strip().lower()
        if status_raw == "aborted":
            continue
        dt = _parse_report_datetime(
            td.get("completedAt")
            or report.get("completedAt")
            or td.get("createdAt")
            or report.get("createdAt")
        )
        if not dt:
            continue
        if latest_dt is None or dt > latest_dt:
            latest_dt = dt
    if latest_dt is None:
        return {}
    next_dt = _add_months(latest_dt, 3)
    return {
        "lastValidationDate": latest_dt.strftime("%d-%m-%Y"),
        "nextValidationDate": next_dt.strftime("%d-%m-%Y"),
    }


def get_report_preview_data(report: Dict[str, Any]) -> Dict[str, Any]:
    report = enrich_report_context(dict(report or {}))
    td = report.get("testData") or report
    remarks = report.get("remarks")
    if remarks is None and isinstance(td, dict):
        remarks = td.get("remarks")
    preview = {
        "id": report.get("id"),
        "type": report.get("type", "test"),
        "createdAt": report.get("createdAt"),
        "completedAt": report.get("completedAt"),
        "recipe": report.get("recipe", {}),
        "factorySettings": report.get("factorySettings", {}),
        "testData": report.get("testData", report),
        "statistics": report.get("statistics")
        or (td.get("statistics") if isinstance(td, dict) else {})
        or compute_test_report_statistics(td if isinstance(td, dict) else None)
        or {},
        "status": report.get("status", "PASS"),
        "remarks": remarks,
        "approvedBy": report.get("approvedBy"),
        "approvedAt": report.get("approvedAt"),
        "reportApprovalStatus": report.get("reportApprovalStatus"),
        "approvalPassFail": report.get("approvalPassFail"),
        "approvalRemarks": report.get("approvalRemarks"),
        "operatedByUsername": report.get("operatedByUsername")
        or (td.get("operatedByUsername") if isinstance(td, dict) else None)
        or (td.get("employeeId") if isinstance(td, dict) else None),
        "operatorName": report.get("operatorName")
        or (td.get("operatorName") if isinstance(td, dict) else None),
        "employeeId": report.get("employeeId")
        or (td.get("employeeId") if isinstance(td, dict) else None),
    }
    if report.get("type") == "validation":
        preview["validationSubtype"] = report.get("validationSubtype")
        preview["usp"] = report.get("usp")
        preview["tapsMin"] = report.get("tapsMin")
        preview["dropHeight"] = report.get("dropHeight")
        preview["expectedTapCount"] = report.get("expectedTapCount")
        preview["actualTapCount"] = report.get("actualTapCount")
        runs = report.get("validationRuns")
        if not runs and isinstance(td, dict):
            runs = td.get("validationRuns")
        if runs:
            preview["validationRuns"] = runs
    return preview


def _html_esc(value: Any) -> str:
    if value is None or value == "":
        return "N/A"
    return html_module.escape(str(value))


def _format_report_ts(value: Any) -> str:
    s = str(value or "").strip()
    if not s:
        return "--"
    try:
        clean = s.replace("Z", "").strip()
        if "+" in clean:
            clean = clean.split("+", 1)[0].strip()
        if clean.count("-") > 2:
            clean = clean.rsplit("-", 1)[0].strip()
        dt = datetime.fromisoformat(clean)
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return s


def _report_step_row_count(td: Dict[str, Any]) -> int:
    if not isinstance(td, dict):
        return 0
    results = td.get("stepResults") or []
    if isinstance(results, list) and results:
        return len(results)
    try:
        cs = int(td.get("completedSteps") or 0)
        return max(0, cs)
    except (TypeError, ValueError):
        return 0


def _statistics_table_html(preview: Dict[str, Any], td: Dict[str, Any]) -> str:
    if str(td.get("status") or "").strip().lower() == "aborted":
        return '<tr><td colspan="2">N/A</td></tr>'
    stats = preview.get("statistics") or td.get("statistics") or {}
    if not isinstance(stats, dict) or not stats:
        return '<tr><td colspan="2">N/A</td></tr>'
    rows = []
    for key, val in stats.items():
        if not isinstance(val, dict):
            continue
        display = _stat_display_value(val)
        if display is None:
            continue
        rows.append(
            "<tr><th>{}</th><td>{}</td></tr>".format(
                _html_esc(key), _html_esc(display)
            )
        )
    return "".join(rows) if rows else '<tr><td colspan="2">N/A</td></tr>'


def _validation_details_table_html(preview: Dict[str, Any]) -> str:
    td = preview.get("testData") if isinstance(preview.get("testData"), dict) else preview
    runs = preview.get("validationRuns")
    if not runs and isinstance(td, dict):
        runs = td.get("validationRuns")
    rows = []
    if isinstance(runs, list) and runs:
        for run in runs:
            if not isinstance(run, dict):
                continue
            usp = run.get("usp") or ("USP 2" if run.get("validationSubtype") == "load" else "USP 1")
            date_str = _format_report_ts(run.get("completedAt") or preview.get("completedAt") or preview.get("createdAt"))
            taps_min = run.get("tapsMin", "--")
            drop_h = run.get("dropHeight", "--")
            expected = run.get("expectedTapCount", "--")
            tol = run.get("expectedTolerance")
            expected_disp = (
                "{} (+/- {})".format(expected, tol)
                if tol is not None and expected not in (None, "", "--")
                else expected
            )
            actual = run.get("actualTapCount", "--")
            status = run.get("status", "--")
            rows.append('<tr><th colspan="4" class="usp-hdr">{} validation</th></tr>'.format(_html_esc(usp)))
            rows.append('<tr><th>Date / Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(date_str)))
            rows.append(
                "<tr><th>USP</th><td>{}</td><th>Taps/Min</th><td>{}</td></tr>".format(
                    _html_esc(usp), _html_esc(taps_min)
                )
            )
            rows.append(
                "<tr><th>Drop Height (mm)</th><td>{}</td><th>Status</th><td>{}</td></tr>".format(
                    _html_esc(drop_h), _html_esc(status)
                )
            )
            rows.append(
                "<tr><th>Expected Tap Count</th><td>{}</td><th>Actual Tap Count</th><td>{}</td></tr>".format(
                    _html_esc(expected_disp), _html_esc(actual)
                )
            )
    elif isinstance(td, dict):
        date_str = _format_report_ts(td.get("completedAt") or preview.get("completedAt") or preview.get("createdAt"))
        usp = td.get("usp") or preview.get("usp") or "--"
        taps_min = td.get("tapsMin", preview.get("tapsMin", "--"))
        drop_h = td.get("dropHeight", preview.get("dropHeight", "--"))
        expected = td.get("expectedTapCount", preview.get("expectedTapCount", "--"))
        tol = td.get("expectedTolerance", preview.get("expectedTolerance"))
        expected_disp = (
            "{} (+/- {})".format(expected, tol)
            if tol is not None and expected not in (None, "", "--")
            else expected
        )
        actual = td.get("actualTapCount", preview.get("actualTapCount", "--"))
        status = td.get("status") or preview.get("status") or "--"
        rows.append('<tr><th>Date / Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(date_str)))
        rows.append(
            "<tr><th>USP</th><td>{}</td><th>Taps/Min</th><td>{}</td></tr>".format(
                _html_esc(usp), _html_esc(taps_min)
            )
        )
        rows.append(
            "<tr><th>Drop Height (mm)</th><td>{}</td><th>Status</th><td>{}</td></tr>".format(
                _html_esc(drop_h), _html_esc(status)
            )
        )
        rows.append(
            "<tr><th>Expected Tap Count</th><td>{}</td><th>Actual Tap Count</th><td>{}</td></tr>".format(
                _html_esc(expected_disp), _html_esc(actual)
            )
        )
    return "".join(rows) if rows else '<tr><td colspan="4">No validation data</td></tr>'


def build_report_pdf_html(report: Dict[str, Any]) -> str:
    """Build a self-contained HTML document for PDF rendering (server-side)."""
    preview = get_report_preview_data(report)
    rtype = str(preview.get("type") or "test").strip().lower()
    td = preview.get("testData") if isinstance(preview.get("testData"), dict) else {}
    recipe = preview.get("recipe") if isinstance(preview.get("recipe"), dict) else {}
    fs = preview.get("factorySettings") if isinstance(preview.get("factorySettings"), dict) else {}
    approval_st = str(preview.get("reportApprovalStatus") or "").strip().lower()
    is_aborted = (
        approval_st == "aborted"
        or str(td.get("status") or "").strip().lower() == "aborted"
    )
    is_approved = approval_st == "approved"

    status_raw = str(td.get("status") or "").strip().lower()
    status_label = "Aborted" if status_raw == "aborted" else "Completed"
    start_ts = _format_report_ts(td.get("testStartTime") or preview.get("createdAt"))
    end_ts = _format_report_ts(td.get("testEndTime") or preview.get("completedAt") or preview.get("createdAt"))
    duration = td.get("durationSeconds")
    duration_str = "{} s".format(duration) if duration is not None and duration >= 0 else "--"

    remarks = preview.get("remarks") or td.get("remarks") or "N/A"
    if is_approved:
        appr_result = preview.get("approvalPassFail") or "--"
        appr_by = preview.get("approvedBy") or "--"
        appr_remarks = preview.get("approvalRemarks")
        appr_remarks_disp = appr_remarks if appr_remarks not in (None, "") else "N/A"
    else:
        appr_result = "N/A"
        appr_by = "N/A"
        appr_remarks_disp = "N/A"

    if rtype == "validation":
        val_section = (
            '<h3>VALIDATION DETAILS</h3>'
            '<table class="ident"><tbody>{}</tbody></table>'
        ).format(_validation_details_table_html(preview))
        test_section = ""
    else:
        val_section = ""
        row_count = _report_step_row_count(td)
        results = td.get("stepResults") or []
        step_rows = []
        if row_count > 0:
            for i in range(row_count):
                row = results[i] if i < len(results) and isinstance(results[i], dict) else {}
                vol = row.get("volumeMl", "__")
                d_vol = row.get("volumeDeltaMl", "__")
                bulk = row.get("bulkDensity", "__")
                tap = row.get("tapDensity", "__")
                step_rows.append(
                    "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>".format(
                        i + 1,
                        _html_esc(vol),
                        _html_esc(d_vol),
                        _html_esc(bulk),
                        _html_esc(tap),
                    )
                )
        else:
            step_rows.append('<tr><td colspan="5">No test data</td></tr>')
        test_data_rows = "".join(step_rows)
        total_taps = _recipe_total_tap_count(recipe)
        total_taps_str = str(total_taps) if total_taps is not None else "N/A"
        test_section = (
            '<h3>TEST INFORMATION</h3>'
            '<table class="ident">'
            '<tr><th>Product Name</th><td>{prod}</td><th>Batch No</th><td>{batch}</td></tr>'
            '<tr><th>Total Taps</th><td>{total_taps}</td><th>Test Start</th><td>{start}</td></tr>'
            '<tr><th>Completed Date / Time</th><td colspan="3">{end}</td></tr>'
            '<tr><th>Duration</th><td>{dur}</td><th>Test Status</th><td>{status}</td></tr>'
            '</table>'
            '<h3>TEST DATA</h3>'
            '<table class="data">'
            '<thead><tr><th>Step</th><th>Vol (ml)</th><th>Δ Vol</th><th>Bulk</th><th>Tap</th></tr></thead>'
            '<tbody>{steps}</tbody></table>'
            '<h3>STATISTICS</h3>'
            '<table class="data">'
            '<thead><tr><th>Parameter</th><th>Value</th></tr></thead>'
            '<tbody>{stats}</tbody></table>'
            '<div class="remarks"><strong>Remarks:</strong> {remarks}</div>'
        ).format(
            prod=_html_esc(recipe.get("productName") or td.get("productName")),
            batch=_html_esc(recipe.get("batchNumber") or td.get("batchNumber")),
            total_taps=_html_esc(total_taps_str),
            start=_html_esc(start_ts),
            end=_html_esc(end_ts),
            dur=_html_esc(duration_str),
            status=_html_esc(status_label),
            steps=test_data_rows,
            stats=_statistics_table_html(preview, td),
            remarks=_html_esc(remarks),
        )

    title = "TAP DENSITY VALIDATION REPORT" if rtype == "validation" else "TAP DENSITY TEST REPORT"
    if is_aborted:
        title_note = " (ABORTED)"
    elif is_approved:
        title_note = ""
    else:
        title_note = ""

    body = (
        '<div class="doc">'
        '<h1>{title}{note}</h1>'
        '<h2>{company}</h2>'
        '<table class="ident">'
        '<tr><th>Model No</th><td>{model}</td><th>Serial No</th><td>{serial}</td></tr>'
        '<tr><th>Location</th><td>{loc}</td><th>Instrument ID</th><td>{inst}</td></tr>'
        '<tr><th>Last Validation</th><td>{lastv}</td><th>Next Validation</th><td>{nextv}</td></tr>'
        '</table>'
        '{val}'
        '{test}'
        '<h3>APPROVAL</h3>'
        '<table class="ident">'
        '<tr><th>Operated by</th><td>{op}</td><th>Employee ID</th><td>{emp}</td></tr>'
        '<tr><th>Approval Result</th><td>{appr}</td><th>Approved By</th><td>{by}</td></tr>'
        '<tr><th>Approval Remarks</th><td colspan="3">{appr_rem}</td></tr>'
        '</table>'
        '</div>'
    ).format(
        title=_html_esc(title),
        note=title_note,
        company=_html_esc(fs.get("companyName")),
        model=_html_esc(fs.get("modelNo")),
        serial=_html_esc(fs.get("serialNo")),
        loc=_html_esc(fs.get("companyLocation") or fs.get("location")),
        inst=_html_esc(fs.get("instrumentId")),
        lastv=_html_esc(fs.get("lastValidationDate")),
        nextv=_html_esc(fs.get("nextValidationDate")),
        val=val_section,
        test=test_section,
        op=_html_esc(preview.get("operatorName") or td.get("operatorName")),
        emp=_html_esc(preview.get("employeeId") or td.get("employeeId")),
        appr=_html_esc(appr_result),
        by=_html_esc(appr_by),
        appr_rem=_html_esc(appr_remarks_disp),
    )

    css = (
        "body{font-family:Arial,sans-serif;font-size:11pt;color:#000;margin:12px;}"
        "h1{font-size:14pt;text-align:center;margin:0 0 8px;}"
        "h2{font-size:12pt;text-align:center;margin:0 0 12px;}"
        "h3{font-size:11pt;margin:14px 0 6px;border-bottom:1px solid #333;}"
        "table{width:100%;border-collapse:collapse;margin-bottom:10px;}"
        "th,td{border:1px solid #333;padding:4px 6px;text-align:left;vertical-align:top;}"
        "th{background:#e8e8e8;}"
        ".usp-hdr{background:#e8e8e8;font-weight:bold;}"
        ".remarks{margin:12px 0;padding:8px;border:1px solid #333;}"
    )
    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Report</title>'
        '<style>{}</style></head><body>{}</body></html>'
    ).format(css, body)


def create_pdf_report(report_data: Dict[str, Any], template_type: str = "standard") -> Optional[pathlib.Path]:
    try:
        timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        recipe_name = report_data.get("recipe", {}).get("productName", "report")
        safe_name = "".join(c for c in recipe_name if c.isalnum() or c in "-_")
        filename = f"{safe_name}_{timestamp}.json"
        pdf_path = _reports_dir / filename
        with open(pdf_path, "w", encoding="utf-8") as f:
            json.dump(report_data, f, indent=2, ensure_ascii=False)
        return pdf_path
    except Exception:
        return None


def export_reports_to_usb(report_ids: List[int], export_path: str) -> Dict[str, Any]:
    try:
        export_dir = pathlib.Path(export_path)
        export_dir.mkdir(parents=True, exist_ok=True)
        exported_files = []
        for report_id in report_ids:
            report = data_service.get_report(report_id)
            if not report:
                continue
            timestamp = report.get("createdAt", datetime.now().strftime("%Y-%m-%dT%H:%M:%S"))
            safe_ts = "".join(c for c in str(timestamp) if c.isalnum() or c in "-_.T")
            recipe_name = report.get("recipe", {}).get("productName", "report")
            safe_name = "".join(c for c in recipe_name if c.isalnum() or c in "-_")
            filename = f"{safe_name}_{report_id}_{safe_ts}.json"
            export_file = export_dir / filename
            with open(export_file, "w", encoding="utf-8") as f:
                json.dump(report, f, indent=2, ensure_ascii=False)
            exported_files.append(str(export_file))
        return {"success": True, "exported_files": exported_files, "count": len(exported_files)}
    except Exception as e:
        return {"success": False, "error": str(e)}

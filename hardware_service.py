#!/usr/bin/env python3
"""
hardware_service.py - Serial communication to MCU for Tap Density.
ESP protocol (density_1.ino): usp,chk*, spd1/spd2,<N>*, usp1/usp2,start*, stop*, status*.
"""

import errno
import json
import os
import queue
import threading
import time
from flask import Response

try:
    import serial
except ImportError:
    serial = None

_logger = None
_config = {}
_esp_port = None
ser_lock = threading.Lock()
esp_ser = None
line_q = queue.Queue(maxsize=2000)
sse_clients = []
esp_read_buffer = ""
COMMAND_TIMEOUT = 2.0
TEST_COMMAND_TIMEOUT = 30.0
MAX_RETRIES = 3
_uart_log_lock = threading.Lock()
_uart_log_path = ""


def normalize_line(line: str) -> str:
    s = str(line or "").strip()
    if s.endswith("*"):
        s = s[:-1].strip()
    return s


def classify_line(line: str) -> str:
    s = normalize_line(line).lower()
    if not s:
        return "empty"
    if s == "ok":
        return "ok"
    if s in ("completed", "complete."):
        return "completed"
    if s == "stopped":
        return "stopped"
    if s == "adapt,error":
        return "adapter_error"
    if s == "error" or s.startswith("error:"):
        return "error"
    if s.isdigit():
        return "progress"
    return "info"


def init(app, config):
    global _logger, _config, _esp_port, line_q, sse_clients, _uart_log_path
    _logger = app.logger
    _config = dict(config)
    _esp_port = _config.get("ESP_PORT", "/dev/serial0")
    _uart_log_path = _config.get("UART_LOG_PATH", "/opt/kiosk/uart_communications.log")
    reset_uart_log(reason="service_start")
    line_q = queue.Queue(maxsize=2000)
    sse_clients = []
    try:
        _open_esp_serial()
        if _logger:
            _logger.info("[HARDWARE] MCU serial initialized")
    except Exception as e:
        if _logger:
            _logger.error("[HARDWARE] Failed to open serial at startup: %s", e)
    threading.Thread(target=_reader_loop, daemon=True).start()


def _open_esp_serial():
    global esp_ser, _esp_port
    port = _config.get("ESP_PORT", "/dev/serial0")
    baud = int(_config.get("ESP_BAUD", 9600))
    if not serial:
        raise FileNotFoundError(errno.ENOENT, "pyserial not installed", port)
    with ser_lock:
        if esp_ser and getattr(esp_ser, "is_open", False):
            return esp_ser
        # On Windows, COM ports are not filesystem paths, so os.path.exists("COM3") is False.
        is_windows_com_port = (
            os.name == "nt"
            and isinstance(port, str)
            and port.strip() != ""
            and port.strip().upper().startswith("COM")
        )
        if (not port) or (not is_windows_com_port and not os.path.exists(port)):
            for c in ["/dev/serial0", "/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyAMA0"]:
                if os.path.exists(c):
                    port = c
                    _esp_port = c
                    break
            else:
                raise FileNotFoundError(errno.ENOENT, "Serial device not found", port)
        if esp_ser:
            try:
                esp_ser.close()
            except Exception:
                pass
        esp_ser = serial.Serial(
            port=port,
            baudrate=baud,
            timeout=2.0,
            write_timeout=2.0,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
        )
        esp_ser.reset_input_buffer()
        esp_ser.reset_output_buffer()
        _esp_port = port
        return esp_ser


def send_command(cmd: str, timeout=COMMAND_TIMEOUT, max_retries=MAX_RETRIES, ignore_numeric_response=False):
    """Send command to MCU and return normalized response metadata."""
    global esp_ser
    if not cmd:
        return {"ok": False, "error": "Empty command"}
    cmd = cmd.strip()
    if not cmd.endswith("*"):
        cmd = cmd + "*"
    _append_uart_log("TX", cmd)
    if not serial:
        return {"ok": False, "error": "pyserial not installed", "cmd": cmd}
    for attempt in range(max_retries):
        if not esp_ser or not getattr(esp_ser, "is_open", False):
            try:
                _open_esp_serial()
            except Exception as e:
                if attempt == max_retries - 1:
                    return {"ok": False, "error": str(e), "cmd": cmd}
                time.sleep(0.2)
                continue
        try:
            # Drop stale queued lines from previous activity before issuing a new command.
            drain_queue(max_lines=200)
            with ser_lock:
                if esp_ser and esp_ser.is_open:
                    esp_ser.reset_input_buffer()
                    esp_ser.write((cmd + "\n").encode("ascii", errors="replace"))
                    esp_ser.flush()
            deadline = time.time() + (timeout or COMMAND_TIMEOUT)
            while time.time() < deadline:
                try:
                    line = line_q.get(timeout=0.1)
                    if line and line.strip():
                        raw = line.strip()
                        if ignore_numeric_response and normalize_line(raw).isdigit():
                            continue
                        _append_uart_log("RX", raw)
                        norm = normalize_line(raw)
                        return {"ok": True, "response": raw, "normalized": norm, "kind": classify_line(raw), "cmd": cmd}
                except queue.Empty:
                    pass
                with ser_lock:
                    if esp_ser and esp_ser.is_open and esp_ser.in_waiting > 0:
                        raw = esp_ser.readline()
                        if raw:
                            line = raw.decode("ascii", errors="ignore").strip()
                            if line:
                                if ignore_numeric_response and normalize_line(line).isdigit():
                                    continue
                                _append_uart_log("RX", line)
                                norm = normalize_line(line)
                                return {"ok": True, "response": line, "normalized": norm, "kind": classify_line(line), "cmd": cmd}
                time.sleep(0.05)
            if timeout is not None:
                return {"ok": False, "error": "Timeout", "cmd": cmd}
        except Exception as e:
            if attempt == max_retries - 1:
                return {"ok": False, "error": str(e), "cmd": cmd}
            try:
                with ser_lock:
                    if esp_ser:
                        esp_ser.close()
                        esp_ser = None
                _open_esp_serial()
            except Exception:
                pass
            time.sleep(0.2)
    return {"ok": False, "error": "Max retries exceeded", "cmd": cmd}


def _reader_loop():
    global esp_read_buffer, esp_ser
    while True:
        try:
            if not esp_ser or not getattr(esp_ser, "is_open", False):
                try:
                    _open_esp_serial()
                except Exception:
                    time.sleep(2.0)
                    continue
            with ser_lock:
                if esp_ser and esp_ser.in_waiting > 0:
                    chunk = esp_ser.read(min(esp_ser.in_waiting, 1024))
                else:
                    time.sleep(0.05)
                    continue
            if chunk:
                try:
                    esp_read_buffer += chunk.decode("ascii", errors="ignore")
                except Exception:
                    continue
                while "\n" in esp_read_buffer:
                    line, esp_read_buffer = esp_read_buffer.split("\n", 1)
                    line = line.strip()
                    if line:
                        _append_uart_log("RX_STREAM", line)
                        try:
                            line_q.put_nowait(line)
                        except queue.Full:
                            pass
                        for q in list(sse_clients):
                            try:
                                q.put_nowait(line)
                            except Exception:
                                if q in sse_clients:
                                    sse_clients.remove(q)
                if len(esp_read_buffer) > 4096:
                    esp_read_buffer = esp_read_buffer[-2048:]
        except Exception as e:
            if _logger:
                _logger.debug("[HARDWARE] reader: %s", e)
            time.sleep(1.0)


def start_sse_stream():
    """SSE stream for real-time MCU data."""
    def gen():
        q = queue.Queue(maxsize=100)
        sse_clients.append(q)
        try:
            while True:
                try:
                    line = q.get(timeout=30.0)
                    yield f"data: {json.dumps({'line': line, 'normalized': normalize_line(line), 'kind': classify_line(line)})}\n\n"
                except queue.Empty:
                    yield "data: {\"ping\": true}\n\n"
        finally:
            if q in sse_clients:
                sse_clients.remove(q)
    return Response(
        gen(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def drain_queue(max_lines=10):
    out = []
    for _ in range(max_lines):
        try:
            out.append(line_q.get_nowait())
        except queue.Empty:
            break
    return out


def cmd_check_adapter():
    # Adapter-check expects adapter tokens, not tap-progress numbers.
    return send_command("usp,chk*", ignore_numeric_response=True)


def cmd_start_taps(speed_mode: str, taps: int):
    mode = str(speed_mode or "").strip().lower()
    if mode not in ("spd1", "spd2"):
        return {"ok": False, "error": "speed_mode must be spd1 or spd2"}
    try:
        n = int(taps)
    except (TypeError, ValueError):
        return {"ok": False, "error": "invalid tap count"}
    if n < 1:
        return {"ok": False, "error": "tap count must be >= 1"}
    return send_command(f"{mode},{n}*")


def cmd_start_validation(mode: str):
    m = str(mode or "").strip().lower()
    if m not in ("usp1", "usp2"):
        return {"ok": False, "error": "mode must be usp1 or usp2"}
    return send_command(f"{m},start*")


def cmd_stop():
    return send_command("stop*")


def cmd_status():
    return send_command("status*")


def _append_uart_log(direction: str, payload: str):
    path = _uart_log_path or "/opt/kiosk/uart_communications.log"
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
    line = f"{ts} [{direction}] {str(payload or '').strip()}\n"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with _uart_log_lock:
            with open(path, "a", encoding="utf-8") as f:
                f.write(line)
    except Exception:
        pass


def reset_uart_log(reason: str = "manual"):
    path = _uart_log_path or "/opt/kiosk/uart_communications.log"
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with _uart_log_lock:
            with open(path, "w", encoding="utf-8") as f:
                f.write(f"{ts} [SYSTEM] UART log reset ({reason})\n")
        return {"ok": True, "path": path}
    except Exception as e:
        return {"ok": False, "error": str(e), "path": path}

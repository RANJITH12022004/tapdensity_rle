#!/usr/bin/env python3
"""
rtc_service.py - RTC (DS1307) read/write.

When the kernel binds the chip (dtoverlay=i2c-rtc,ds1307), userspace I2C to 0x68 is EBUSY; use
hwclock(8) with /dev/rtc0 (requires sudo for non-root). Otherwise SMBus read/write is used.
"""

from datetime import datetime
from typing import Dict, Any, Optional
import os
import re
import subprocess

_logger = None
_smbus = None
DS1307_ADDR = 0x68
I2C_BUS = 1


def _get_smbus():
    global _smbus
    if _smbus is not None:
        return _smbus
    try:
        import smbus2 as bus
        _smbus = bus
        return _smbus
    except ImportError:
        pass
    try:
        import smbus as bus
        _smbus = bus
        return _smbus
    except ImportError:
        pass
    return None


def _bcd_to_int(b: int) -> int:
    return (b & 0x0f) + ((b >> 4) & 0x0f) * 10


def _int_to_bcd(n: int) -> int:
    n = max(0, min(99, n))
    return (n % 10) | ((n // 10) << 4)


def init(logger=None):
    global _logger
    _logger = logger


def _kernel_rtc_device_path() -> Optional[str]:
    if os.path.exists("/dev/rtc0"):
        return "/dev/rtc0"
    if os.path.exists("/dev/rtc"):
        return "/dev/rtc"
    return None


def _read_hwclock(rtc_dev: str) -> Optional[datetime]:
    """Read RTC via util-linux hwclock (needed when kernel owns the I2C device)."""
    cmd = ["hwclock", "-f", rtc_dev, "-r"]
    for argv in (cmd, ["sudo", "-n"] + cmd, ["sudo"] + cmd):
        try:
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=5)
            if proc.returncode != 0 or not (proc.stdout or "").strip():
                continue
            line = (proc.stdout or "").strip().splitlines()[0].strip()
            m = re.match(r"(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}:\d{2})", line)
            if m:
                return datetime.strptime(m.group(1) + " " + m.group(2), "%Y-%m-%d %H:%M:%S")
            m2 = re.match(r"(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})", line.replace("T", " "))
            if m2:
                return datetime.strptime(m2.group(1) + " " + m2.group(2), "%Y-%m-%d %H:%M:%S")
        except Exception:
            continue
    return None


def _write_hwclock_set(rtc_dev: str, dt: datetime) -> bool:
    """Write RTC registers via hwclock --set (kernel path)."""
    date_arg = dt.strftime("%Y-%m-%d %H:%M:%S")
    cmd = ["hwclock", "-f", rtc_dev, "--set", "--date=" + date_arg]
    for argv in (cmd, ["sudo", "-n"] + cmd, ["sudo"] + cmd):
        try:
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=8)
            if proc.returncode == 0:
                return True
        except Exception:
            continue
    return False


def _read_ds1307_i2c() -> Optional[datetime]:
    bus_module = _get_smbus()
    if not bus_module:
        return None
    try:
        bus = bus_module.SMBus(I2C_BUS)
        try:
            data = bus.read_i2c_block_data(DS1307_ADDR, 0x00, 7)
        finally:
            bus.close()
        sec = _bcd_to_int(data[0] & 0x7f)
        minute = _bcd_to_int(data[1])
        hour = _bcd_to_int(data[2] & 0x3f)
        date = _bcd_to_int(data[4])
        month = _bcd_to_int(data[5])
        year = _bcd_to_int(data[6]) + 2000
        return datetime(year, month, date, hour, minute, sec)
    except Exception as e:
        if _logger:
            _logger.debug("RTC I2C read failed: %s", e)
        return None


def _write_ds1307_i2c(dt: datetime) -> bool:
    bus_module = _get_smbus()
    if not bus_module:
        return False
    try:
        bus = bus_module.SMBus(I2C_BUS)
        try:
            bus.write_byte_data(DS1307_ADDR, 0x00, _int_to_bcd(dt.second) & 0x7f)
            bus.write_byte_data(DS1307_ADDR, 0x01, _int_to_bcd(dt.minute))
            bus.write_byte_data(DS1307_ADDR, 0x02, _int_to_bcd(dt.hour))
            bus.write_byte_data(DS1307_ADDR, 0x03, _int_to_bcd(dt.isoweekday() or 7))
            bus.write_byte_data(DS1307_ADDR, 0x04, _int_to_bcd(dt.day))
            bus.write_byte_data(DS1307_ADDR, 0x05, _int_to_bcd(dt.month))
            bus.write_byte_data(DS1307_ADDR, 0x06, _int_to_bcd(dt.year % 100))
        finally:
            bus.close()
        return True
    except Exception as e:
        if _logger:
            _logger.warning("RTC I2C write failed: %s", e)
        return False


def get_rtc_date() -> Dict[str, Any]:
    dt = _read_ds1307_i2c()
    if dt is not None:
        return {"success": True, "datetime": dt.strftime("%Y-%m-%dT%H:%M:%S"), "error": None}
    rtc_dev = _kernel_rtc_device_path()
    if rtc_dev:
        dth = _read_hwclock(rtc_dev)
        if dth is not None:
            return {
                "success": True,
                "datetime": dth.strftime("%Y-%m-%dT%H:%M:%S"),
                "error": None,
                "source": "hwclock",
            }
    now = datetime.now()
    return {
        "success": True,
        "datetime": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "error": None,
        "fallback": "system",
    }


def set_rtc_date(dt: Optional[datetime] = None) -> Dict[str, Any]:
    if dt is None:
        return {"success": False, "error": "datetime required"}
    if _write_ds1307_i2c(dt):
        return {"success": True, "error": None}
    rtc_dev = _kernel_rtc_device_path()
    if rtc_dev and _write_hwclock_set(rtc_dev, dt):
        return {"success": True, "error": None, "method": "hwclock-set"}
    return {"success": False, "error": "RTC write failed"}

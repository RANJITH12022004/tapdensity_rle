#!/usr/bin/env python3
"""
rtc_service.py - RTC (DS1307) read/write. On Windows or when I2C unavailable, get_rtc_date returns system time.
"""

from datetime import datetime
from typing import Dict, Any, Optional

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
    return {"success": False, "error": "RTC write failed"}

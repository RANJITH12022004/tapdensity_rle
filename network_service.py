#!/usr/bin/env python3
"""network_service.py - LAN IPv4 discovery (excludes Tailscale and virtual interfaces)."""

import ipaddress
import json
import re
import subprocess
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

_SKIP_IFACE_PREFIXES = (
    "lo",
    "tailscale",
    "docker",
    "veth",
    "br-",
    "tun",
    "wg",
    "zt",
    "cni",
    "flannel",
)


def _is_tailscale_cgnat(ip_str: str) -> bool:
    try:
        addr = ipaddress.IPv4Address(ip_str)
        return addr in ipaddress.IPv4Network("100.64.0.0/10")
    except ValueError:
        return False


def _is_link_local(ip_str: str) -> bool:
    return ip_str.startswith("169.254.")


def _is_loopback(ip_str: str) -> bool:
    return ip_str.startswith("127.")


def _should_skip_iface(name: str) -> bool:
    n = (name or "").strip().lower()
    if not n or n == "lo":
        return True
    return any(n.startswith(p) for p in _SKIP_IFACE_PREFIXES)


def _is_valid_lan_ip(ip_str: str) -> bool:
    if _is_loopback(ip_str) or _is_link_local(ip_str) or _is_tailscale_cgnat(ip_str):
        return False
    try:
        addr = ipaddress.IPv4Address(ip_str)
        return not addr.is_multicast and not addr.is_reserved
    except ValueError:
        return False


def _parse_ip_json_output(stdout: str) -> List[Dict[str, str]]:
    results: List[Dict[str, str]] = []
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return results
    for iface in data or []:
        ifname = str(iface.get("ifname") or "")
        if _should_skip_iface(ifname):
            continue
        for info in iface.get("addr_info") or []:
            if info.get("family") != "inet":
                continue
            local = str(info.get("local") or "").strip()
            if local and _is_valid_lan_ip(local):
                results.append({"interface": ifname, "address": local})
    return results


def _parse_ip_text_output(stdout: str) -> List[Dict[str, str]]:
    results: List[Dict[str, str]] = []
    for line in (stdout or "").splitlines():
        m = re.match(r"^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/", line.strip())
        if not m:
            continue
        ifname, ip_str = m.group(1), m.group(2)
        if _should_skip_iface(ifname):
            continue
        if _is_valid_lan_ip(ip_str):
            results.append({"interface": ifname, "address": ip_str})
    return results


def _dedupe_addresses(entries: List[Dict[str, str]]) -> List[Dict[str, str]]:
    seen = set()
    out: List[Dict[str, str]] = []
    for entry in entries:
        addr = entry.get("address")
        if not addr or addr in seen:
            continue
        seen.add(addr)
        out.append(entry)
    return out


def get_lan_ipv4_addresses() -> List[Dict[str, str]]:
    """Return global-scope IPv4 on LAN interfaces; excludes Tailscale and virtual NICs."""
    for ip_cmd in (
        ["ip", "-j", "-4", "addr", "show", "scope", "global"],
        ["/sbin/ip", "-j", "-4", "addr", "show", "scope", "global"],
    ):
        try:
            proc = subprocess.run(ip_cmd, capture_output=True, text=True, timeout=10)
            if proc.returncode != 0:
                continue
            entries = _parse_ip_json_output(proc.stdout or "")
            if entries:
                return _dedupe_addresses(entries)
        except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
            continue

    for ip_cmd in (
        ["ip", "-4", "-o", "addr", "show", "scope", "global"],
        ["/sbin/ip", "-4", "-o", "addr", "show", "scope", "global"],
    ):
        try:
            proc = subprocess.run(ip_cmd, capture_output=True, text=True, timeout=10)
            if proc.returncode != 0:
                continue
            entries = _parse_ip_text_output(proc.stdout or "")
            if entries:
                return _dedupe_addresses(entries)
        except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
            continue

    return []


def get_lan_ip_payload() -> Dict[str, Any]:
    addresses = get_lan_ipv4_addresses()
    if not addresses:
        display = "Not connected"
    elif len(addresses) == 1:
        display = addresses[0]["address"]
    else:
        display = "\n".join(entry["address"] for entry in addresses)
    return {
        "success": True,
        "addresses": addresses,
        "display": display,
    }


_TAILSCALE_IPV4_RE = re.compile(r"^100\.")


def _is_tailscale_address(family: str, address: str) -> bool:
    addr = str(address or "").strip().lower()
    if not addr:
        return True
    if family == "ipv4":
        if addr.startswith("127.") or _TAILSCALE_IPV4_RE.match(addr):
            return True
        return False
    if addr.startswith("::1"):
        return True
    return False


def _parse_ip_addr_show() -> List[Dict[str, str]]:
    """Parse `ip -o addr show` for global/up interfaces."""
    for ip_cmd in (
        ["ip", "-o", "addr", "show", "scope", "global", "up"],
        ["/sbin/ip", "-o", "addr", "show", "scope", "global", "up"],
    ):
        try:
            proc = subprocess.run(ip_cmd, capture_output=True, text=True, timeout=5, check=False)
        except (FileNotFoundError, subprocess.SubprocessError, OSError):
            continue
        if proc.returncode != 0:
            continue
        rows: List[Dict[str, str]] = []
        seen = set()
        for line in (proc.stdout or "").splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) < 4:
                continue
            iface = parts[1]
            if _should_skip_iface(iface):
                continue
            family_token = parts[2]
            cidr = parts[3]
            if family_token not in ("inet", "inet6"):
                continue
            family = "ipv4" if family_token == "inet" else "ipv6"
            address = cidr.split("/", 1)[0]
            if _is_tailscale_address(family, address):
                continue
            key = (iface, family, address)
            if key in seen:
                continue
            seen.add(key)
            rows.append({"interface": iface, "family": family, "address": address})
        if rows:
            return rows
    return []


def _interface_kind(iface: str) -> Optional[str]:
    """Map interface name to wlan or lan; ignore other interfaces."""
    name = str(iface or "").strip().lower()
    if name.startswith("wlan") or name.startswith("wl"):
        return "wlan"
    if name.startswith(("eth", "en", "end", "lan")):
        return "lan"
    return None


def list_non_tailscale_addresses() -> Dict[str, Any]:
    """Return WLAN and LAN IPv4 addresses only; hide Tailscale (100.x.x.x)."""
    addresses = _parse_ip_addr_show()
    wlan_ip: Optional[str] = None
    lan_ip: Optional[str] = None
    for row in addresses:
        if str(row.get("family") or "").lower() != "ipv4":
            continue
        kind = _interface_kind(row.get("interface") or "")
        addr = str(row.get("address") or "").strip()
        if not kind or not addr:
            continue
        if kind == "wlan" and wlan_ip is None:
            wlan_ip = addr
        elif kind == "lan" and lan_ip is None:
            lan_ip = addr
    if not wlan_ip and not lan_ip:
        for entry in get_lan_ipv4_addresses():
            iface = str(entry.get("interface") or "")
            addr = str(entry.get("address") or "").strip()
            if not addr:
                continue
            kind = _interface_kind(iface)
            if kind == "wlan" and not wlan_ip:
                wlan_ip = addr
            elif kind == "lan" and not lan_ip:
                lan_ip = addr
            elif not kind and not lan_ip:
                lan_ip = addr
    refreshed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "ok": True,
        "wlan": wlan_ip,
        "lan": lan_ip,
        "refreshedAt": refreshed_at,
    }

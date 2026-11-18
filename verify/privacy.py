#!/usr/bin/env python3
"""Check git-tracked text for accidental personal data (stdlib only).

Run python3 verify/privacy.py from anywhere in the checkout. Binary files and
node_modules are skipped. Diagnostics deliberately omit ALL source text so a
second secret on the same line cannot leak into public logs.

Justified exceptions: put `privacy: allow=CATEGORY -- reason` on the same line.
CATEGORY is email, ip, home, or api-key; one category per marker. Reasons must
contain at least eight characters. Keep exceptions narrow and review them as
carefully as code. Placeholders and documentation addresses need no marker.
This is a heuristic guardrail, not a substitute for reviewing published data.
"""

import ipaddress
import math
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path


EMAIL = re.compile(r"(?<![\w.+-])[\w.+-]+@(?:[\w-]+\.)+[A-Za-z]{2,}(?![\w-])")
IPV4 = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)")
IPV6 = re.compile(r"(?<![\w:])[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[\w-]+)?(?![\w:])")
HOME = re.compile(r"(?i)(?:/(?:home|Users)/|[A-Z]:[\\/]+Users[\\/]+)([\w@][\w.@-]*)")
KEY = re.compile(
    r"(?<![\w-])(?:sk-(?:[A-Za-z]+-)*[A-Za-z0-9_-]{20,}|"
    r"gh[po]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"AKIA[A-Z0-9]{16}|xox[bp]-[A-Za-z0-9-]{20,})(?![\w-])"
)
BEARER = re.compile(r"\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)", re.I)
ASSIGNMENT = re.compile(
    r"\b[\w-]*(?:key|token|secret|password)[\w-]*[\"']?\s*[:=]\s*[\"']?([A-Za-z0-9_+/=-]{24,})",
    re.I,
)
ALLOW = re.compile(r"privacy: allow=(email|ip|home|api-key) -- (\S[^\r\n]{7,})")
PLACEHOLDER_HOMES = {"user", "username", "you", "name", "example", "your-user", "yourname", "x"}
DOC_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32",
))


def allowed_ip(value):
    address = ipaddress.ip_address(value)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return allowed_ip(str(address.ipv4_mapped))
    return address.is_loopback or address.is_unspecified or any(
        address.version == network.version and address in network for network in DOC_NETWORKS
    )


def entropy(value):
    return -sum((count / len(value)) * math.log2(count / len(value))
                for count in Counter(value).values())


def categories(line):
    found = set()
    for match in EMAIL.finditer(line):
        local, domain = match.group().lower().split("@")
        if not (domain in {"example.com", "example.org"}
                or domain.endswith((".example.com", ".example.org"))
                or "noreply" in local or "no-reply" in local):
            found.add("email")
    for pattern in (IPV4, IPV6):
        for match in pattern.finditer(line):
            try:
                if not allowed_ip(match.group().rstrip(".")):
                    found.add("ip")
            except ValueError:
                pass
    if any(match[1].lower() not in PLACEHOLDER_HOMES for match in HOME.finditer(line)):
        found.add("home")
    if KEY.search(line) or BEARER.search(line) or any(
        entropy(match[1]) >= 3.5 for match in ASSIGNMENT.finditer(line)
    ):
        found.add("api-key")
    return found - {match[1] for match in ALLOW.finditer(line)}


def scan_file(path):
    data = path.read_bytes()
    if b"\0" in data:
        return []
    try:
        source = data.decode("utf-8")
    except UnicodeDecodeError:
        return []
    return [(number, category) for number, line in enumerate(source.splitlines(), 1)
            for category in sorted(categories(line))]


def main():
    try:
        root = Path(subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], stderr=subprocess.DEVNULL,
        ).decode().strip())
        names = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).split(b"\0")
        count = 0
        for name in names:
            if not name:
                continue
            relative = Path(name.decode("utf-8", errors="surrogateescape"))
            if "node_modules" in relative.parts:
                continue
            path = root / relative
            if path.is_symlink() or path.is_dir():
                continue
            for number, category in scan_file(path):
                print(f"{str(relative)!r}:{number}: {category}: [REDACTED]")
                count += 1
        print(f"Privacy check: {count} finding(s).")
        return 1 if count else 0
    except (OSError, subprocess.CalledProcessError):
        print("Privacy check: unable to read tracked files.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

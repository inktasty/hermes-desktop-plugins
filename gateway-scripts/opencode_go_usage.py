#!/usr/bin/env python3
"""OpenCode Go usage snapshot for the Hermes desktop 'opencode-usage' plugin.

Reads the Go API key from the environment or $HERMES_HOME/.env and calls the
official quota endpoint, then prints ONE line of JSON on stdout (the key is
never printed). Stdlib only: runs under any python3 on the gateway.

Usage:
    python3 opencode_go_usage.py
"""

import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request

USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
TIMEOUT = 20

# Window label + nominal length. The lengths are what OpenCode documents
# (5-hour rolling, calendar week, monthly from the subscription date); they are
# used only for the derived pace line, never for the headline percentage.
WINDOWS = (
    ("rolling", "5-hour", 5 * 3600, "hours"),
    ("weekly", "Weekly", 7 * 86400, "days"),
    ("monthly", "Monthly", None, "month"),
)


def hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def heartbeat(line: str) -> None:
    """Append one line per call so 'is the desktop plugin actually polling?' is
    answerable from the gateway. Best-effort: never break the snapshot."""
    try:
        path = os.path.join(hermes_home(), "logs", "opencode-usage-plugin.log")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            if os.path.getsize(path) > 200_000:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    keep = fh.readlines()[-200:]
                with open(path, "w", encoding="utf-8") as fh:
                    fh.writelines(keep)
        except OSError:
            pass
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def api_key() -> str:
    key = (os.environ.get("OPENCODE_GO_API_KEY") or "").strip()
    if key:
        return key
    env_path = os.path.join(hermes_home(), ".env")
    try:
        with open(env_path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("OPENCODE_GO_API_KEY"):
                    _, _, value = line.partition("=")
                    return value.strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def parse_iso(value):
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def iso(value: dt.datetime) -> str:
    return value.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def window_start(resets_at: dt.datetime, key: str):
    """When the current window began, from the reset instant (None when unknown)."""
    if key == "rolling":
        return resets_at - dt.timedelta(hours=5)
    if key == "weekly":
        return resets_at - dt.timedelta(days=7)
    # Monthly resets one calendar month after the subscription anniversary.
    month = 12 if resets_at.month == 1 else resets_at.month - 1
    year = resets_at.year - 1 if resets_at.month == 1 else resets_at.year
    try:
        return resets_at.replace(year=year, month=month)
    except ValueError:  # e.g. Mar 31 -> Feb 31
        return resets_at - dt.timedelta(days=30)


def build_window(key: str, label: str, length_s, kind: str, raw: dict, now: dt.datetime) -> dict:
    percent = raw.get("percent")
    try:
        percent = float(percent)
    except (TypeError, ValueError):
        percent = None
    resets = parse_iso(raw.get("resetsAt"))
    row = {
        "key": key,
        "label": label,
        "status": raw.get("status") or "unknown",
        "used_percent": percent,
        "remaining_percent": None if percent is None else max(0.0, 100.0 - percent),
        "resets_at": iso(resets) if resets else None,
        "reset_in_seconds": None if resets is None else max(0, int((resets - now).total_seconds())),
    }

    start = None
    total = length_s
    if key == "monthly" and resets is not None:
        start = window_start(resets, key)
        total = int((resets - start).total_seconds()) if start else None
    elif length_s:
        start = resets - dt.timedelta(seconds=length_s) if resets else None

    row["window_start"] = iso(start) if start else None
    row["window_seconds"] = total

    # Elapsed share of the window: always shown (it's a fact, not a forecast).
    if start is not None and total and total > 0:
        elapsed = min(max((now - start).total_seconds(), 0.0), float(total))
        row["elapsed_percent"] = round(elapsed / total * 100.0, 1)

        # Pace is a FORECAST, so it needs a sample worth extrapolating: at least
        # an hour in and 5% of the window, else a 30-day window 13 hours old
        # projects pure noise.
        if percent is not None and elapsed >= 3600 and elapsed / total >= 0.05:
            rate = percent / elapsed
            projected = min(999.0, rate * total)
            row["projected_percent"] = round(projected, 1)
            row["on_pace"] = projected <= 100.0
            row["hits_limit_at"] = (
                iso(now + dt.timedelta(seconds=(100.0 - percent) / rate))
                if rate > 0 and projected > 100.0 else None
            )
    return row


def main() -> int:
    now = dt.datetime.now(dt.timezone.utc)
    key = api_key()
    if not key:
        heartbeat("%s no-key" % iso(now))
        print(json.dumps({"ok": False, "error": "no OPENCODE_GO_API_KEY on this host"}))
        return 0

    request = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": "Bearer " + key,
            "Accept": "application/json",
            "User-Agent": "hermes-desktop-plugin/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        hint = {401: "API key rejected", 403: "no Go subscription on this key"}.get(exc.code, "HTTP %s" % exc.code)
        heartbeat("%s http-%s" % (iso(now), exc.code))
        print(json.dumps({"ok": False, "error": hint, "status": exc.code}))
        return 0
    except Exception as exc:  # network, DNS, timeout, bad JSON
        heartbeat("%s error %s" % (iso(now), type(exc).__name__))
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}))
        return 0

    usage = payload.get("usage") or {}
    windows = {}
    for key_name, label, length_s, kind in WINDOWS:
        raw = usage.get(key_name)
        if isinstance(raw, dict):
            windows[key_name] = build_window(key_name, label, length_s, kind, raw, now)

    print(json.dumps({
        "ok": bool(windows),
        "fetched_at": iso(now),
        "source": USAGE_URL,
        "plan": "OpenCode Go",
        "windows": windows,
        "error": None if windows else "usage endpoint returned no windows",
    }))
    heartbeat("%s ok %s" % (
        iso(now),
        " ".join("%s=%s" % (k, windows[k]["used_percent"]) for k in ("rolling", "weekly", "monthly") if k in windows) or "no-windows",
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main())

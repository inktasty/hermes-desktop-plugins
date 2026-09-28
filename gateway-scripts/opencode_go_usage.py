#!/usr/bin/env python3
"""OpenCode Go usage snapshot for the Hermes desktop 'opencode-usage' plugin.

Reports EVERY OpenCode Go key it can find, so an account with more than one
credential (a credential pool with a second key) shows each key's own quota
instead of only whichever key happens to be first -- and says which of them the
gateway is believed to be serving, so the status-bar chip does not report a
benched top-priority key's capped-out numbers as if they were the live account's.

Keys are discovered from two places, in this order:

  1. the gateway's credential pool -- $HERMES_HOME/auth.json ->
     credential_pool['opencode-go'] (other spellings of that provider name are
     accepted too). Each row is used as-is: its own `access_token`, else the
     variable its `source` names (`env:NAME`).
  2. the gateway's .env -- OPENCODE_GO_API_KEY and numbered siblings
     (OPENCODE_GO_API_KEY_2, _3, ...). Anything already covered by (1) is
     skipped, so this only ADDS keys the pool does not know about.

Nothing here assumes how a key is named: labels are taken from the pool row, and
a pool row whose secret this script cannot read is reported as such rather than
guessed at. A key value is never printed. ONE line of JSON goes to stdout.

Payload shape:

    {
      "ok": true,
      "fetched_at": "...",
      "source": "https://opencode.ai/zen/go/v1/usage",
      "plan": "OpenCode Go",
      "keys": [ {"index","label","priority","source","pool_status","active",
                 "benched","benched_until","ok","error","windows": {...}}, ... ],
      "windows": {...},   # the key in use, else the first key with data; older
                          # callers and the status-bar chip read this one
      "error": null
    }

Stdlib only: runs under any python3 on the gateway.

Usage:
    python3 opencode_go_usage.py
"""

import base64
import datetime as dt
import gzip
import json
import os
import sys
import urllib.error
import urllib.request

USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
TIMEOUT = 20
# shell.exec hands back only the LAST 4000 chars of stdout, so anything larger
# ships gzipped+base64 as {"ok":true,"gzip":"<b64>"} and is inflated by the
# plugin (same contract as opencode_go_models.py).
STDOUT_PLAIN_LIMIT = 3500
# The provider whose keys this plugin reports. `opencode-go` is the name Hermes
# uses; the alternates absorb a differently spelled pool entry (the comparison
# strips '-' and '_'), and non-Go providers are ignored.
POOL_PROVIDER = "opencode-go"
POOL_PROVIDER_COMPACT = "opencodego"
PRIMARY_ENV = "OPENCODE_GO_API_KEY"
ENV_SIBLING_LIMIT = 9
# Pool statuses/reasons meaning "not serving right now": the gateway benched this
# key after a failure. Anything else (None, 'ok', ...) counts as usable. Status
# values are matched loosely (lowercased) so a renamed one still reads.
BENCHED_STATUSES = {
    "exhausted", "invalid", "disabled", "revoked", "failed", "error",
    "unauthorized", "forbidden", "rate_limited", "quota_exceeded",
}
BENCHED_REASONS = {"rate_limit", "quota", "quota_exceeded", "auth", "unauthorized", "invalid"}
# opencode.ai answers 403 to a default python-urllib user agent; identify.
USER_AGENT = "hermes-desktop-plugin/1.0 (+https://hermes-agent.nousresearch.com)"

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


def env_lookup(var: str) -> str:
    """A variable's value from the process env, else $HERMES_HOME/.env."""
    if not var:
        return ""
    value = (os.environ.get(var) or "").strip()
    if value:
        return value
    try:
        with open(os.path.join(hermes_home(), ".env"), "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, raw = line.partition("=")
                if name.strip() == var:
                    return raw.strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def env_key_names() -> list:
    """Every .env variable a Go key may live under: the canonical name plus the
    numbered siblings Hermes accepts for extra credentials."""
    names = [PRIMARY_ENV]
    for n in range(2, ENV_SIBLING_LIMIT + 1):
        names.append("%s_%d" % (PRIMARY_ENV, n))
    return names


def load_pool() -> list:
    """The credential_pool rows for opencode-go ([] when absent/unreadable). The
    canonical provider name wins; a differently spelled one is accepted so a
    renamed pool still reports."""
    try:
        with open(os.path.join(hermes_home(), "auth.json"), "r", encoding="utf-8", errors="replace") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    pools = data.get("credential_pool") or {}
    if not isinstance(pools, dict):
        return []
    rows = pools.get(POOL_PROVIDER)
    if not isinstance(rows, list):
        compact = POOL_PROVIDER_COMPACT
        for name, candidate in pools.items():
            if isinstance(candidate, list) and str(name).lower().replace("-", "").replace("_", "") == compact:
                rows = candidate
                break
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def resolve_key(entry: dict) -> str:
    """The secret for one pool row: the row's own token, else the variable its
    source names. A row we cannot read yields '' -- never the primary key, which
    would put one key's numbers under another key's name."""
    for field in ("access_token", "secret"):
        token = entry.get(field)
        if isinstance(token, str) and token.strip():
            return token.strip()
    source = str(entry.get("source") or "")
    if source.startswith("env:"):
        return env_lookup(source[4:])
    return ""


def collect_entries() -> list:
    """One row per discoverable key, pool rows first (highest priority first),
    then any extra .env keys the pool does not carry. Identical secrets collapse
    to a single row. A single-key host ends up with exactly one row, so it
    behaves as it always has."""
    rows = []
    seen = set()
    for index, entry in enumerate(load_pool()):
        key = resolve_key(entry)
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        rows.append({
            "index": index,
            "label": entry.get("label") or ("key %d" % index),
            "priority": entry.get("priority"),
            "source": entry.get("source"),
            "pool_status": entry.get("last_status"),
            "failure_reason": entry.get("failure_reason"),
            "last_error_code": entry.get("last_error_code"),
            "last_error_reset_at": entry.get("last_error_reset_at"),
            "request_count": entry.get("request_count"),
            "key": key,
        })
    for name in env_key_names():
        key = env_lookup(name)
        if not key or key in seen:
            continue
        seen.add(key)
        rows.append({
            "index": len(rows),
            "label": name,
            "priority": None,
            "source": "env:" + name,
            "pool_status": None,
            "failure_reason": None,
            "last_error_code": None,
            "last_error_reset_at": None,
            "request_count": None,
            "key": key,
        })
    rows.sort(key=lambda r: (
        r["priority"] is None,
        r["priority"] if isinstance(r["priority"], (int, float)) else 999,
        r["index"],
    ))
    return rows


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


def parse_moment(value):
    """A timestamp as the pool writes it: a unix epoch number, else an ISO
    string. None when neither parses."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return dt.datetime.fromtimestamp(float(value), dt.timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    return parse_iso(value)


def iso(value: dt.datetime) -> str:
    return value.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def bench_info(row: dict, now: dt.datetime):
    """(benched, until) for one pool row. A benched key is not the one serving
    traffic; once its cooldown has elapsed the gateway may pick it again, so it
    stops counting as benched."""
    status = str(row.get("pool_status") or "").strip().lower()
    reason = str(row.get("failure_reason") or "").strip().lower()
    if status not in BENCHED_STATUSES and reason not in BENCHED_REASONS:
        return False, None
    until = parse_moment(row.get("last_error_reset_at"))
    if until is not None:
        return (False, until) if until <= now else (True, until)
    return True, None


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


def build_window(key: str, label: str, length_s, raw: dict, now: dt.datetime) -> dict:
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


def windows_for(payload: dict, now: dt.datetime) -> dict:
    usage = payload.get("usage") or {}
    windows = {}
    for key_name, label, length_s, _kind in WINDOWS:
        raw = usage.get(key_name)
        if isinstance(raw, dict):
            windows[key_name] = build_window(key_name, label, length_s, raw, now)
    return windows


def probe(key: str, now: dt.datetime):
    """One usage call for one key. Returns (ok, windows, error, http_status)."""
    request = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": "Bearer " + key,
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        hint = {401: "API key rejected", 403: "no Go subscription on this key"}.get(exc.code, "HTTP %s" % exc.code)
        return False, {}, hint, exc.code
    except Exception as exc:  # network, DNS, timeout, bad JSON
        return False, {}, "%s: %s" % (type(exc).__name__, exc), None
    windows = windows_for(payload, now)
    if not windows:
        return False, {}, "usage endpoint returned no windows", None
    return True, windows, None, None


def emit(payload: dict) -> None:
    """ONE line of JSON. Gzipped+base64 when the plain form would be cut off by
    shell.exec's 4000-char stdout tail."""
    text = json.dumps(payload)
    if len(text) <= STDOUT_PLAIN_LIMIT:
        print(text)
        return
    blob = base64.b64encode(gzip.compress(text.encode("utf-8"), 9, mtime=0)).decode("ascii")
    print(json.dumps({"ok": payload.get("ok", True), "gzip": blob}))


def main() -> int:
    now = dt.datetime.now(dt.timezone.utc)
    rows = collect_entries()
    if not any(r["key"] for r in rows):
        heartbeat("%s no-key" % iso(now))
        emit({"ok": False, "error": "no OpenCode Go key found (checked the credential pool and .env)"})
        return 0

    # Which key is serving? The highest-priority row the gateway has not benched:
    # that is where the next request goes. If every row is benched, the first one
    # still leads the fallback chain, so name it rather than inventing an answer.
    active_at = len(rows) - 1
    for position, row in enumerate(rows):
        benched, _until = bench_info(row, now)
        if not benched:
            active_at = position
            break

    keys_out = []
    for position, row in enumerate(rows):
        benched, until = bench_info(row, now)
        base = {
            "index": row["index"],
            "label": row["label"],
            "priority": row["priority"],
            "source": row["source"],
            "pool_status": row["pool_status"],
            "active": position == active_at,
            "benched": benched,
            "benched_until": iso(until) if until else None,
        }
        if row.get("failure_reason") is not None:
            base["failure_reason"] = row["failure_reason"]
        if row.get("last_error_code") is not None:
            base["last_error_code"] = row["last_error_code"]
        if row.get("request_count") is not None:
            base["request_count"] = row["request_count"]
        if not row["key"]:
            keys_out.append(dict(base, ok=False, error="no key readable for this pool entry", windows={}))
            continue
        ok, windows, error, status = probe(row["key"], now)
        entry_out = dict(base, ok=ok, windows=windows)
        if error:
            entry_out["error"] = error
            if status is not None:
                entry_out["status"] = status
        keys_out.append(entry_out)

    # `windows` is what the status-bar chip reads. Point it at the key in use
    # (else the first key that returned data) so a benched top-priority key can
    # never make the chip report numbers nobody is spending.
    primary = {}
    if 0 <= active_at < len(keys_out) and keys_out[active_at].get("windows"):
        primary = keys_out[active_at]["windows"]
    else:
        for entry in keys_out:
            if entry.get("windows"):
                primary = entry["windows"]
                break

    emit({
        "ok": bool(primary),
        "fetched_at": iso(now),
        "source": USAGE_URL,
        "plan": "OpenCode Go",
        "keys": keys_out,
        "windows": primary,
        "error": None if primary else "usage endpoint returned no windows",
    })
    active_label = keys_out[active_at]["label"] if 0 <= active_at < len(keys_out) else "?"
    heartbeat("%s ok active=%s %s" % (
        iso(now),
        active_label,
        " ".join("%s=[%s]" % (k["label"], ",".join(
            "%s:%s" % (w, (k["windows"].get(w) or {}).get("used_percent"))
            for w in ("rolling", "weekly", "monthly"))) for k in keys_out) or "no-windows",
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main())

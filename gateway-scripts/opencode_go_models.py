#!/usr/bin/env python3
"""OpenCode Go model list + prices + monthly caps, for the desktop usage plugin.

Four sources, merged into ONE line of JSON on stdout:

  1. GET {GO_BASE}/models          -- the documented model list API
     (https://opencode.ai/inference/go/v1/models): every Go model with its prices,
     long-context and peak-hour pricing, monthly usage limit per plan, and training/ZDR
     flags. With a key it lists the models that key's workspace can use; without one,
     every public Go model. This is the authoritative source for the table.
  2. https://opencode.ai/v2/docs/console/go -- the data-retention table and its per-model
     notes, the window share rules, and any per-model tables the page still carries
     (prices, caps, request estimates, promotion labels); fetched as markdown through
     content negotiation (the old /docs/go.md path 404s)
  3. https://models.opencode.ai/api.json -- the live catalog, used to cross-check the
     prices and to price models when (1) is unreachable. Cached on disk with a 12h TTL and
     ETag revalidation; falls back to the stale cache, then to the models.dev registry
     cache, when the network is down.
  4. the local models.dev registry cache (HERMES_HOME/models_dev_cache.json), which
     supplies each model's release_date for the table's Released column.

Never prints credentials. Always prints parseable JSON, even on partial failure.
Stdlib only. Usage:  python3 opencode_go_models.py
"""

import base64
import datetime as dt
import gzip
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
ENV_FILE = HERMES_HOME / ".env"
CATALOG_CACHE = HERMES_HOME / "cache" / "opencode_go_catalog.json"
REGISTRY_CACHE = HERMES_HOME / "models_dev_cache.json"

# The console's own models endpoint, as documented at
# https://opencode.ai/v2/docs/console/go ("Fetch the full list of available models and
# their metadata from the models endpoint"). Deliberately NOT read from
# OPENCODE_GO_BASE_URL: that variable is the RUNTIME provider's base URL -- Hermes reads
# it for chat traffic -- so inheriting it would leave this table on the legacy path, and
# moving the table would relocate live chat traffic as a side effect.
DEFAULT_GO_BASE = "https://opencode.ai/inference/go/v1"
# Plugin-only override, for aiming the table at a mirror without touching the runtime.
BASE_ENV = "OPENCODE_GO_MODELS_BASE_URL"
# The docs page, read as markdown through content negotiation (see fetch_docs): the
# legacy /docs/go.md path answers 404 as of 2026-10-16, and the page still serves its
# source markdown to a client that asks for text/markdown.
DOCS_URL = "https://opencode.ai/v2/docs/console/go"
DOCS_ACCEPT = "text/markdown, text/plain;q=0.9, */*;q=0.8"
CATALOG_URL = "https://models.opencode.ai/api.json"
CATALOG_TTL_S = 12 * 3600
HTTP_TIMEOUT = 25
# opencode.ai answers 403 to a default Python-urllib user agent (verified 2026-09-21),
# and the docs ask clients to identify themselves, so send a real name.
USER_AGENT = "hermes-desktop-plugin/1.0 (+https://hermes-agent.nousresearch.com)"
# shell.exec returns only the last 4000 chars of stdout; stay well under it.
STDOUT_PLAIN_LIMIT = 3500
# Absolute ceiling for one stdout line; past this the gateway truncates it.
STDOUT_HARD_LIMIT = 3900
# A payload that not even the gzipped form fits in one stdout is spooled to a file
# NAMED FOR A HASH OF ITS OWN BYTES and read back in slices of SPOOL_PART_CHARS
# through `--part N --id <hex>` calls. The per-run name is what stops two runs in
# the same window from splicing each other's slices; the slices are base64 (no
# whitespace, no newline), so joining them is exact.
SPOOL_PART_CHARS = 3500
SPOOL_DIR = HERMES_HOME / "cache"
SPOOL_PREFIX = "opencode_go_models."
SPOOL_SUFFIX = ".spool"
# A spool file older than this is litter from a crashed run; sweep it on write.
SPOOL_TTL_S = 600

# Caps and offers OpenCode announces on X but has not put in the docs yet. Keep
# these short and always carry the source URL, so the table can say where a
# number came from instead of passing an announcement off as documentation.
ANNOUNCEMENTS = [
    {
        "match": "omen-alpha",
        "cap_usd": 100.0,
        "note": "Go-only stealth model: $100 of usage on the $10 plan",
        "source": "https://x.com/opencode/status/2095746098522452093",
        "date": "2026-09-04",
    },
    {
        "match": "mimo-v2.6-flash",
        "cap_usd": None,
        "note": "Free for one week",
        "source": "https://x.com/opencode/status/2102145730999730611",
        "date": "2026-09-21",
        "ends": "2026-09-28",
    },
]

TAG_RE = re.compile(r"<[^>]+>")
SMALL_RE = re.compile(r"<small>(.*?)</small>", re.S)
LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")


# ---------------------------------------------------------------- plumbing ---

def env_value(name):
    """Read one key out of the gateway .env without exporting anything."""
    value = os.environ.get(name)
    if value:
        return value.strip()
    try:
        # utf-8-sig: a BOM (Notepad, PowerShell Out-File) would otherwise hide the
        # FIRST variable, because str.strip() does not remove U+FEFF.
        for line in ENV_FILE.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, raw = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):   # `export KEY=value` is a valid line
                key = key[7:].strip()
            if key == name:
                value = raw.strip().strip("'\"")
                if not raw.strip().startswith(("'", '"')):
                    value = value.split(" #", 1)[0].strip()   # KEY=abc # note
                return value
    except OSError:
        return ""
    return ""


def gateway_key():
    """The Go key to authenticate with: the highest-priority credential-pool row
    the gateway has not benched, else the plain .env variable.

    The pool is the setup the README documents, and the usage script reads it --
    reading only OPENCODE_GO_API_KEY here made a pool-only install fall back to
    the whole live catalog while the page still claimed docs prices.
    """
    try:
        data = json.loads((HERMES_HOME / "auth.json").read_text(encoding="utf-8-sig", errors="replace"))
    except (OSError, ValueError):
        data = {}
    pools = (data or {}).get("credential_pool") or {}
    rows = []
    if isinstance(pools, dict):
        candidate = pools.get("opencode-go")
        if not isinstance(candidate, list):
            for name, value in pools.items():
                if isinstance(value, list) and str(name).lower().replace("-", "").replace("_", "") == "opencodego":
                    candidate = value
                    break
        if isinstance(candidate, list):
            rows = [row for row in candidate if isinstance(row, dict)]

    benched = {"exhausted", "invalid", "disabled", "revoked", "failed", "error"}
    ranked = []
    for index, row in enumerate(rows):
        token = ""
        for field in ("access_token", "secret"):
            candidate = row.get(field)
            if isinstance(candidate, str) and candidate.strip():
                token = candidate.strip()
                break
        if not token:
            source = str(row.get("source") or "")
            if source.startswith("env:"):
                token = env_value(source[4:])
        if not token:
            continue   # unreadable row: never borrow another key's identity
        rank = 1 if str(row.get("last_status") or "").strip().lower() in benched else 0
        priority = row.get("priority")
        ranked.append((rank, priority if isinstance(priority, (int, float)) else index, index, token))
    ranked.sort()
    return ranked[0][3] if ranked else env_value("OPENCODE_GO_API_KEY")


def http_get(url, headers=None, timeout=HTTP_TIMEOUT):
    merged = {"User-Agent": USER_AGENT, "Accept": "application/json, text/markdown;q=0.9, */*;q=0.8"}
    merged.update(headers or {})
    request = urllib.request.Request(url, headers=merged)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.headers.get("ETag")


def text_of(response):
    return response.decode("utf-8", errors="replace")


def strip_tags(value):
    plain = TAG_RE.sub(" ", value or "")
    plain = LINK_RE.sub(r"\1", plain)
    return re.sub(r"\s+", " ", plain).strip()


def norm(name):
    return re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")


# The registry section the Go catalog mirrors; an id listed there wins over the
# same id under any other provider.
GO_SECTION = "opencode-go"


def norm_id(value):
    """Registry id comparison key: lowercase, every non-alphanumeric dropped.

    'MiMo-V2.6-Flash' and 'mimo-v2.6-flash' collapse to one key, which is what
    lets a served id find its registry entry across every provider.
    """
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def registry_index():
    """{normalized id: [(provider, id, release_date), ...]} from the registry cache.

    Built once per run from HERMES_HOME/models_dev_cache.json -- the same local
    file registry_fallback() reads, so no extra request and no network. Only
    entries that publish a release_date are indexed.
    """
    try:
        cache = json.loads(REGISTRY_CACHE.read_text(encoding="utf-8-sig", errors="replace"))
    except (OSError, ValueError):
        return {}
    if not isinstance(cache, dict):
        return {}
    index = {}
    for provider, section in cache.items():
        models = (section or {}).get("models") if isinstance(section, dict) else None
        if not isinstance(models, dict):
            continue
        for model_id, spec in models.items():
            date = (spec or {}).get("release_date") if isinstance(spec, dict) else None
            if not isinstance(date, str) or not date.strip():
                continue
            key = norm_id(model_id)
            if not key:
                continue
            index.setdefault(key, []).append((provider, model_id, date.strip()))
    return index


def release_for(model_id, index):
    """This model's registry release_date, or None when the registry has none.

    The search runs over EVERY provider: the opencode-go section first, then an
    exact id match, then the earliest date (a model cannot ship twice, so the
    earliest date is the real one).
    """
    candidates = index.get(norm_id(model_id)) or []
    if not candidates:
        return None
    ranked = sorted(candidates, key=lambda c: (
        0 if c[0] == GO_SECTION else 1,
        0 if c[1] == model_id else 1,
        c[2],
    ))
    return ranked[0][2]


def as_float(raw):
    try:
        return float(str(raw).replace(",", "").replace("$", "").strip())
    except (TypeError, ValueError):
        return None


def as_int(raw):
    try:
        return int(str(raw).replace(",", "").replace("$", "").strip())
    except (TypeError, ValueError):
        return None


def cell_value(raw):
    """One numeric cell. A bold value is the current one (a struck-through value is
    what it used to be, e.g. during a promotion); '<br />' separates the two."""
    if not raw:
        return None
    bold = re.search(r"\*\*\s*\$?([\d.,]+)\s*\*\*", raw)
    if bold:
        return as_float(bold.group(1))
    plain = re.search(r"\$([\d.,]+)", raw)
    if plain:
        return as_float(plain.group(1))
    return as_float(strip_tags(raw))


def struck_value(raw):
    match = re.search(r"~~\s*\$?([\d.,]+)\s*~~", raw)
    return as_float(match.group(1)) if match else None


def promo_label(raw):
    match = SMALL_RE.search(raw or "")
    return strip_tags(match.group(1)) if match else None


# ------------------------------------------------------------- API + catalog ---

def api_models():
    """{id: endpoint_entry} from the Go model list API, plus the base URL it came from,
    an error string, and whether the list was the key's own (True) or the public one.

    The key is optional on this endpoint: with one the list is the models its
    workspace can use, without one (or when the keyed request fails) every public Go
    model, which still carries the same prices, limits and privacy flags.
    """
    base = (env_value(BASE_ENV) or DEFAULT_GO_BASE).rstrip("/")
    key = gateway_key()
    error = None
    attempts = ([{"Authorization": "Bearer " + key}] if key else []) + [{}]
    for headers in attempts:
        try:
            raw, _ = http_get(base + "/models", headers)
            payload = json.loads(text_of(raw))
        except (urllib.error.URLError, OSError, ValueError) as exc:
            error = "model list request failed: " + str(exc)
            continue
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list):
            error = "model list response had no data array"
            continue
        entries = {
            str(item["id"]): endpoint_entry(item)
            for item in data
            if isinstance(item, dict) and item.get("id")
        }
        if not entries:
            error = "model list was empty"
            continue
        return dict(sorted(entries.items())), base, error, bool(headers)
    return None, base, error, False


def _cache_price(cache, field):
    """A cache price: a number, or a {ttl: price} map whose first (shortest) TTL wins."""
    value = (cache or {}).get(field)
    if isinstance(value, dict):
        value = next(iter(value.values()), None)
    return as_float(value) if value is not None else None


_DAY_NAMES = {"mon": "Mon", "tue": "Tue", "wed": "Wed", "thu": "Thu", "fri": "Fri", "sat": "Sat", "sun": "Sun"}


def describe_when(when):
    """A short label for a pricing condition: '> 256K tokens', 'peak hours', 'from 2026-12-01'."""
    when = when if isinstance(when, dict) else {}
    context = (when.get("context") or {}).get("gt") if isinstance(when.get("context"), dict) else None
    if isinstance(context, (int, float)):
        return "> %gK tokens" % (context / 1000) if context >= 1000 else "> %g tokens" % context
    date = when.get("date") if isinstance(when.get("date"), dict) else None
    if date and date.get("gte"):
        return "from " + str(date["gte"])
    if "utc_days" in when or "utc_hours" in when or "any" in when:
        return "peak hours"
    return "conditional"


PRICE_FIELDS = ("input", "output", "cache_read", "cache_write")


def _scaled(prices, factor):
    return {field: (prices[field] * factor if prices.get(field) is not None else None) for field in PRICE_FIELDS}


def _scheduled_start(when):
    """The start date of a date-only condition ('YYYY-MM-DD'), else None."""
    if isinstance(when, dict) and set(when) == {"date"} and isinstance(when["date"], dict):
        start = str(when["date"].get("gte") or "")[:10]
        return start or None
    return None


def endpoint_entry(item, today=None):
    """One model list item, slimmed to what the table reads.

    `cost.text` holds the base card; `overrides` (long-context prices) and
    `cost.multipliers` (peak hours, scheduled price changes) become `tiers`.
    """
    cost = item.get("cost") if isinstance(item.get("cost"), dict) else {}
    text = cost.get("text") if isinstance(cost.get("text"), dict) else {}
    inp = text.get("input") if isinstance(text.get("input"), dict) else {}
    out = text.get("output") if isinstance(text.get("output"), dict) else {}
    base = {
        "input": as_float(inp.get("price")) if inp.get("price") is not None else None,
        "output": as_float(out.get("price")) if out.get("price") is not None else None,
        "cache_read": _cache_price(inp.get("cache"), "read"),
        "cache_write": _cache_price(inp.get("cache"), "write"),
    }

    tiers = []
    out_overrides = [o for o in (out.get("overrides") or []) if isinstance(o, dict)]
    for index, override in enumerate(o for o in (inp.get("overrides") or []) if isinstance(o, dict)):
        paired = out_overrides[index] if index < len(out_overrides) else {}
        tiers.append({
            "label": describe_when(override.get("when")),
            "input": as_float(override.get("price")) if override.get("price") is not None else None,
            "output": as_float(paired.get("price")) if paired.get("price") is not None else None,
            "cache_read": _cache_price(override.get("cache"), "read"),
            "cache_write": _cache_price(override.get("cache"), "write"),
        })
    today = (today or dt.datetime.now(dt.timezone.utc).date()).isoformat()
    multipliers = [m for m in (cost.get("multipliers") or []) if isinstance(m, dict) and as_float(m.get("factor"))]
    upcoming = []
    for multiplier in multipliers:
        start = _scheduled_start(multiplier.get("when"))
        if start and start <= today:
            # A scheduled price change that has started is simply the price now.
            factor = as_float(multiplier["factor"])
            base = _scaled(base, factor)
            tiers = [dict(tier, **_scaled(tier, factor)) for tier in tiers]
        else:
            upcoming.append(multiplier)
    for multiplier in upcoming:
        factor = as_float(multiplier["factor"])
        tiers.append(dict({"label": "%s (%gx)" % (describe_when(multiplier.get("when")), factor)}, **_scaled(base, factor)))

    go = item.get("go") if isinstance(item.get("go"), dict) else {}
    usage = go.get("monthly_usage")
    monthly = None
    if isinstance(usage, dict):
        monthly = {plan: as_float(value) for plan, value in usage.items() if as_float(value) is not None} or None
    limit = item.get("limit") if isinstance(item.get("limit"), dict) else {}
    release = item.get("release_date")
    return dict(base, **{
        "name": item.get("name") or item.get("id"),
        "context": limit.get("context"),
        "released": release.strip() if isinstance(release, str) and release.strip() else None,
        "monthly_usage": monthly,
        "zdr": go.get("zdr") if isinstance(go.get("zdr"), bool) else None,
        "training": go.get("training") if isinstance(go.get("training"), bool) else None,
        "tiers": tiers,
    })


def fetch_catalog():
    """{model_id: {input, output, cache_read, cache_write, context, name}} + age."""
    cached = None
    try:
        cached = json.loads(CATALOG_CACHE.read_text(encoding="utf-8-sig", errors="replace"))
    except (OSError, ValueError):
        cached = None
    age = None
    if isinstance(cached, dict) and isinstance(cached.get("models"), dict):
        # A truncated or hand-edited cache can hold a non-numeric fetched_at, and
        # the float() below is outside the read guard: treat it as stale.
        try:
            age = time.time() - float(cached.get("fetched_at", 0) or 0)
        except (TypeError, ValueError):
            age = None

    if isinstance(cached, dict) and age is not None and age < CATALOG_TTL_S:
        return cached["models"], age, None

    headers = {"Accept": "application/json"}
    etag = cached.get("etag") if isinstance(cached, dict) else None
    if etag:
        headers["If-None-Match"] = etag
    try:
        raw, new_etag = http_get(CATALOG_URL, headers, timeout=40)
        full = json.loads(text_of(raw))
        entry = full.get("opencode-go") if isinstance(full, dict) else None
        models = (entry or {}).get("models")
        if not isinstance(models, dict) or not models:
            raise ValueError("catalog has no opencode-go section")
        slim = {}
        for model_id, spec in models.items():
            cost = (spec or {}).get("cost") or {}
            slim[model_id] = {
                "name": (spec or {}).get("name") or model_id,
                "input": as_float(cost.get("input")),
                "output": as_float(cost.get("output")),
                "cache_read": as_float(cost.get("cache_read")),
                "cache_write": as_float(cost.get("cache_write")),
                "context": ((spec or {}).get("limit") or {}).get("context"),
            }
        try:
            CATALOG_CACHE.parent.mkdir(parents=True, exist_ok=True)
            CATALOG_CACHE.write_text(json.dumps({
                "fetched_at": time.time(), "etag": new_etag, "models": slim,
            }), encoding="utf-8")
        except OSError:
            pass
        return slim, 0.0, None
    except urllib.error.HTTPError as exc:
        if exc.code == 304 and isinstance(cached, dict) and isinstance(cached.get("models"), dict):
            # 304: the payload is unchanged, so refresh the cache's OWN age stamp.
            # Without this the on-disk fetched_at stays at the original fetch, the
            # TTL check above always fails, and every run sends a conditional
            # request that (correctly) answers 304 again, forever.
            cached["fetched_at"] = time.time()
            try:
                CATALOG_CACHE.parent.mkdir(parents=True, exist_ok=True)
                CATALOG_CACHE.write_text(json.dumps(cached), encoding="utf-8")
            except OSError:
                pass
            return cached["models"], 0.0, None
        reason = "catalog request failed: HTTP " + str(exc.code)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        reason = "catalog request failed: " + str(exc)

    if isinstance(cached, dict) and isinstance(cached.get("models"), dict):
        return cached["models"], age, reason
    return registry_fallback(), None, reason


def registry_fallback():
    """models.dev registry cache, the same file model_price_lookup.py reads."""
    try:
        cache = json.loads(REGISTRY_CACHE.read_text(encoding="utf-8-sig", errors="replace"))
    except (OSError, ValueError):
        return {}
    models = ((cache.get("opencode-go") or {}).get("models")) or {}
    slim = {}
    for model_id, spec in models.items():
        cost = (spec or {}).get("cost") or {}
        slim[model_id] = {
            "name": (spec or {}).get("name") or model_id,
            "input": as_float(cost.get("input")),
            "output": as_float(cost.get("output")),
            "cache_read": as_float(cost.get("cache_read")),
            "cache_write": as_float(cost.get("cache_write")),
            "context": ((spec or {}).get("limit") or {}).get("context"),
        }
    return slim


# ---------------------------------------------------------------- docs page ---

def fetch_docs():
    """The console docs page as markdown: the format every parser below reads.

    Content negotiation, not a .md URL (the legacy DOCS_MD path 404s): the docs site
    answers a request that asks for text/markdown with its source markdown. Raises
    like http_get, so the caller records the failure and the table degrades to the
    live catalog instead of going blank.
    """
    raw, _ = http_get(DOCS_URL, {"Accept": DOCS_ACCEPT})
    return text_of(raw)


def table_blocks(markdown):
    """Every markdown table in the page as [header_cells, *data_cells]."""
    blocks, current = [], []
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("|"):
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            if cells and all(cell and set(cell) <= set("-: ") for cell in cells):
                continue  # separator row
            current.append(cells)
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    return blocks


def split_variant(name):
    """"Qwen3.7 Plus (≤ 256K tokens)" -> ("Qwen3.7 Plus", "≤ 256K tokens")."""
    match = re.match(r"^(.*?)\s*\((.*)\)\s*$", name)
    if not match:
        return name, None
    return match.group(1).strip(), match.group(2).strip()


def parse_docs(markdown):
    """{normalized model name: {name, tiers, monthly_*, req_*, promo}} from the page."""
    docs = {}
    for block in table_blocks(markdown):
        header = " ".join(block[0]).lower()
        if "cached read" in header and "input" in header:
            kind = "price"
        elif "requests per 5 hour" in header:
            kind = "requests"
        else:
            continue
        for cells in block[1:]:
            if len(cells) < 3:
                continue
            raw_name = cells[0]
            label = promo_label(raw_name)
            name, variant = split_variant(strip_tags(SMALL_RE.sub(" ", raw_name)))
            key = norm(name)
            if not key:
                continue
            entry = docs.setdefault(key, {"name": name, "tiers": [], "promo": None})
            if label and not entry.get("promo"):
                entry["promo"] = label
            if kind == "price" and len(cells) >= 6:
                entry["tiers"].append({
                    "variant": variant,
                    "input": cell_value(cells[1]),
                    "output": cell_value(cells[2]),
                    "cache_read": cell_value(cells[3]),
                    "cache_write": cell_value(cells[4]),
                })
                if "monthly_usd" not in entry:
                    entry["monthly_usd"] = cell_value(cells[5])
                    entry["monthly_before_usd"] = struck_value(cells[5])
                    limit_label = promo_label(cells[5])
                    if limit_label and not entry.get("promo"):
                        entry["promo"] = limit_label
            elif kind == "requests" and len(cells) >= 4:
                entry["req_5h"] = cell_value(cells[1])
                entry["req_week"] = cell_value(cells[2])
                entry["req_month"] = cell_value(cells[3])
    return docs


def default_tier(entry):
    """The card in force most of the time: off-peak if the model has that pair."""
    tiers = entry.get("tiers") or []
    for tier in tiers:
        if tier.get("variant") and "off-peak" in tier["variant"].lower():
            return tier
    return tiers[0] if tiers else {}


def alternate_tiers(entry):
    base = default_tier(entry)
    return [tier for tier in (entry.get("tiers") or []) if tier is not base and tier.get("variant")]


# A promo end date as the docs write it: "Ends Sep 27", "Ends Sep 27, 2026",
# "through Oct 3". The month is a 3-letter abbreviation; the day is 1-2 digits;
# the year is optional (absent => the next occurrence of that month/day, which
# for a promo means the coming one, so a bare "Ends Sep 27" read in, say, late
# September means THIS year's Sep 27, already past once the date rolls by).
_PROMO_END_RE = re.compile(
    r"\b(?:ends?|through|until|expires?)\s+"
    r"([A-Za-z]{3,})\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?",
    re.IGNORECASE,
)
_MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    )
}


def promo_end_date(label, today=None):
    """The calendar day a promo label says it ends, or None.

    None means either no end date is stated ("limited time") or it is not a date
    this parser recognises -- in both cases the promo is treated as still live
    (a promo we cannot date is not assumed expired). A recognised date in the
    past is what the caller drops.
    """
    match = _PROMO_END_RE.search(str(label or ""))
    if not match:
        return None
    month = _MONTHS.get(match.group(1)[:3].lower())
    if not month:
        return None
    day = int(match.group(2))
    if not (1 <= day <= 31):
        return None
    today = today or dt.date.today()
    if match.group(3):
        # An explicit year is taken literally, valid or not.
        try:
            return dt.date(int(match.group(3)), month, day)
        except ValueError:
            return None
    # A bare month/day: the candidate NEAREST today across year-1 .. year+4, so a
    # date already past this year reads as past instead of rolling forward a full
    # year. A Feb 29 promo read in 2026 is Feb 29 2028, not nothing -- skipping
    # nonexistent dates keeps a datable promo datable.
    cands = []
    for year in range(today.year - 1, today.year + 5):
        try:
            cands.append(dt.date(year, month, day))
        except ValueError:
            pass
    return min(cands, key=lambda d: abs((d - today).days)) if cands else None


def _live_promo(label, today=None):
    """The label if the promo is still live, else None.

    One gate for every promo surface (the top-of-page list AND the per-model row
    badge), so the two can never disagree: a promo whose stated end date has
    passed is dropped, a label with no recognisable end date is kept (see
    promo_end_date).
    """
    if not label:
        return None
    today = today or dt.date.today()
    end = promo_end_date(label, today)
    if end is not None and end < today:
        return None
    return label


def docs_promos(docs, served_keys=None, today=None):
    """Model-level promotions the docs label, e.g. '4x · Ends Sep 27'.

    Two filters, both required by the UI contract:

    * an expired promo (its stated end date is in the past) is dropped, so a
      label the docs still carry -- or a cached copy of them -- never renders a
      dead offer at the top of the page;
    * a promo whose model is not in `served_keys` is dropped, so a promotion for
      a model this key is not served never shows. `served_keys` is the
      normalised set the API actually returned; when it is None (no key / no API
      answer) the served filter is skipped and only the date filter applies.
    """
    today = today or dt.date.today()
    served = set(served_keys) if served_keys is not None else None
    promos = []
    for key, entry in docs.items():
        label = _live_promo(entry.get("promo"), today)
        if not label:
            continue
        end = promo_end_date(label, today)
        if served is not None and norm(key) not in served:
            continue  # not served to this key
        promos.append({
            "model_key": key,
            "name": entry.get("name") or key,
            "label": label,
            "monthly_usd": entry.get("monthly_usd"),
            "monthly_before_usd": entry.get("monthly_before_usd"),
            "ends": end.isoformat() if end is not None else None,
        })
    return promos


def share(match):
    value = as_float(match.group(1)) if match else None
    return (value / 100) if value is not None else None


def plan_info(markdown):
    """Subscription price, the per-window share rules, and non-price program notes."""
    text = re.sub(r"\s+", " ", TAG_RE.sub(" ", LINK_RE.sub(r"\1", markdown)))
    price = re.search(r"\*\*\$(\d+(?:\.\d+)?)/month", text) or re.search(r"\$(\d+(?:\.\d+)?)\s*(?:/|per\s+)month", text)
    intro = re.search(r"\$(\d+(?:\.\d+)?)\s*(?:for|your first month|first month)", text)
    # "5-hour — 20% of the monthly limit" (older page) or
    # "The **5-hour limit** is 20% of your monthly allowance" (current page).
    five = (re.search(r"5-hour\s*(?:—|-|:)\s*(\d+)% of the monthly limit", text)
            or re.search(r"5-hour limit\W*is\s+(\d+)%", text, re.I))
    weekly = (re.search(r"weekly\s*(?:—|-|:)\s*(\d+)%", text)
              or re.search(r"weekly limit\W*is\s+(\d+)%", text, re.I))
    notes = []
    for line in markdown.splitlines():
        bullet = re.match(r"\s*-\s+\*\*([^*]+?):\*\*\s*(.+?)\s*$", line)
        if not bullet:
            continue
        name, body = bullet.group(1).strip(), strip_tags(bullet.group(2))
        if any(word in body.lower() for word in ("discount", "train future", "extra usage", "promotion")):
            notes.append({"name": name, "text": body})
    return {
        "price_usd_month": as_float(price.group(1)) if price else None,
        "intro_offer_usd": as_float(intro.group(1)) if intro else None,
        "five_hour_share": share(five),
        "weekly_share": share(weekly),
        "notes": notes,
    }


# ------------------------------------------------------------------- merge ---

def price_check(docs_tier, catalog_entry):
    """Do the docs price and the live catalog agree on this model?"""
    if not docs_tier or not catalog_entry:
        return None
    compared = False
    for field in ("input", "output", "cache_read"):
        left, right = docs_tier.get(field), catalog_entry.get(field)
        if left is None or right is None:
            continue
        compared = True
        if abs(left - right) > 0.005:
            return "differs"
    return "match" if compared else None


def parse_privacy(markdown):
    """{norm(name): {training, retention, zdr, note_key}} + {note_key: {label, text}}.

    The docs carry a Privacy table (data retention, plus model training on older
    pages) with per-model footnotes; both feed the ZDR column in the plugin.
    `training` is None when the table has no training column.
    """
    rows, notes = {}, {}
    if not markdown:
        return rows, notes
    for block in table_blocks(markdown):
        header = " ".join(block[0]).lower()
        if "data retention" not in header:
            continue
        has_training = "model training" in header
        width = 3 if has_training else 2
        for cells in block[1:]:
            if len(cells) < width:
                continue
            name = strip_tags(cells[0]).strip()
            training = strip_tags(cells[1]).strip() if has_training else None
            retention = strip_tags(cells[width - 1]).replace("\\", "").strip()
            key = norm(name)
            if not key:
                continue
            rows[key] = {
                "training": None if training is None else ("used" if training.lower().startswith("yes") else "not_used"),
                "retention": retention,
                "zdr": retention.lower().startswith("0"),
                "note_key": None,
            }
    for line in markdown.splitlines():
        match = re.match(r"\s*[-*]\s+\*\*(.+?)\*\*:?\s*(.+?)\s*$", line)
        if not match:
            continue
        label = strip_tags(match.group(1)).strip().rstrip(":")
        text = strip_tags(match.group(2)).strip()
        if not label or not text:
            continue
        notes[norm(label)] = {"label": label, "text": text}
    for key, row in rows.items():
        for note_key, note in notes.items():
            candidates = [note_key] + [norm(part) for part in note["label"].split("/")]
            if any(key == cand or key.startswith(cand) for cand in candidates if cand):
                row["note_key"] = note_key
                break
    return rows, notes


def announcement_for(model_id):
    for item in ANNOUNCEMENTS:
        if norm(item["match"]) != norm(model_id):
            continue
        # A time-boxed announcement carries an 'ends' calendar day: once it has
        # passed, the item is skipped here, so a dead offer cannot render forever.
        ends = item.get("ends")
        if ends:
            try:
                if dt.date.fromisoformat(str(ends)) < dt.date.today():
                    continue
            except ValueError:
                pass
        return item
    return None


def build_model(model_id, docs, catalog, privacy=None, notes=None, releases=None, endpoint=None):
    entry = docs.get(norm(model_id))
    catalog_entry = catalog.get(model_id) or {}
    listed = (endpoint or {}).get(model_id)
    tier = default_tier(entry) if entry else {}
    record = {
        "id": model_id,
        "name": (entry or {}).get("name") or catalog_entry.get("name") or model_id,
        "input": tier.get("input"),
        "output": tier.get("output"),
        "cache_read": tier.get("cache_read"),
        "cache_write": tier.get("cache_write"),
        "monthly_usd": (entry or {}).get("monthly_usd"),
        "monthly_before_usd": (entry or {}).get("monthly_before_usd"),
        "monthly_by_plan": None,
        "req_5h": (entry or {}).get("req_5h"),
        "req_week": (entry or {}).get("req_week"),
        "req_month": (entry or {}).get("req_month"),
        "context": (listed or {}).get("context") or catalog_entry.get("context"),
        # models.dev registry release date, null when the registry has none: the
        # key is always present so the payload shape stays stable.
        "released": release_for(model_id, releases or {}) or (listed or {}).get("released"),
        # The per-model badge carries the SAME expiry gate as the top-of-page
        # promo list: a label whose end date has passed ships as None here, so a
        # dead offer cannot survive as a row badge either. A label with no
        # recognisable end date is still treated as live (see promo_end_date).
        "promo": _live_promo((entry or {}).get("promo")),
        "in_docs": bool(entry),
        "price_source": "docs",
        "catalog": {
            "input": catalog_entry.get("input"),
            "output": catalog_entry.get("output"),
            "cache_read": catalog_entry.get("cache_read"),
        },
        "price_check": price_check(tier, catalog_entry),
        "tiers": [
            {
                "label": alt.get("variant"),
                "input": alt.get("input"),
                "output": alt.get("output"),
                "cache_read": alt.get("cache_read"),
                "cache_write": alt.get("cache_write"),
            }
            for alt in (alternate_tiers(entry) if entry else [])
        ],
    }
    if listed:
        # The model list API is OpenCode's own per-model record: it outranks the
        # docs tables (when the page has any) and the catalog.
        record.update({field: listed.get(field) for field in ("input", "output", "cache_read", "cache_write")})
        record.update({
            "name": listed.get("name") or record["name"],
            "price_source": "api",
            "price_check": price_check(listed, catalog_entry),
        })
        if listed.get("tiers"):
            record["tiers"] = listed["tiers"]
        usage = listed.get("monthly_usage") or {}
        record["monthly_by_plan"] = usage or None
        if usage.get("go") is not None:
            record["monthly_usd"] = usage["go"]
            record["monthly_before_usd"] = None
            record["cap_source"] = "api"
    elif not entry and catalog_entry:
        # The docs have no row yet: price it from the live catalog and say so.
        record.update({
            "input": catalog_entry.get("input"),
            "output": catalog_entry.get("output"),
            "cache_read": catalog_entry.get("cache_read"),
            "cache_write": catalog_entry.get("cache_write"),
            "price_source": "catalog",
            "price_check": None,
        })

    privacy = privacy or {}
    notes = notes or {}
    row = privacy.get(norm(model_id)) or privacy.get(norm(record["name"]))
    flags = listed or {}
    if row or flags.get("zdr") is not None:
        row = row or {}
        zdr = flags["zdr"] if flags.get("zdr") is not None else row.get("zdr")
        training = row.get("training")
        if flags.get("training") is not None:
            training = "used" if flags["training"] else "not_used"
        record["privacy"] = {
            "training": training,
            "retention": row.get("retention") or ("0 days" if zdr else "Not ZDR"),
            "zdr": zdr,
            "note_key": row.get("note_key"),
        }
    else:
        record["privacy"] = None

    announcement = announcement_for(model_id)
    record["announcement"] = None
    if announcement:
        record["announcement"] = {
            "note": announcement["note"],
            "source": announcement["source"],
            "date": announcement["date"],
            "ends": announcement.get("ends"),
            "cap_usd": announcement["cap_usd"],
        }
        if announcement["cap_usd"] is not None and record.get("cap_source") != "api":
            # Announced by OpenCode, not in the docs: take the cap and label it.
            record["monthly_usd"] = announcement["cap_usd"]
            record["monthly_before_usd"] = None
            record["cap_source"] = "announcement"
    if record.get("monthly_usd") is not None and not record.get("cap_source"):
        record["cap_source"] = "docs"
    return record


def sort_models(records):
    def key(record):
        cap = record.get("monthly_usd")
        published = record.get("in_docs") or record.get("price_source") == "api"
        return (0 if (published and cap is not None) else 1,
                -(cap or 0),
                str(record.get("name") or "").lower())
    return sorted(records, key=key)


def prune_spools():
    """Drop spool files older than SPOOL_TTL_S so a crashed run leaves no litter."""
    try:
        cutoff = time.time() - SPOOL_TTL_S
        for path in SPOOL_DIR.glob(SPOOL_PREFIX + "*" + SPOOL_SUFFIX):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                pass
    except OSError:
        pass


def write_spool(text):
    """Park a payload that does not fit in one stdout, and say how many slices it is.

    shell.exec hands the renderer only the LAST 4000 characters of stdout, so the
    gzipped form is the fallback; when even that is too long the text goes to a file
    NAMED FOR A HASH OF ITS OWN BYTES, and the plugin reads it back with
    `--part N --id <hex>`. The per-run name is what keeps two concurrent runs from
    overwriting each other's slices. Returns {"parts": N, "id": hex}, or None when
    the file cannot be written (the caller then says so instead of printing a
    payload that would arrive truncated).
    """
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]
    spool = SPOOL_DIR / (SPOOL_PREFIX + digest + SPOOL_SUFFIX)
    try:
        spool.parent.mkdir(parents=True, exist_ok=True)
        prune_spools()
        spool.write_text(text, encoding="utf-8")
    except OSError:
        return None
    return {"parts": (len(text) + SPOOL_PART_CHARS - 1) // SPOOL_PART_CHARS, "id": digest}


def print_part(index, spool_id):
    """Print slice `index` of the spooled payload: no newline, no decoration."""
    if not re.fullmatch(r"[0-9a-f]{16}", spool_id or ""):
        print(json.dumps({"ok": False, "error": "bad spool id"}, separators=(",", ":")))
        return 1
    path = SPOOL_DIR / (SPOOL_PREFIX + spool_id + SPOOL_SUFFIX)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        print(json.dumps({"ok": False, "error": "no spooled payload: %s" % exc}, separators=(",", ":")))
        return 1
    start = index * SPOOL_PART_CHARS
    sys.stdout.write(text[start:start + SPOOL_PART_CHARS])
    return 0


def emit(payload):
    """One line of JSON on stdout, small enough to survive the gateway.

    `shell.exec` hands the renderer only the LAST 4000 characters of stdout
    (tui_gateway/methods_tools.py), and the full catalog is ~24 KB, so a large
    payload travels gzipped and base64-encoded as {"ok":...,"gzip":"..."} and the
    plugin inflates it. Past STDOUT_HARD_LIMIT even that is too long: the text is
    spooled to a per-run file and announced as {"ok":...,"spool":{"parts":N,"id":hex}},
    which the plugin joins from N `--part N --id <hex>` calls. Small payloads stay
    plain JSON, which keeps the script usable straight from a terminal.
    """
    line = json.dumps(payload, separators=(",", ":"))
    if len(line) <= STDOUT_PLAIN_LIMIT:
        return line
    # GzipFile, not gzip.compress(mtime=...): the mtime keyword needs Python 3.8
    # and this script is documented as stdlib-only on any python3.
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as fh:
        fh.write(line.encode("utf-8"))
    packed = base64.b64encode(buf.getvalue()).decode("ascii")
    out = json.dumps({"ok": payload.get("ok"), "gzip": packed}, separators=(",", ":"))
    if len(out) <= STDOUT_HARD_LIMIT:
        return out
    spool = write_spool(out)
    if not spool:
        return json.dumps({"ok": False, "error": "payload too large to ship"}, separators=(",", ":"))
    return json.dumps(
        {"ok": payload.get("ok"), "spool": {"parts": spool["parts"], "id": spool["id"], "bytes": len(out)}},
        separators=(",", ":"),
    )


def main():
    errors = []
    endpoint, base, api_error, api_authed = api_models()
    if api_error:
        errors.append(api_error)

    markdown = ""
    try:
        markdown = fetch_docs()
    except (urllib.error.URLError, OSError) as exc:
        errors.append("docs page request failed: " + str(exc))

    docs = parse_docs(markdown) if markdown else {}
    privacy, privacy_notes = parse_privacy(markdown) if markdown else ({}, {})
    catalog, catalog_age, catalog_error = fetch_catalog()
    if catalog_error:
        errors.append(catalog_error)

    if endpoint:
        served = list(endpoint)
    else:
        # No API answer: fall back to the live catalog so the table still works.
        served = sorted(catalog)

    releases = registry_index()
    records = [
        build_model(model_id, docs, catalog, privacy, privacy_notes, releases, endpoint)
        for model_id in served
    ]
    served_keys = set(norm(model_id) for model_id in served)
    referenced_notes = set(
        record["privacy"]["note_key"]
        for record in records
        if record.get("privacy") and record["privacy"].get("note_key")
    )
    known_docs_keys = set(norm(k) for k in catalog)
    doc_only = [
        {
            "name": entry.get("name") or key,
            "monthly_usd": entry.get("monthly_usd"),
        }
        for key, entry in sorted(docs.items())
        if key not in served_keys and key not in known_docs_keys
    ]

    ok = bool(records)
    payload = {
        "ok": ok,
        "error": None if ok else (errors[0] if errors else "no model data"),
        "fetched_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "docs_url": DOCS_URL,
        "api_base": base,
        "plan": plan_info(markdown) if markdown else {},
        "promos": docs_promos(docs, served_keys=served_keys),
        "counts": {
            "served": len(records),
            "with_caps": len([r for r in records if r.get("monthly_usd") is not None]),
            "catalog_mismatch": len([r for r in records if r.get("price_check") == "differs"]),
            "price_from_catalog": len([r for r in records if r.get("price_source") == "catalog"]),
        },
        "models": sort_models(records),
        "announcements": [
            {
                "model_key": record["id"],
                "name": record.get("name"),
                "note": record["announcement"]["note"],
                "source": record["announcement"]["source"],
                "date": record["announcement"]["date"],
                "ends": record["announcement"].get("ends"),
                "cap_usd": record["announcement"]["cap_usd"],
            }
            for record in sort_models(records)
            if record.get("announcement")
        ],
        "privacy_notes": [
            {"key": key, "label": note["label"], "text": note["text"]}
            for key, note in sorted(privacy_notes.items())
            if key in referenced_notes
        ],
        "docs_only": doc_only,
        "sources": {
            "api": bool(endpoint),
            # False when the list is the public one (no key, or the keyed request
            # failed), so it may include models this workspace cannot use.
            "api_keyed": api_authed,
            "docs": bool(markdown),
            "catalog": bool(catalog),
            "catalog_age_s": round(catalog_age, 1) if catalog_age is not None else None,
        },
        "errors": errors,
    }
    print(emit(payload))


if __name__ == "__main__":
    try:
        # `--part N` reads back a spooled payload (see emit) and never touches the
        # network, so it must not go through main().
        if len(sys.argv) > 2 and sys.argv[1] == "--part":
            spool_id = sys.argv[4] if len(sys.argv) > 4 and sys.argv[3] == "--id" else ""
            sys.exit(print_part(int(sys.argv[2]), spool_id))
        main()
    except Exception as exc:   # a traceback leaves the plugin with no JSON at all
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}))

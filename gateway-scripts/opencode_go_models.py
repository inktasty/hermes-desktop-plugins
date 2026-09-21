#!/usr/bin/env python3
"""OpenCode Go model list + prices + monthly caps, for the desktop usage plugin.

Three sources, merged into ONE line of JSON on stdout:

  1. GET {GO_BASE}/models          -- the models THIS key is served (the authoritative list)
  2. https://opencode.ai/docs/go.md -- per-model prices, monthly caps, estimated request
     counts, tier notes (peak/off-peak, >256K) and any promotion labels
  3. https://models.opencode.ai/api.json -- the live catalog, used to cross-check (2)'s
     prices and to price models (2) has not listed yet. Cached on disk with a 12h TTL and
     ETag revalidation; falls back to the stale cache, then to the models.dev registry
     cache, when the network is down.

Never prints credentials. Always prints parseable JSON, even on partial failure.
Stdlib only. Usage:  python3 opencode_go_models.py
"""

import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
ENV_FILE = HERMES_HOME / ".env"
CATALOG_CACHE = HERMES_HOME / "cache" / "opencode_go_catalog.json"
REGISTRY_CACHE = HERMES_HOME / "models_dev_cache.json"

DEFAULT_GO_BASE = "https://opencode.ai/zen/go/v1"
DOCS_URL = "https://opencode.ai/docs/go"
DOCS_MD = "https://opencode.ai/docs/go.md"
CATALOG_URL = "https://models.opencode.ai/api.json"
CATALOG_TTL_S = 12 * 3600
HTTP_TIMEOUT = 25
# opencode.ai answers 403 to a default Python-urllib user agent (verified 2026-09-21),
# and the docs ask clients to identify themselves, so send a real name.
USER_AGENT = "hermes-desktop-plugin/1.0 (+https://hermes-agent.nousresearch.com)"

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
        for line in ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, raw = line.split("=", 1)
            if key.strip() == name:
                return raw.strip().strip("'\"")
    except OSError:
        return ""
    return ""


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
    """[{id}] the key is served, plus the base URL it came from."""
    base = (env_value("OPENCODE_GO_BASE_URL") or DEFAULT_GO_BASE).rstrip("/")
    key = env_value("OPENCODE_GO_API_KEY")
    if not key:
        return None, base, "no OPENCODE_GO_API_KEY in the gateway .env"
    try:
        raw, _ = http_get(base + "/models", {"Authorization": "Bearer " + key})
        payload = json.loads(text_of(raw))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return None, base, "model list request failed: " + str(exc)
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return None, base, "model list response had no data array"
    ids = [str(item.get("id")) for item in data if isinstance(item, dict) and item.get("id")]
    if not ids:
        return None, base, "model list was empty"
    return sorted(ids), base, None


def fetch_catalog():
    """{model_id: {input, output, cache_read, cache_write, context, name}} + age."""
    cached = None
    try:
        cached = json.loads(CATALOG_CACHE.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        cached = None
    age = None
    if isinstance(cached, dict) and isinstance(cached.get("models"), dict):
        age = time.time() - float(cached.get("fetched_at", 0) or 0)

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
            return cached["models"], age, None
        reason = "catalog request failed: HTTP " + str(exc.code)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        reason = "catalog request failed: " + str(exc)

    if isinstance(cached, dict) and isinstance(cached.get("models"), dict):
        return cached["models"], age, reason
    return registry_fallback(), None, reason


def registry_fallback():
    """models.dev registry cache, the same file model_price_lookup.py reads."""
    try:
        cache = json.loads(REGISTRY_CACHE.read_text(encoding="utf-8", errors="replace"))
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


def docs_promos(docs):
    """Model-level promotions the docs label, e.g. '4x · Ends Sep 27'."""
    promos = []
    for key, entry in docs.items():
        label = entry.get("promo")
        if not label:
            continue
        promos.append({
            "model_key": key,
            "name": entry.get("name") or key,
            "label": label,
            "monthly_usd": entry.get("monthly_usd"),
            "monthly_before_usd": entry.get("monthly_before_usd"),
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
    five = re.search(r"5-hour\s*(?:—|-|:)\s*(\d+)% of the monthly limit", text)
    weekly = re.search(r"weekly\s*(?:—|-|:)\s*(\d+)%", text)
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


def build_model(model_id, docs, catalog):
    entry = docs.get(norm(model_id))
    catalog_entry = catalog.get(model_id) or {}
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
        "req_5h": (entry or {}).get("req_5h"),
        "req_week": (entry or {}).get("req_week"),
        "req_month": (entry or {}).get("req_month"),
        "context": catalog_entry.get("context"),
        "promo": (entry or {}).get("promo"),
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
    if not entry and catalog_entry:
        # The docs have no row yet: price it from the live catalog and say so.
        record.update({
            "input": catalog_entry.get("input"),
            "output": catalog_entry.get("output"),
            "cache_read": catalog_entry.get("cache_read"),
            "cache_write": catalog_entry.get("cache_write"),
            "price_source": "catalog",
            "price_check": None,
        })
    return record


def sort_models(records):
    def key(record):
        cap = record.get("monthly_usd")
        return (0 if (record.get("in_docs") and cap is not None) else 1,
                -(cap or 0),
                str(record.get("name") or "").lower())
    return sorted(records, key=key)


def main():
    errors = []
    ids, base, api_error = api_models()
    if api_error:
        errors.append(api_error)

    markdown = ""
    try:
        raw, _ = http_get(DOCS_MD)
        markdown = text_of(raw)
    except (urllib.error.URLError, OSError) as exc:
        errors.append("docs page request failed: " + str(exc))

    docs = parse_docs(markdown) if markdown else {}
    catalog, catalog_age, catalog_error = fetch_catalog()
    if catalog_error:
        errors.append(catalog_error)

    if ids:
        served = ids
    else:
        # No key or no API answer: fall back to the live catalog so the table still works.
        served = sorted(catalog)

    records = [build_model(model_id, docs, catalog) for model_id in served]
    served_keys = set(norm(model_id) for model_id in served)
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
    print(json.dumps({
        "ok": ok,
        "error": None if ok else (errors[0] if errors else "no model data"),
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "docs_url": DOCS_URL,
        "api_base": base,
        "plan": plan_info(markdown) if markdown else {},
        "promos": docs_promos(docs),
        "counts": {
            "served": len(records),
            "with_caps": len([r for r in records if r.get("monthly_usd") is not None]),
            "catalog_mismatch": len([r for r in records if r.get("price_check") == "differs"]),
            "price_from_catalog": len([r for r in records if r.get("price_source") == "catalog"]),
        },
        "models": sort_models(records),
        "docs_only": doc_only,
        "sources": {
            "api": bool(ids),
            "docs": bool(markdown),
            "catalog": bool(catalog),
            "catalog_age_s": round(catalog_age, 1) if catalog_age is not None else None,
        },
        "errors": errors,
    }))


if __name__ == "__main__":
    main()

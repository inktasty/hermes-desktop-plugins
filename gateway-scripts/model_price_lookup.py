#!/usr/bin/env python3
"""Per-million-token rates for one provider/model, from Hermes's local models.dev cache.

Why this exists: Hermes' own usage estimator only prices providers in its bundled
official-docs table (plus OpenRouter + opencode's /models endpoint, which returns
403 for Go keys). OpenCode Go is not in that table, so `session.usage` reports no
cost for it. The registry Hermes already caches locally does carry the rates.

Usage:
    python3 model_price_lookup.py [model_id] [provider]

With no arguments, the model/provider from config.yaml (`model.default`,
`model.provider`) are used. Prints ONE line of JSON on stdout. Never prints
credentials.
"""

import json
import os
import re
import sys
from pathlib import Path
from typing import NoReturn

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
CACHE = HERMES_HOME / "models_dev_cache.json"
CONFIG = HERMES_HOME / "config.yaml"


def fail(reason: str) -> NoReturn:
    print(json.dumps({"ok": False, "error": reason}))
    raise SystemExit(0)


def config_model_provider() -> tuple:
    """Last-resort regex read of config.yaml's model block (stdlib only)."""
    model = provider = ""
    try:
        text = CONFIG.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return model, provider
    # The block may be the first thing in the file, so anchor on a line boundary.
    match = re.search(r"(?m)^model:[ \t]*$", text)
    if not match:
        return model, provider
    for line in text[match.end():].splitlines():
        if line.strip() and not line.startswith((" ", "\t")):
            break  # left the model block
        stripped = line.strip()
        if stripped.startswith("default:") and not model:
            model = stripped.split(":", 1)[1].strip().strip("'\"")
        elif stripped.startswith("provider:") and not provider:
            provider = stripped.split(":", 1)[1].strip().strip("'\"")
    return model, provider


def rates_for(cache: dict, provider: str, model: str) -> dict:
    entry = cache.get(provider)
    models = entry.get("models") if isinstance(entry, dict) else None
    if not isinstance(models, dict):
        return {}
    hit = models.get(model)
    if hit is None:
        # Tolerate date/snapshot suffixes: exact prefix match, shortest id wins.
        cands = [k for k in models if k.lower().startswith(model.lower()) or model.lower().startswith(k.lower())]
        if not cands:
            return {}
        hit = models[sorted(cands, key=len)[0]]
    cost = hit.get("cost") if isinstance(hit, dict) else None
    if not isinstance(cost, dict):
        return {}
    out = {}
    for key, aliases in (
        ("input", ("input", "input_tokens", "prompt")),
        ("output", ("output", "output_tokens", "completion")),
        ("cache_read", ("cache_read", "cache_read_tokens", "input_cache_read")),
        ("cache_write", ("cache_write", "cache_write_tokens")),
    ):
        for alias in aliases:
            value = cost.get(alias)
            if isinstance(value, (int, float)):
                out[key] = float(value)
                break
    return out


# Preference when the session's model is served by several catalog providers.
PROVIDER_PREFERENCE = ("opencode-go", "opencode-zen", "opencode", "openrouter", "deepseek", "nous")


def resolve_rates(cache: dict, provider: str, model: str) -> tuple:
    """(rates, provider_used). Falls back to whichever provider in the cache
    carries this model id, so a mid-session provider switch still prices."""
    rates = rates_for(cache, provider, model) if provider else {}
    if rates:
        return rates, provider
    ranked = sorted(
        (k for k in cache if isinstance(cache.get(k), dict)),
        key=lambda k: (PROVIDER_PREFERENCE.index(k) if k in PROVIDER_PREFERENCE else len(PROVIDER_PREFERENCE), k),
    )
    for candidate in ranked:
        if candidate == provider:
            continue
        rates = rates_for(cache, candidate, model)
        if rates:
            return rates, candidate
    return {}, provider


def main() -> None:
    argv = sys.argv[1:]
    model = (argv[0] if len(argv) > 0 else "").strip()
    provider = (argv[1] if len(argv) > 1 else "").strip()
    if not (model and provider):
        cfg_model, cfg_provider = config_model_provider()
        model = model or cfg_model
        provider = provider or cfg_provider
    if not (model and provider):
        fail("no model/provider given and none resolvable from config.yaml")
    if not CACHE.exists():
        fail(f"registry cache missing at {CACHE}")
    try:
        cache = json.loads(CACHE.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError) as exc:
        fail(f"cannot read registry cache: {exc}")

    rates, used = resolve_rates(cache, provider, model)
    if not rates:
        fail(f"no rates cached for {model} (tried provider {provider!r} and the rest of the registry)")
    print(json.dumps({
        "ok": True,
        "provider": used,
        "requested_provider": provider,
        "model": model,
        "unit": "usd_per_million_tokens",
        "source": "models.dev registry cache",
        **rates,
    }))


if __name__ == "__main__":
    main()

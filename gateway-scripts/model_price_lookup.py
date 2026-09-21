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

`released` is the matched registry entry's release_date, verbatim and
unformatted (null when the registry publishes none for it): the desktop panel
renders it without shifting the day. ok:true as soon as EITHER a cost card or a
release date resolved, so an entry with no cost dict still answers.
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


def entry_for(cache: dict, provider: str, model: str):
    """The registry ENTRY for this model under `provider`, or None.

    Callers want the entry itself, not only its cost card: the registry carries
    entries with a release_date and no cost dict at all, and those still answer
    with a date.
    """
    section = cache.get(provider)
    models = section.get("models") if isinstance(section, dict) else None
    if not isinstance(models, dict):
        return None
    hit = models.get(model)
    if hit is None:
        # Tolerate date/snapshot suffixes: exact prefix match, shortest id wins.
        cands = [k for k in models if k.lower().startswith(model.lower()) or model.lower().startswith(k.lower())]
        if not cands:
            return None
        hit = models[sorted(cands, key=len)[0]]
    return hit if isinstance(hit, dict) else None


def rates_of(hit) -> dict:
    """The cost keys of one registry entry, {} when it publishes none."""
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


def released_of(hit):
    """The entry's release_date exactly as the registry publishes it, or None.

    A bare 'YYYY-MM-DD' string: never reformatted here, never defaulted to a
    made-up date. The display layer formats it without shifting the day.
    """
    value = hit.get("release_date") if isinstance(hit, dict) else None
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def rates_for(cache: dict, provider: str, model: str) -> dict:
    """Cost keys for one model under one provider, {} when there are none."""
    return rates_of(entry_for(cache, provider, model))


# Preference when the session's model is served by several catalog providers.
PROVIDER_PREFERENCE = ("opencode-go", "opencode-zen", "opencode", "openrouter", "deepseek", "nous")


def resolve_lookup(cache: dict, provider: str, model: str) -> tuple:
    """(rates, released, provider_used) for one model.

    The session's own provider wins when it carries the id, even if that entry
    publishes no cost (its date still answers). Otherwise the registry is
    searched in PROVIDER_PREFERENCE order, preferring a provider that also
    prices the model. `provider_used` is where the entry came from.
    """
    hit = entry_for(cache, provider, model) if provider else None
    used = provider
    if hit is None:
        ranked = sorted(
            (k for k in cache if isinstance(cache.get(k), dict)),
            key=lambda k: (PROVIDER_PREFERENCE.index(k) if k in PROVIDER_PREFERENCE else len(PROVIDER_PREFERENCE), k),
        )
        found = []
        for candidate in ranked:
            if candidate == provider:
                continue
            other = entry_for(cache, candidate, model)
            if other is not None:
                found.append((candidate, other))
        priced = next((pair for pair in found if rates_of(pair[1])), None)
        chosen = priced or (found[0] if found else None)
        if chosen:
            used, hit = chosen
    if hit is None:
        return {}, None, provider
    return rates_of(hit), released_of(hit), used


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

    rates, released, used = resolve_lookup(cache, provider, model)
    # ok:true when EITHER a cost card or a release date resolved. Only a model
    # the registry does not know at all is a failure.
    if not rates and released is None:
        fail(f"no registry entry for {model} (tried provider {provider!r} and the rest of the registry)")
    print(json.dumps({
        "ok": True,
        "provider": used,
        "requested_provider": provider,
        "model": model,
        "unit": "usd_per_million_tokens",
        "source": "models.dev registry cache",
        # The matched entry's release_date, verbatim; null when it has none.
        "released": released,
        **rates,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()

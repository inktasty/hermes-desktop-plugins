# Hermes desktop plugins: DeepSeek Rate, OpenCode Go Usage, Session Usage

Three single-file plugins for the [Hermes desktop app](https://hermes-agent.nousresearch.com/docs).
No build step: each is one plain-JavaScript ESM file the app loads and hot-reloads
from disk.

| Plugin | Adds |
| --- | --- |
| `deepseek-rate` | A status-bar chip showing whether DeepSeek is billing peak (2x) or off-peak right now, in the viewer's own clock. Colors only while a DeepSeek model is active in the focused session. |
| `opencode-usage` | A status-bar chip plus a full page: the three OpenCode Go quota windows (5-hour, weekly, monthly) with usage vs. time-elapsed gauges, pace projections, reset countdowns, a Console button, and a models table with per-model prices, caps, promotions, and registry release dates. |
| `session-usage` | A status-bar chip showing the focused session's cost, with a hover panel of tokens, cache-hit rate, API calls, context use, the model's registry release date, and the current model's per-1M-token rates. |

## Requirements

- The Hermes desktop app, build of upstream commit `6c3d4a4af70` or later.
  Older builds fail every disk plugin with
  `TypeError: Cannot convert undefined or null to object`.
- A Hermes gateway the app is connected to (the plugins use gateway RPCs, and
  they never hold your API keys themselves).
- For `opencode-usage` only: an OpenCode Go subscription with its API key in the
  gateway's `.env` as `OPENCODE_GO_API_KEY`.

## Install

```bash
git clone https://github.com/inktasty/hermes-desktop-plugins
cd hermes-desktop-plugins
./install.sh                      # gateway home defaults to ~/.hermes
./install.sh /path/to/desktop-plugins   # ...or point it straight at the app folder
```

`install.sh` copies the plugins into the app's `desktop-plugins/` folder, copies
the three gateway scripts into `$HERMES_HOME/scripts/`, rewrites the script
paths inside the plugins to match your gateway home, and (when `config.yaml`
exists and `hermes` is on PATH) sets `terminal.env.HERMES_DEV_CREDITS=1` so the
billed-spend row appears in `session-usage`.

Where the plugin folder lives: **on the machine running the app**, not the
gateway.

| App runs on | Folder |
| --- | --- |
| Linux / macOS | `~/.hermes/desktop-plugins/<id>/plugin.js` |
| Windows | `%LOCALAPPDATA%\hermes\desktop-plugins\<id>\plugin.js` |

With a remote gateway (Windows app, Linux gateway) that means the Windows side.
The folder name must match the plugin's `id`.

A brand-new plugin folder is not always noticed by a running app. If a chip
does not appear, run **Reload desktop plugins** from the command palette (⌘K /
Ctrl+K). Editing a file inside an already-loaded plugin hot-reloads in seconds.

### No manual path edits needed

`install.sh` replaces the script directory token in the plugins with your
gateway's scripts path, so after running it there is nothing to edit. The
interpreter itself is detected at runtime: the plugin tries `python3`, then
`python`, then `py -3`, and caches the first one that works. That makes a
Windows-hosted gateway work even though `python3` there is usually the dead
Microsoft Store alias: the plugin falls back to the real `python` or `py -3`
automatically.

## How the pricing estimate works

Hermes' own cost estimator (`agent/usage_pricing.py`) only prices providers in
its bundled official-docs table plus OpenRouter, so `session.usage` reports no
cost for providers like `opencode-go`. `session-usage` fills the gap:

1. Exact billed spend wins when the backend reports it
   (`dev_credits_spent_micros`), labeled "Session cost".
2. Otherwise `gateway-scripts/model_price_lookup.py` reads rates from the
   gateway's local models.dev registry cache (`~/.hermes/models_dev_cache.json`)
   and the chip shows an estimate, labeled "(est.)".

Two things worth knowing about the estimate:

- **Peak doubles it, for DeepSeek models only.** DeepSeek bills peak at exactly
  2x off-peak, 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday; weekends and
  every other hour are off-peak. The registry lists the off-peak card, so the
  plugin multiplies by 2 inside those windows. It gates that on both the model
  slug and the provider, so a non-DeepSeek model on the same provider is never
  doubled. Source: <https://api-docs.deepseek.com/quick_start/pricing>
- **If your provider's catalog does not carry the model slug**, the lookup falls
  back to whichever catalog provider does, and the panel says which card it
  used ("Estimated at &lt;provider&gt; / &lt;model&gt; rates"). That is the one
  place the estimate can be off.

`deepseek-rate` needs no network at all: the tier is a pure function of the UTC
clock, and the tooltip renders the peak windows in whatever timezone you are in.

## Verify before trusting it

`verify/` is an offline harness: stub `@hermes/plugin-sdk` and React modules,
the real plugin files imported as-is, a mini renderer, and a hook-count oracle
that fails if a component ever calls a different number of hooks between
renders (the React #310 trap). Its fixtures are synthetic and generated relative
to the current clock, so nothing goes stale and no account data is involved.

```bash
cd verify
PLUGIN_SRC=../desktop-plugins node harness.mjs

# On Windows (PowerShell):
$env:PLUGIN_SRC='../desktop-plugins'; node harness.mjs
```

It also sweeps all 192 hours of an 8-day window against an independently
written peak-tier oracle and checks the tooltip against the viewer's own
timezone, so run it under more than one `TZ` to see the tooltip follow the zone.

To confirm a plugin really loaded in a running app, the app's log is the only
remote-visible proof: `%LOCALAPPDATA%\hermes\logs\desktop.log` on Windows,
lines tagged `[plugins]`. A successful load is silent; `runtime load failed
(<id>)` means it never registered.

## Adding another plugin here

New plugins for this set land in the same shape: `desktop-plugins/<id>/plugin.js`
with the folder name equal to the plugin's `id`, a row in the table above, an
entry in the `PLUGIN_IDS` list at the top of `install.sh` when it needs
installing, and a `verify/harness.mjs` case asserting what it must get right.
Keep the harness green under at least two `TZ` values before publishing.

## Credits

Shared as-is under the MIT license. The DeepSeek peak windows and rates are
DeepSeek's published table.

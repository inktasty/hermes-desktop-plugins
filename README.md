# Hermes desktop plugins: DeepSeek Rate, OpenCode Go Usage, Session Usage

Three single-file plugins for the [Hermes desktop app](https://hermes-agent.nousresearch.com/docs).
No build step: each is one plain-JavaScript ESM file the app loads and hot-reloads
from disk.

| Plugin | Adds |
| --- | --- |
| `deepseek-rate` | A status-bar chip showing whether DeepSeek is billing peak (2x) or off-peak right now, in the viewer's own clock. Colors only while a DeepSeek model is active in the focused session. |
| `opencode-usage` | A status-bar chip plus a full page: the three OpenCode Go quota windows (5-hour, weekly, monthly) with usage vs. time-elapsed gauges, pace projections, reset countdowns, a Console button, and a models table with per-model prices, caps, promotions, and registry release dates. More than one OpenCode Go key on the gateway — a credential pool with a second key — gets its own set of windows per key. A key the pool has benched (`exhausted`, `invalid`, ...) is folded to one line with a chevron and its own used-share; click it to unfold that key's windows. Keys are numbered by position (`Key 1`, `Key 2`) instead of carrying whatever name the gateway config happens to use, and the chip says which one it is reporting: `Go (2/2) 16/9/9%`. A **Settings** section on the page chooses what the chip reports (the key in use, the combined pool, or one specific key) along with the refresh interval, the amber threshold, and whether the gateway's own credential names are shown. |
| `session-usage` | A status-bar chip showing the focused session's cost, with a hover panel of tokens, cache-hit rate, API calls, context use, the model's registry release date, and the current model's per-1M-token rates. |

## Requirements

- The Hermes desktop app, build of upstream commit `6c3d4a4af70` or later.
  Older builds fail every disk plugin with
  `TypeError: Cannot convert undefined or null to object`.
- A Hermes gateway the app is connected to (the plugins use gateway RPCs, and
  they never hold your API keys themselves).
- For `opencode-usage` only: an OpenCode Go subscription, with the key(s)
  reachable by the gateway — in `.env` as `OPENCODE_GO_API_KEY` (extra keys as
  `OPENCODE_GO_API_KEY_2`, `_3`, ...), or in the gateway's credential pool.
  More than one key is fine: each key is reported on its own, whatever it is
  named.

## Install

Easiest path: paste this one line into your Hermes agent and it does the whole
thing.

```text
Install the desktop plugins in https://github.com/inktasty/hermes-desktop-plugins: clone the repo, follow its README, run ./install.sh (pass HERMES_HOME if the gateway home is not the default: ~/.hermes, or %LOCALAPPDATA%\hermes on a Windows gateway) so the plugins point at the gateway's scripts and land in the desktop-plugins folder on the machine running the app, then reload desktop plugins and confirm all three loaded.
```

By hand instead:

```bash
git clone https://github.com/inktasty/hermes-desktop-plugins
cd hermes-desktop-plugins
./install.sh                      # gateway home defaults to ~/.hermes (Windows: %LOCALAPPDATA%\hermes)
./install.sh /path/to/desktop-plugins   # ...or point it straight at the app folder
```

`install.sh` copies the plugins into the app's `desktop-plugins/` folder, copies
the three gateway scripts into `$HERMES_HOME/scripts/`, and rewrites the script
paths inside the plugins to match your gateway home. It writes no config and
changes no setting on your gateway. The one optional setting is described under
[Optional: exact billed spend](#optional-exact-billed-spend).

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

### Deploying to the app machine (remote gateway)

When the app's gateway is remote from the app (the app on Windows, the gateway
elsewhere), install on each machine from its own clone of the repo.

**1. On the gateway machine**, install the gateway scripts:

```bash
./install.sh                          # gateway home ~/.hermes (Windows: %LOCALAPPDATA%\hermes)
HERMES_HOME=/opt/hermes ./install.sh  # ...or a non-default gateway home
```

This copies the three scripts into `$HERMES_HOME/scripts/` and prints that path
(`installed gateway scripts -> ...`); it is the `-ScriptsDir` for step 2. It also
copies the plugins into the gateway machine's own `desktop-plugins/` folder
(`~/.hermes/desktop-plugins/`, or `%LOCALAPPDATA%\hermes\desktop-plugins\` on
Windows), which nothing reads unless an app runs there too.

**2. On the app machine**, deploy the plugins pointed at the gateway's scripts:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy-windows.ps1 -ScriptsDir /opt/hermes/scripts
```

It replaces `__HERMES_SCRIPTS__` with the **gateway's** scripts path. That path
lives on the gateway, not on this machine, so the script will not invent one:
pass `-ScriptsDir`, or set `HERMES_HOME` in the same shell (when that really is
the gateway home) and it is derived from that. A wrong value does not fail at
deploy time -- it surfaces later as a "no working python on the gateway shell"
chip error -- so the run prints the path it baked in; confirm
`<that path>/opencode_go_usage.py` exists on the gateway. Files already
identical are left alone and printed as `unchanged`.

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
   gateway's local models.dev registry cache (`models_dev_cache.json` in the gateway
   home: `~/.hermes/`, or `%LOCALAPPDATA%\hermes\` on a Windows gateway)
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

### Session Usage: when a value shows `—`

The chip itself says `usage`, not `—`, when no cost is available; dashes appear
in its hover panel. Zero tokens with usable rates show `$0.00`, not a dash.

| The panel shows `—` when… | What to do |
| --- | --- |
| No session data has arrived (the panel says "No turns yet", rather than showing a cost row). | Focus a session, send a message, then click the chip or wait for the next poll. If polling fails, check the gateway connection: `session.stats` falls back to `session.usage`, and live usage can still update the panel. |
| **Session cost (est.)** has neither billed spend nor an estimate: rates are still loading or do not match the session's model/provider. | Click the chip or wait for the next poll. A previously accumulated estimate can remain visible while rates are unavailable. |
| The pricing script fails, leaving no estimate. | Read the panel's error; re-run `install.sh` on the gateway for missing scripts, redeploy app-side plugins with the correct gateway script path, and check gateway Python / `shell.exec`. For a missing or unreadable models.dev cache, restore the gateway's cache, then click the chip to retry. |
| The registry has no matching model or no usable input/output prices, leaving no estimate. | Check the session's model/provider and update the gateway's models.dev cache if stale. No plugin reload is needed: once a successful lookup is six hours old, the next poll or chip click refreshes it. The panel keeps showing the last rate card while the refresh is pending. Unpublished prices cannot be estimated. An unknown provider alone is not fatal: other provider catalogs are searched. |
| **Released** has no valid registry date (for example, before the first lookup completes or after a lookup fails). | Wait for lookup or resolve its error. If the registry publishes no date, no action is needed; sending a message cannot supply one. |
| A per-token rate is non-finite after rate calculation. | Check the registry rate data; this is not a zero price. Normally incomplete rate cards are hidden entirely. |

### Optional: exact billed spend

The "Session cost" row shows the provider's real billed amount only when both of
these are true: the **gateway** process runs with `HERMES_DEV_CREDITS=1`, and the
focused session is routed through **Nous's own API**, because the figure arrives as
response headers from Nous. A session on any other provider (OpenCode Go, xAI,
OpenRouter) never carries it, so its row stays an estimate no matter what the flag
says.

Nothing enables the flag for you, and that is deliberate: the field is a development
readout that upstream gates on purpose, and while the flag is on the gateway logs a
credits line for every response. Turn it on only if both conditions above are true
for you.

The flag has to reach the gateway process, which reads its own environment, so the
gateway's `.env` is the reliable place: `$HERMES_HOME/.env`, which by default is
`~/.hermes/.env` for whoever runs the gateway, or `%LOCALAPPDATA%\hermes\.env` on
a Windows gateway (falling back to `~\AppData\Local\hermes\.env` when
`LOCALAPPDATA` is unset):

```bash
echo 'HERMES_DEV_CREDITS=1' >> ~/.hermes/.env
hermes gateway restart   # a running process only picks it up at startup
```

A service unit's own `Environment=` line works the same way. There is no `config.yaml`
setting for it: the flag is read from the gateway process's environment, so
`hermes config set` cannot reach it.

Without the flag the row is labeled "Session cost (est.)" and shows the estimate
described above, which works on every provider.

## Uninstall

`uninstall.sh` is the inverse of `install.sh`: it removes each plugin's `plugin.js`
from the app's `desktop-plugins/` directory, plus the plugin folder once it is
empty, and the three scripts from the gateway's `scripts/` directory. It writes no
config and touches nothing else: a plugin folder holding other files is kept.

```bash
./uninstall.sh                      # app plugin folder defaults per-OS
./uninstall.sh /path/to/desktop-plugins
HERMES_HOME=/opt/hermes ./uninstall.sh
```

It removes only the app-side plugin files and the gateway scripts it installed; a
chip disappears after **Reload desktop plugins** from the command palette.

With a remote gateway, run it on each machine, from that machine's clone:

- **Gateway machine:** `./uninstall.sh` (or `HERMES_HOME=/opt/hermes ./uninstall.sh`)
  removes the scripts, plus the plugin copies `install.sh` left there.
- **App machine (Windows):** `./uninstall.sh` from Git Bash removes the plugin
  files under `%LOCALAPPDATA%\hermes\desktop-plugins\`; its gateway-script
  lines print `absent`, since the scripts live on the gateway. Without Git Bash,
  delete `plugin.js` from the three `<id>` folders there by hand.

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

The isolated real-React lifecycle tier runs effects, atom subscriptions, state updates and cleanup in jsdom (also in CI): `cd verify/react-tier && npm ci && TZ=UTC node run.mjs` (Node 22.22.2+).

It also sweeps all 192 hours of an 8-day window against an independently
written peak-tier oracle and checks the tooltip against the viewer's own
timezone, so run it under more than one `TZ` to see the tooltip follow the zone.

To confirm a plugin really loaded in a running app, the app's log is the only
remote-visible proof: `%LOCALAPPDATA%\hermes\logs\desktop.log` on Windows,
lines tagged `[plugins]`. A successful load is silent; `runtime load failed
(<id>)` means it never registered.

## Contributing a plugin

Pull requests are welcome. A plugin lands in the same shape as the three here, and
the shape is what keeps them cheap to load:

- `desktop-plugins/<id>/plugin.js`, one file, no build step, the folder name equal
  to the plugin's `id`.
- A row in the table at the top of this README saying what it adds.
- An entry in `PLUGIN_IDS` in `install.sh` if it needs installing there.
- A case in `verify/harness.mjs` that asserts what it must get right. The harness
  and the class audit are the review, and `.github/workflows/ci.yml` runs both
  (the harness under three `TZ` values) plus the `gateway-scripts` unit tests.

Two things that bite every new plugin, both learned the hard way:

1. **The app only compiles the CSS classes its own source uses.** A Tailwind class
   that appears nowhere in the app does nothing at all, silently, which is how a
   raised footnote mark and a full-width table divider went missing. Use inline
   styles for anything the app might not already use, and run
   `node verify/class-audit.mjs` before opening a PR.
2. **A plugin folder is not always noticed by a running app.** Reload desktop
   plugins from the command palette after adding one.

Run the harness under at least two `TZ` values before opening a PR. A date that looks
right in one zone and lands a day early in another is the bug that ships.

## Credits

Shared as-is under the MIT license. The DeepSeek peak windows and rates are
DeepSeek's published table.

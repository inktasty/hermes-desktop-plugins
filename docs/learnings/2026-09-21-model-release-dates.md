# Model release dates: UTC dates, cost-less registry entries, a flaky harness wait

Date: 2026-09-21. Card t_1c988529: show a model's release date in the session-usage
hover panel and as a column in the opencode-usage models table.

## What landed

- `model_price_lookup.py` prints `released` (the matched entry's verbatim
  `release_date`, null when it has none).
- `opencode_go_models.py` adds `released` to every record, matched by a normalized
  id (lowercase, non-alphanumerics stripped) across all providers: `opencode-go`
  section first, then an exact id, then the earliest date.
- The plugins render it `Sep 22, 2026` from a regex. NOTE: the same day, commit
  575699a reversed the timezone rule that this note first recorded. Read the
  comments above `fmtReleaseDate` in either plugin as the authority, not the
  pitfall below.

## Pitfalls worth remembering

1. **A bare `YYYY-MM-DD` is ambiguous, and the rule changed the same day.**
   Passing it through `new Date()` parses it as UTC midnight, so a local formatter
   west of UTC (America/Phoenix, UTC-7) renders the PREVIOUS day, which for a
   same-day release (`mimo-v2.6-flash` = `2026-09-22`) looked wrong. The first fix
   was a month table that printed the string as published. Commit 575699a then
   reversed that on purpose: Luke wants the release date on the viewer's own
   clock, so `2026-09-22` intentionally shows as Sep 21, 2026 here. What matters
   for the next reader is not which rule is "right" but that the two date kinds
   are different and have different formatters: a registry date is a UTC instant
   rendered on the viewer's clock (`fmtReleaseDate`), while a stated calendar date
   such as an announcement or promo end date is the day it names
   (`fmtCalendarDate`, which must not shift).
2. **The registry holds entries with a `release_date` and no `cost` dict** (419
   today). The old `rates_for()` returned only cost keys and `{}` for those, and
   `main()` failed when rates were empty, so the panel showed a python error where
   a date belonged. Resolve the ENTRY, read cost and date off it, and treat
   "either resolved" as success.
3. **`HERMES_HOME` decides which `models_dev_cache.json` is read.** The gateway
   service (`Environment=HERMES_HOME=/home/ubuntu/.hermes`) is the live cache core
   refreshes every 4h; a per-profile home has its own stale copy (the coder
   profile's was 8 days old) and reads as "no registry entry". Print the resolved
   cache path first when a date goes missing.
4. **Scale check is cheap**: 223 providers, 7950 entries, all with `release_date`.

## Harness race (pre-existing)

`verify/harness.mjs` fired the models fetch fire-and-forget (like the app) and then
waited a FIXED count of event-loop turns; the gzip+base64 inflate resolves on its
own schedule, so "gzipped catalog inflates..." and "truncated catalog says why"
failed intermittently — reproduced on the pre-change tree, so not from this
feature. Replaced with a bounded `waitForText(render, /expected/)` poll.

## Verification

`TZ=UTC` and `TZ=America/Phoenix` harness runs were green, 0 failed. `e2e-real2.mjs`
against the live gateway scripts: 32 of 33 served rows dated (one model is absent
from the registry). All 39 `opencode-go` registry ids resolve; the live `/models`
call currently serves 33 of them, so the card's "39" is the section size, not
today's served list.

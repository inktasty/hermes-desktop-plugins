# muse-spark-1.3-contributor-free review of hermes-desktop-plugins

Run: 2026-10-11, inside `oc-sbx` (OpenCode v2.0.27, read-only mount, locked policy,
no shell/webfetch), free Zen model `opencode/muse-spark-1.3-contributor-free`.
Prompt: prioritized general improvements (correctness, UX, packaging, tests).
Unverified model output: treat every line as a lead to check, not a fact.

## P0 - correctness risks

1. `desktop-plugins/session-usage/plugin.js:591` - hard-coded `area: 'statusBar.right'`.
   Other plugins use `STATUSBAR_AREAS.right`. Import the constant; the string literal
   breaks silently on rename.
2. `desktop-plugins/opencode-usage/plugin.js:1624,1664` - `execScript` builds `suffix` by
   raw join (`' ' + a`). Only internal `'--part','N'` today, but unquoted and unvalidated.
   Validate `args` against `/^[\w-]+$/` or shellQuote each arg.
3. `gateway-scripts/opencode_go_models.py:675-701` - `SPOOL_FILE` is a single shared path
   with no lock, no generation id, no cleanup. Concurrent `main()` rewrite during plugin
   `--part` reads gives torn joins. Write to temp + atomic rename, or embed a token in the
   spool descriptor and verify it on `--part`.
4. `desktop-plugins/session-usage/plugin.js:479-487,213-235` - `trackCost` prices with
   whatever `ratesData.get()` holds; the `ratesFor` guard lives only in `loadRates`. A model
   switch between fetch and pricing charges tokens to the wrong card. Pass rates explicitly,
   or check `rates.model === usage.model` before `accumulate`. Also `Math.max(0, now-base)`
   silently drops tokens on a counter reset (gateway restart): detect `now << base` and
   re-baseline.
5. `gateway-scripts/model_price_lookup.py:72-78` - `entry_for` prefix-matches in both
   directions, shortest wins, so `gpt` can match an unrelated snapshot. Prefer exact match
   and fall back only with an explicit `fallback: true` flag so the panel can label it.
6. `gateway-scripts/opencode_go_usage.py:102-122` - heartbeat log read-modify-write with no
   lock; two concurrent polls can interleave or truncate. Append-only + external logrotate,
   or lock/atomic replace.
7. `gateway-scripts/opencode_go_models.py:60-75` - `ANNOUNCEMENTS` hard-codes X posts with no
   expiry (`mimo-v2.6-flash` "Free for one week", dated 2026-09-21). Stale promo renders
   forever. Add `expires` and drop expired entries, or source caps from docs only.

## P1 - packaging / install friction

8. `install.sh` vs `deploy-windows.ps1` divergence: the ps1 has `-Only`, unchanged-skip,
   SHA256 print, CRLF->LF normalize (`deploy-windows.ps1:63-69,93-115`); `install.sh:52-57`
   always overwrites, no hash, no `-Only`, no CRLF handling. Port idempotence + hash +
   single-plugin mode to `install.sh`.
9. `install.sh:68-87` - placeholder rewrite verified by `grep`, but the failure message says
   "edit by hand" with no backup. Keep a `.bak` or print a diff; add `--dry-run` and a
   preflight (python3 on gateway, `OPENCODE_GO_API_KEY` set, scripts reachable).
10. `README.md:28-33` - the one-line agent install prompt clones `main` unpinned. Pin a tag
    or commit for reproducibility.
11. Repo hygiene: tracked `*.bak-*`, `verify/*.plugin.*.js`, `verify/opencode-usage.e2e.gen.js`,
    `gateway-scripts/__pycache__/` despite `.gitignore`. Untrack generated copies; they
    confuse the byte-identical checks in `verify/harness.mjs:157-180`.
12. No uninstall path. Add `uninstall.sh` (or document `rm -r`) for the app plugin dir plus
    the gateway `scripts/` trio.

## P1 - UX gaps

13. `desktop-plugins/session-usage/plugin.js:578-584` - panel is `pointer-events-none` and
    opens only on `onMouseEnter/Leave`; touch/keyboard users cannot open or pin it. Add
    `onFocus/onBlur` and click-to-toggle.
14. `desktop-plugins/deepseek-rate/plugin.js:217-232` - chip is a `<button type="button">`
    with `cursor-default` and no action. Use a non-interactive element or give it a click.
15. `desktop-plugins/opencode-usage/plugin.js:1731,1753` - errors surface as raw
    `Gateway call failed: ...`. Append remediation: check `OPENCODE_GO_API_KEY` in the gateway
    `.env`, confirm the script path on the gateway, name the app log path.
16. `desktop-plugins/opencode-usage/plugin.js:171-196` - `combinedWindows` averages percents
    across keys with different resets and labels the reset as "soonest". Mean of percents is
    misleading; label the chip as a mean or show a per-key range.
17. Release-date day shift is intentional (`session-usage/plugin.js:103-108`,
    `opencode-usage/plugin.js:279-284`) but surprising west of UTC. Show the raw `YYYY-MM-DD`
    in `title` alongside the localized label.

## P2 - missing tests / CI

18. No Python tests at all. Add stdlib unittest/pytest for `gateway-scripts/`: `parse_docs` /
    `parse_privacy` table variants, `bench_info` cooldown expiry, `window_start` month edge
    (Mar 31 -> Feb), `entry_for` prefix ambiguity, `env_lookup` BOM/quotes/`export`/`#`,
    `gateway_key` benched ranking.
19. `verify/harness.mjs` never exercises the spool `--part` path (`opencode_go_models.py:emit`
    past `STDOUT_HARD_LIMIT`), `readSpool` parts>32 rejection, `combinedWindows` /
    `chipSelection key:N` fallbacks, `sanitizeSettings` unknown values, `mergeUsage`
    out-of-order guard. The current gzip test (`harness.mjs:1351-1376`) only covers the gzip
    envelope.
20. `verify/class-audit.mjs:160-163` exits 0 with "could not audit" when `DESKTOP_SRC` is
    absent, so CI passes silently. Fail (or `--strict`) in CI, keep lenient locally. The audit
    also misses classes built via variables/template strings; document the gap.
21. No CI workflow. Add one running `node verify/harness.mjs` + `node verify/class-audit.mjs`
    under `TZ=UTC`, `America/Los_Angeles`, `Australia/Sydney`, plus the Python tests.
    `verify/e2e-real*.mjs` need a live gateway and are not a substitute.

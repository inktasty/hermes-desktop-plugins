# opencode-usage: the audited OS door, a grep that matches hyphens, and mark legends

Date: 2026-09-21. Card t_fc5aa7cb: dead links, ZDR mark spacing, unexplained
marks, raw announced dates in the `opencode-usage` desktop plugin.

## What landed

- `openExternal(url)` calls `ctx.os.openExternal` (the audited `hermes:openExternal`
  door). The app's `window-open-policy.ts` denies every in-app window open
  unconditionally, so the old `window.open` handlers were dead on click and
  ctrl-click alike.
- `ctx` is only a parameter of `register()` while the render components live at
  module scope, so a module-level `pluginCtx` is stashed by `register()` and read
  by the helper. Any module-scope UI that needs a plugin capability needs this.
- `superMark` gives raised footnote marks `ml-0.5`: with no margin a right-aligned
  tabular-nums cell reads `0d1` / `No2` as a wrong value.
- A conditional legend names `†` / `‡` / `*`, only for marks a rendered model
  actually uses — the same "no reference, no line" rule the numbered ZDR notes use.
- `fmtCalendarDate` renders a stated calendar date (`Sep 21, 2026`) without the
  viewer-zone shift; `fmtReleaseDate` keeps its deliberate UTC-midnight shift.

## Pitfalls worth remembering

1. **`grep -c "window.open"` is a REGEX, so `.` matches `-` and a space.** A
   comment that spelled the upstream file as `window-open-policy.ts` kept the
   count at 2 and would have failed the card's own acceptance check. When an
   acceptance check greps for a literal, never quote a hyphenated neighbour of
   the pattern in the same file.
2. **The harness walker dropped plain-element props.** Only `__prim:*` nodes
   kept their props, so a span's `onClick` (promo/announcement chips) was
   unreachable. `walk` now records `out.els` for string-type elements; drive a
   chip click through `els`, a `Button` click through `prims`.
3. **A `✓` fixture proves presence, not absence.** The legend needs both the main
   fixture (all three marks) and a mark-free fixture, or a page that ignores the
   rule entirely still passes.

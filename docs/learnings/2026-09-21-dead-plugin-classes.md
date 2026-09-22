# Plugins: a class the app never compiles is dead styling, silently

Date: 2026-09-21. Card t_4b7c8920: five utility classes in the plugins that the
app's CSS never contained (ZDR mark, divider, orange rows, quota number, name width), plus the guard.

## What landed

- All five became inline `style`s, which no build can drop: `verticalAlign:
  'super'` (0.125rem margin, 0.5rem) on the ZDR mark, `gridColumn: '1 / -1'` on
  the "Also served by Go" divider, `color: var(--ui-orange)` on the promo and
  announcement rows and the warn verdict, `fontSize: '1.75rem'` + `lineHeight: 1`
  on the quota percentage, `maxWidth: '150px'` under `truncate` on the session
  model name.
- `verify/class-audit.mjs` extracts every `className:` literal (including inside
  `cn(...)`) from `desktop-plugins/*/plugin.js`, checks each token against the
  app's `.ts/.tsx/.css/.json` sources, and exits 1 naming file:line for anything
  missing. `verify/class-audit-allow.txt` skips tokens with a reason; a missing
  app source prints one line and exits 0.
- `verify/harness.mjs` now asserts the rendered inline styles instead of the
  class names the fix removed.

## Pitfalls worth remembering

1. **Tailwind v4 compiles from the app's own sources only.** Plugin markup is
   never scanned, so a class the app itself lacks is absent from the stylesheet:
   no error, no warning, nothing.
2. **The presence check is a substring proxy and errs both ways.** It passes
   tokens the app never compiles (bare `border-s` "matches" inside
   `border-sidebar-border` and `border-s-2`) and cannot see variants. Prefer an
   inline style; allowlist only where one cannot express the rule.
3. **An inline style cannot express a `sm:` media query.** The three variant
   classes on the quota-card separator (`plugin.js:324`) are allowlisted with a
   reason instead of fixed: the card's remedy does not apply to them.
4. **A comment naming a class token breaks the card's own `grep -c` check** —
   the first draft quoted the tokens it was removing.
5. **Comparison operands are not class tokens**: `tone === 'warn' ? 'a' : 'b'`
   contributes the strings, not `warn`; literals preceded by `==`/`!=`/`===`/`!==`
   are skipped. The harness walker keeps plain-element props in `out.els`, so a
   check can read `e.props.style` for an inline-style assertion.

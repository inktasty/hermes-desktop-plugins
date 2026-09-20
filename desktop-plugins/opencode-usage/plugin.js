/**
 * Hermes desktop plugin: OpenCode Go usage.
 *
 * A status-bar chip, a full page (sidebar row + palette commands), and a
 * live-reading of the same three quota windows the OpenCode console shows.
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls, not JSX syntax.
 * Imports resolve to: @hermes/plugin-sdk, react, react/jsx-runtime.
 *
 * Data path: the renderer NEVER holds the API key. Every refresh asks the
 * gateway to run `scripts/opencode_go_usage.py` over the `shell.exec` RPC; that
 * script reads the Go key from the gateway's .env and calls OpenCode's official
 * quota endpoint (GET /zen/go/v1/usage).
 *
 * Visual contract: apps/desktop/DESIGN.md — flat (no boxes in boxes), hairlines
 * and whitespace over containers, tokens over literals, app primitives (Button,
 * Badge, StatusDot, Separator) over hand-rolled chrome.
 *
 * Deploy: %LOCALAPPDATA%\hermes\desktop-plugins\opencode-usage\plugin.js
 */

import {
  atom,
  Badge,
  Button,
  cn,
  Codicon,
  haptic,
  host,
  PALETTE_AREA,
  ROUTES_AREA,
  Separator,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  StatusDot,
  Tip,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'opencode-usage'
const ROUTE = '/opencode-go'
const POLL_MS = 60000
const TICK_MS = 1000
// `install.sh` sets the SCRIPTS_DIR constant below to this gateway's scripts path.
const SCRIPT_NAME = 'opencode_go_usage.py'
const SCRIPTS_DIR = '__HERMES_SCRIPTS__'
const PY_CANDIDATES = ['python3', 'python', 'py -3']
const CONSOLE_URL = 'https://opencode.ai/workspace'
const WINDOW_ORDER = ['rolling', 'weekly', 'monthly']

// ---- state -----------------------------------------------------------------

const $snap = atom(null)        // parsed JSON snapshot from the gateway script
const $error = atom(null)       // last failure text | null
const $updatedAt = atom(null)   // ms epoch of the last GOOD fetch
const $loading = atom(false)
const $now = atom(Date.now())   // ticking clock for countdowns

let refresh = async () => {}

// ---- formatting ------------------------------------------------------------

function fmtCountdown(ms) {
  if (!Number.isFinite(ms)) return '--'
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return d + 'd ' + h + 'h'
  if (h > 0) return h + 'h ' + m + 'm'
  if (m > 0) return m + 'm ' + s + 's'
  return s + 's'
}

function parseMs(iso) {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : null
}

function fmtResetLocal(iso, nowMs) {
  const t = parseMs(iso)
  if (t == null) return 'unknown'
  const soon = Math.abs(t - nowMs) < 6 * 86400000
  return new Intl.DateTimeFormat(undefined, soon
    ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  ).format(new Date(t))
}

function fmtStamp(iso) {
  const t = parseMs(iso)
  if (t == null) return 'unknown'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(t))
}

function fmtWindowLength(seconds) {
  if (!seconds) return 'unknown'
  if (seconds % 86400 === 0) return Math.round(seconds / 86400) + ' days'
  return Math.round(seconds / 3600) + ' hours'
}

const pctText = value => (value == null ? '--' : (Math.round(value * 10) / 10) + '%')

function toneOf(used) {
  if (used == null) return 'muted'
  if (used >= 85) return 'bad'
  if (used >= 60) return 'warn'
  return 'good'
}

const badgeVariantOf = used => ({ good: 'success', warn: 'warn', bad: 'destructive', muted: 'outline' })[toneOf(used)]

function parseSnapshot(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return null
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue
    try {
      const parsed = JSON.parse(lines[i])
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // keep walking back: a stray warning line may precede the payload
    }
  }
  return null
}

function windowList(snap) {
  if (!snap || !snap.windows) return []
  return WINDOW_ORDER.map(key => snap.windows[key]).filter(Boolean)
}

// ---- UI pieces -------------------------------------------------------------

/** Usage vs time: the muted band is how far the window has run, the accent
 *  bar is how much of the quota is spent, and the tick marks the clock. Read
 *  the gap: accent shorter than the tick = headroom, accent past it = ahead. */
function Gauge({ used, elapsed }) {
  const u = Math.max(0, Math.min(100, used == null ? 0 : used))
  const e = elapsed == null ? null : Math.max(0, Math.min(100, elapsed))
  return jsxs('div', {
    className: 'relative',
    children: [
      jsxs('div', {
        className: 'relative h-[7px] w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
        children: [
          e == null
            ? null
            : jsx('div', {
                className: 'absolute inset-y-0 left-0 bg-(--ui-stroke-primary)',
                style: { width: e + '%' }
              }),
          jsx('div', {
            className: 'absolute inset-y-0 left-0 rounded-full bg-(--ui-accent) transition-[width] duration-500',
            style: { width: u + '%' }
          })
        ]
      }),
      e == null
        ? null
        : jsx('div', {
            'aria-hidden': 'true',
            className: 'absolute -top-1 -bottom-1 w-px bg-(--ui-text-quaternary)',
            style: { left: 'calc(' + e + '% - 0.5px)' }
          })
    ]
  })
}

function Field({ label, value, strong }) {
  return jsxs('div', {
    className: 'flex items-baseline justify-between gap-3',
    children: [
      jsx('span', { className: 'text-(--ui-text-quaternary)', children: label }),
      jsx('span', {
        className: cn('tabular-nums', strong ? 'text-foreground' : 'text-(--ui-text-secondary)'),
        children: value
      })
    ]
  })
}

function WindowColumn({ win, now, first }) {
  const [open, setOpen] = useState(false)
  const used = win.used_percent
  const resetsMs = parseMs(win.resets_at)
  const tone = toneOf(used)

  const verdict = win.projected_percent == null
    ? null
    : win.on_pace
      ? { tone: 'muted', text: 'On track for ' + win.projected_percent + '% by reset' }
      : {
          tone: 'warn',
          text: 'Ahead of pace' + (win.hits_limit_at ? ', hits the cap ~' + fmtStamp(win.hits_limit_at) : '') + ' (est.)'
        }

  const dotTone = { good: 'good', warn: 'warn', bad: 'bad', muted: 'muted' }[tone]

  return jsxs('div', {
    className: cn('flex flex-col gap-3', !first && 'sm:border-s sm:border-(--ui-stroke-tertiary) sm:ps-6'),
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsxs('span', {
            className: 'flex items-center gap-1.5',
            children: [
              jsx(StatusDot, { tone: dotTone }),
              jsx('span', {
                className: 'text-[0.6875rem] font-medium tracking-wide text-(--ui-text-secondary) uppercase',
                children: win.label
              })
            ]
          }),
          jsx(Badge, {
            variant: badgeVariantOf(used),
            size: 'xs',
            children: pctText(win.remaining_percent) + ' left'
          })
        ]
      }),
      jsxs('div', {
        className: 'flex items-baseline gap-1.5',
        children: [
          jsx('span', {
            className: cn('text-[1.75rem] leading-none font-semibold tabular-nums', tone === 'bad' ? 'text-(--ui-red)' : 'text-foreground'),
            children: used == null ? '--' : String(used)
          }),
          jsx('span', { className: 'text-sm font-medium text-(--ui-text-secondary)', children: '%' }),
          jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: 'of window used' })
        ]
      }),
      Gauge({ used, elapsed: win.elapsed_percent }),
      jsxs('div', {
        className: 'flex items-center gap-3 text-[0.625rem] text-(--ui-text-quaternary)',
        children: [
          jsxs('span', {
            className: 'flex items-center gap-1',
            children: [
              jsx('span', { className: 'inline-block h-1.5 w-3 rounded-full bg-(--ui-accent)' }),
              'usage'
            ]
          }),
          win.elapsed_percent == null
            ? null
            : jsxs('span', {
                className: 'flex items-center gap-1',
                children: [
                  jsx('span', { className: 'inline-block h-1.5 w-3 rounded-full bg-(--ui-stroke-primary)' }),
                  'time ' + pctText(win.elapsed_percent)
                ]
              })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1 text-[0.6875rem]',
        children: [
          jsx(Field, { label: 'Resets in', value: resetsMs == null ? '--' : fmtCountdown(resetsMs - now), strong: true }),
          jsx(Field, { label: 'Resets at', value: fmtResetLocal(win.resets_at, now) })
        ]
      }),
      verdict
        ? jsxs('div', {
            className: cn(
              'flex items-center gap-1.5 text-[0.6875rem]',
              verdict.tone === 'warn' ? 'text-(--ui-orange)' : 'text-(--ui-text-quaternary)'
            ),
            children: [
              jsx(Codicon, { name: verdict.tone === 'warn' ? 'warning' : 'check' }),
              verdict.text
            ]
          })
        : null,
      jsx('div', {
        children: jsx(Button, {
          variant: 'ghost',
          size: 'xs',
          className: 'self-start',
          onClick: () => setOpen(v => !v),
          children: jsx('span', {
            className: 'flex items-center gap-1',
            children: [
              jsx(Codicon, { name: open ? 'chevron-down' : 'chevron-right' }),
              open ? 'Hide details' : 'Show details'
            ]
          })
        })
      }),
      open
        ? jsxs('div', {
            className: 'flex flex-col gap-1 border-t border-(--ui-stroke-tertiary) pt-2 text-[0.6875rem]',
            children: [
              jsx(Field, { label: 'Remaining', value: pctText(win.remaining_percent) }),
              jsx(Field, { label: 'Window', value: fmtWindowLength(win.window_seconds) }),
              jsx(Field, { label: 'Started', value: win.window_start ? fmtStamp(win.window_start) : 'unknown' }),
              win.elapsed_percent == null
                ? null
                : jsx(Field, { label: 'Time elapsed', value: pctText(win.elapsed_percent) }),
              jsx(Field, { label: 'Status', value: win.status || 'unknown', strong: win.status !== 'ok' }),
              jsx(Field, { label: 'Resets (UTC)', value: win.resets_at || 'unknown' })
            ]
          })
        : null
    ]
  })
}

function UsagePage() {
  const snap = useValue($snap)
  const error = useValue($error)
  const loading = useValue($loading)
  const updatedAt = useValue($updatedAt)
  const now = useValue($now)

  useEffect(() => {
    if (updatedAt == null || Date.now() - updatedAt > POLL_MS) void refresh()
  }, [])

  const windows = windowList(snap)
  const stale = updatedAt != null && Date.now() - updatedAt > 5 * POLL_MS

  // Soonest reset across the windows, and whichever window is furthest ahead of
  // the clock — the two things worth saying in one line up top.
  let soonest = null
  let flagged = null
  for (const win of windows) {
    const at = parseMs(win.resets_at)
    if (at != null && (soonest == null || at < soonest.at)) soonest = { at, win }
    if (win.on_pace === false && (flagged == null || win.projected_percent > flagged.projected_percent)) flagged = win
  }

  const summary = windows.length
    ? [
        soonest ? 'Next reset in ' + fmtCountdown(soonest.at - now) + ' (' + soonest.win.label + ')' : null,
        flagged
          ? 'Ahead of pace: ' + flagged.label + ' projects ' + flagged.projected_percent + '% by reset (est.)'
          : 'All windows inside their pace'
      ].filter(Boolean).join(' \u00b7 ')
    : null

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2.5 border-b border-(--ui-stroke-secondary) px-5 py-3',
        children: [
          jsx(Codicon, { name: 'pulse', className: 'text-(--ui-text-tertiary)' }),
          jsx('span', { className: 'text-[0.8125rem] font-medium text-foreground', children: 'OpenCode Go' }),
          jsx(StatusDot, { tone: error && !snap ? 'bad' : stale ? 'warn' : 'good' }),
          jsx('span', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: updatedAt == null
              ? 'never refreshed'
              : (error ? 'last good read ' : 'updated ') + fmtCountdown(Date.now() - updatedAt) + ' ago'
          }),
          jsx('div', { className: 'flex-1' }),
          jsx(Button, {
            variant: 'outline',
            size: 'xs',
            onClick: () => window.open(CONSOLE_URL, '_blank', 'noopener'),
            children: 'Console'
          }),
          jsx(Button, {
            variant: 'secondary',
            size: 'xs',
            loading: loading,
            onClick: () => void refresh(),
            children: 'Refresh'
          })
        ]
      }),
      jsxs('div', {
        className: 'flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5',
        children: [
          error
            ? jsxs('div', {
                className: 'flex items-center gap-2 text-[0.75rem] text-(--ui-red)',
                children: [
                  jsx(StatusDot, { tone: 'bad' }),
                  jsx('span', { children: error })
                ]
              })
            : null,

          summary
            ? jsx('div', { className: 'text-[0.75rem] text-(--ui-text-tertiary)', children: summary })
            : null,

          windows.length
            ? jsx('div', {
                className: 'grid gap-6 sm:grid-cols-3',
                children: windows.map((win, index) => jsx(WindowColumn, { key: win.key, win, now, first: index === 0 }))
              })
            : error
              ? null
              : jsx('div', {
                  className: 'text-[0.8125rem] text-(--ui-text-tertiary)',
                  children: loading ? 'Reading OpenCode Go usage...' : 'No usage data yet. Hit Refresh.'
                }),

          jsxs('div', {
            className: 'mt-auto flex flex-col gap-3 pt-1',
            children: [
              jsx(Separator, {}),
              jsxs('div', {
                className: 'flex flex-col gap-1 text-[0.6875rem] text-(--ui-text-quaternary)',
                children: [
                  jsx('div', {
                    children: 'Windows are OpenCode\'s own; percentages are the same numbers the console shows ' +
                      '(this endpoint rounds them to whole percents).'
                  }),
                  jsx('div', {
                    children: 'Per-model spend and the Zen credit balance are not exposed to API keys, only to a ' +
                      'logged-in console session, so use Console for those.'
                  })
                ]
              })
            ]
          })
        ]
      })
    ]
  })
}

function UsageChip() {
  const snap = useValue($snap)
  const error = useValue($error)
  const loading = useValue($loading)
  const now = useValue($now)

  const windows = windowList(snap)
  const worst = windows.reduce((acc, w) => Math.max(acc, w.used_percent || 0), 0)
  const text = windows.length
    ? windows.map(w => (w.used_percent == null ? '--' : Math.round(w.used_percent))).join('/') + '%'
    : loading
      ? '...'
      : '--'

  const tip = windows.length
    ? windows.map(w => {
        const at = parseMs(w.resets_at)
        return w.label + ' ' + w.used_percent + '% \u00b7 resets in ' + (at == null ? '--' : fmtCountdown(at - now))
      }).join('  |  ') + '   (click for the full page)'
    : error
      ? 'OpenCode Go usage unavailable: ' + error
      : 'OpenCode Go usage \u2014 click to open'

  const chip = jsxs('button', {
    className: cn(
      'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] tabular-nums transition-colors',
      error && !windows.length
        ? 'text-(--ui-text-quaternary)'
        : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground'
    ),
    type: 'button',
    onClick: () => {
      haptic('tap')
      host.navigate(ROUTE)
    },
    children: [
      jsx(StatusDot, { tone: windows.length ? toneOf(worst) : 'muted' }),
      jsx('span', { children: 'Go' }),
      jsx('span', { className: 'text-(--ui-text-quaternary)', children: text })
    ]
  })

  return jsx(Tip, { label: tip, children: chip })
}

// ---- registration ----------------------------------------------------------

export default {
  id: ID, // must match the folder name
  name: 'OpenCode Go Usage',
  register(ctx) {
    async function runUsageScript() {
      if (SCRIPTS_DIR.startsWith('__HERMES')) {
        throw new Error('run install.sh on the gateway')
      }
      const cached = ctx.storage && typeof ctx.storage.get === 'function' ? ctx.storage.get('py_cmd') : null
      const candidates = cached && typeof cached === 'string' ? [cached] : PY_CANDIDATES
      let lastCode = null
      const scriptPath = SCRIPTS_DIR + '/' + SCRIPT_NAME
      for (const py of candidates) {
        try {
          const resp = await host.request('shell.exec', { command: py + ' ' + scriptPath })
          const stdout = resp && resp.stdout ? String(resp.stdout) : ''
          const code = resp && typeof resp.code === 'number' ? resp.code : 0
          lastCode = code
          const snap = parseSnapshot(stdout)
          if (code === 0 && snap) {
            if (ctx.storage && typeof ctx.storage.set === 'function' && py !== cached) {
              ctx.storage.set('py_cmd', py)
            }
            return snap
          }
        } catch (e) {
          // fall through to next candidate
        }
      }
      const tried = (cached ? [cached] : PY_CANDIDATES).join(', ')
      throw new Error('no working python on the gateway shell (tried ' + tried + ')' + (lastCode != null ? '; exit ' + lastCode : '') + '; run install.sh on the gateway')
    }

    refresh = async () => {
      $loading.set(true)
      try {
        const snap = await runUsageScript()
        if (snap.ok === false) {
          $error.set(String(snap.error || 'usage endpoint returned no data'))
          return
        }
        $snap.set(snap)
        $updatedAt.set(Date.now())
        $error.set(null)
      } catch (e) {
        $error.set('Gateway call failed: ' + (e && e.message ? e.message : String(e)))
      } finally {
        $loading.set(false)
      }
    }

    void refresh()
    const pollTimer = setInterval(() => void refresh(), POLL_MS)
    const tickTimer = setInterval(() => $now.set(Date.now()), TICK_MS)

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: ROUTE },
        render: () => jsx(UsagePage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 55,
        data: { codicon: 'pulse', label: 'OpenCode Go', path: ROUTE }
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 10,
        render: () => jsx(UsageChip, {})
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'opencodeGo.open',
          label: 'OpenCode Go: Open usage',
          keywords: ['opencode', 'go', 'usage', 'quota', 'limits', 'plan'],
          run: () => host.navigate(ROUTE)
        }
      },
      {
        id: 'refresh',
        area: PALETTE_AREA,
        data: {
          id: 'opencodeGo.refresh',
          label: 'OpenCode Go: Refresh usage now',
          keywords: ['opencode', 'go', 'usage', 'refresh', 'quota'],
          run: () => void refresh()
        }
      }
    ])

    const dispose = () => {
      clearInterval(pollTimer)
      clearInterval(tickTimer)
    }
    if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose)
  }
}

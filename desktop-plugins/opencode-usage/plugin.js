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
  SearchField,
  SegmentedControl,
  Separator,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  StatusDot,
  Switch,
  Tip,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'opencode-usage'
const ROUTE = '/opencode-go'
const POLL_MS = 60000
const MODELS_TTL_MS = 6 * 3600000
// Opening the page should not need the Refresh button. A read older than this is
// refreshed when the page is opened, and re-checked while it stays open; anything
// newer is left alone. The manual button never consults this.
const PAGE_STALE_MS = 30 * 60000
const PAGE_RECHECK_MS = 60000

// The freshness rule, kept pure and exported: the harness's React stub is a no-op,
// so an effect cannot be exercised there and this is the only place the rule may
// live if it is to be tested at all.
export function pageStale(updatedAt, now) {
  return updatedAt == null || now - updatedAt > PAGE_STALE_MS
}
const TICK_MS = 1000
// `install.sh` sets the SCRIPTS_DIR constant below to this gateway's scripts path.
const SCRIPT_NAME = 'opencode_go_usage.py'
const MODELS_SCRIPT = 'opencode_go_models.py'
const SCRIPTS_DIR = '__HERMES_SCRIPTS__'
const PY_CANDIDATES = ['python3', 'python', 'py -3']
const CONSOLE_URL = 'https://opencode.ai/workspace'
const WINDOW_ORDER = ['rolling', 'weekly', 'monthly']

// Table placeholders. Every '—' carries a title saying what is missing, so a dash
// is never a dead end.
const DASH = '—'
const NOT_PUBLISHED = 'not published for this model'
const NO_REGISTRY_DATE = 'not in the model registry, so it has no published release date'
const ZDR_TEXT = { '30 days': '30d', 'Not ZDR': 'No' }

// ---- state -----------------------------------------------------------------

const $snap = atom(null)        // parsed JSON snapshot from the gateway script
const $error = atom(null)       // last failure text | null
const $updatedAt = atom(null)   // ms epoch of the last GOOD fetch
const $loading = atom(false)
const $now = atom(Date.now())   // ticking clock for countdowns

const $models = atom(null)      // parsed JSON models payload
const $modelsError = atom(null) // last models failure text | null
const $modelsAt = atom(null)    // ms epoch of the last GOOD models fetch
const $modelsLoading = atom(false)

// ---- settings ---------------------------------------------------------------
// Persisted through ctx.storage, so a choice survives a reload. Every field has a
// default and a stored blob is sanitised field by field, so a value written by an
// older build can never blank a control or wedge the plugin.
const SETTINGS_KEY = 'settings_v1'
const DEFAULT_SETTINGS = {
  chipSource: 'auto',   // 'auto' (the key in use) | 'combined' | 'key:N'
  chipLabel: true,      // show the (N/total) position marker on the chip
  refreshSec: Math.round(POLL_MS / 1000), // usage poll interval (POLL_MS unless changed)
  warnAt: 60,           // the % at which a window turns amber
  showRawNames: false   // reveal the pool's own credential labels
}
const REFRESH_CHOICES = [30, 60, 300]
const WARN_CHOICES = [60, 75, 85]
const WARN_CEILING = 85 // 'bad' starts here, so a warnAt at or above it never shows
const $settings = atom({ ...DEFAULT_SETTINGS })

// Keys are named by position, not by their configured label: a pool label can be
// a variable name, a fingerprint or anything else the user typed, and none of
// that belongs in a status line. The real label stays available in a tooltip (and
// behind the 'show credential names' setting) so a report is still actionable.
function displayName(k, position) {
  const n = k && typeof k.ordinal === 'number' ? k.ordinal : position || 1
  return 'Key ' + n
}

function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS }
  if (raw && typeof raw === 'object') {
    for (const field of Object.keys(DEFAULT_SETTINGS)) {
      if (raw[field] !== undefined && raw[field] !== null) out[field] = raw[field]
    }
  }
  // An unknown chip source falls back to auto rather than rendering nothing.
  const source = String(out.chipSource)
  if (source !== 'auto' && source !== 'combined' && !/^key:[1-9][0-9]*$/.test(source)) {
    out.chipSource = DEFAULT_SETTINGS.chipSource
  }
  out.refreshSec = REFRESH_CHOICES.indexOf(Number(out.refreshSec)) >= 0 ? Number(out.refreshSec) : DEFAULT_SETTINGS.refreshSec
  out.warnAt = WARN_CHOICES.indexOf(Number(out.warnAt)) >= 0 ? Number(out.warnAt) : DEFAULT_SETTINGS.warnAt
  out.chipLabel = out.chipLabel !== false
  out.showRawNames = out.showRawNames === true
  return out
}

// A synthetic window per period: the mean of every key that reports it, so the
// chip can say what the whole pool is spending. Mean-used and mean-projected stay
// consistent with each other because every key shares the same window boundaries
// and elapsed time; the reset shown is the soonest, i.e. when capacity returns.
function combinedWindows(keys) {
  const out = {}
  for (const key of WINDOW_ORDER) {
    const rows = (keys || []).map(k => (k && k.windows ? k.windows[key] : null)).filter(Boolean)
    if (!rows.length) continue
    const mean = field => {
      const vals = rows.map(r => r[field]).filter(v => typeof v === 'number' && Number.isFinite(v))
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
    }
    const used = mean('used_percent')
    const resets = rows.map(r => parseMs(r.resets_at)).filter(v => v != null)
    const projected = mean('projected_percent')
    out[key] = {
      ...rows[0],
      used_percent: used,
      remaining_percent: used == null ? null : Math.max(0, 100 - used),
      elapsed_percent: mean('elapsed_percent'),
      projected_percent: projected,
      on_pace: projected == null ? null : projected <= 100,
      hits_limit_at: null,
      resets_at: resets.length ? new Date(Math.min(...resets)).toISOString() : rows[0].resets_at,
      combined_keys: rows.length
    }
  }
  return WINDOW_ORDER.map(k => out[k]).filter(Boolean)
}

// Which windows the chip reports, and the marker that says where they came from.
function chipSelection(keys, settings) {
  const list = Array.isArray(keys) ? keys : []
  if (!list.length) return { windows: [], marker: null }
  if (list.length === 1) return { windows: windowList({ windows: list[0].windows }), marker: null }
  const source = String(settings.chipSource)
  if (source === 'combined') return { windows: combinedWindows(list), marker: 'all' }
  let chosen = null
  if (source.startsWith('key:')) {
    const n = Number(source.slice(4))
    chosen = list.find(k => k && k.ordinal === n) || null
  }
  if (!chosen) chosen = list.find(k => k && k.active) || list[0]
  const n = typeof chosen.ordinal === 'number' ? chosen.ordinal : list.indexOf(chosen) + 1
  return { windows: windowList({ windows: chosen.windows }), marker: n + '/' + list.length }
}

let refresh = async () => {}
let refreshModels = async () => {}
let applySettings = () => {}  // set by register(); the settings UI calls this
let refreshTimer = null       // usage poll timer; re-armed when refreshSec changes
let pluginCtx = null          // set by register(); render components live at module scope

// The app blocks every authored pop-up by policy in its main process, so the
// only way out is ctx.os.openExternal, the audited hermes:openExternal door.
function openExternal(url) {
  if (typeof url !== 'string' || !url) return
  const os = pluginCtx && pluginCtx.os
  if (!os || typeof os.openExternal !== 'function') return
  void os.openExternal(url)
}

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

// The same instant stated in UTC, for anyone comparing against the quota API.
// A readable stamp, never the raw ISO string: 2026-09-22T22:00:00Z is a
// developer string, not something a UI should print.
function fmtUtcStamp(iso) {
  const t = parseMs(iso)
  if (t == null) return 'unknown'
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(t)) + ' UTC'
}

// The registry stores a release_date as a bare 'YYYY-MM-DD' in UTC, with no time
// of day. We render that date as UTC midnight on the VIEWER's clock, so west of
// UTC (UTC-7, for example) it lands on the previous day: a registry date of
// 2026-09-22 shows here as Sep 21, 2026. That is intended, because it is the day
// the release actually reached this machine. Do NOT "fix" it back to the raw
// registry string, and do not clamp it to today.
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function fmtReleaseDate(raw) {
  const match = ISO_DATE_RE.exec(String(raw == null ? '' : raw).trim())
  if (!match) return null
  const month = Number(match[2])
  const day = Number(match[3])
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null
  // No timeZone option on purpose: the host clock decides the rendered day.
  const at = new Date(Date.UTC(Number(match[1]), month - 1, day))
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(at)
}

// A bare 'YYYY-MM-DD' that is a stated CALENDAR date — an announcement date, a
// promo end date — is the day it names, not a UTC instant. Build a LOCAL date so
// the day never shifts: 2026-09-21 reads Sep 21, 2026 in every timezone. This is
// the opposite of fmtReleaseDate above, which intentionally renders a registry
// date as UTC midnight on the viewer's clock; do not swap one for the other.
function fmtCalendarDate(raw) {
  const match = ISO_DATE_RE.exec(String(raw == null ? '' : raw).trim())
  if (!match) return null
  const month = Number(match[2])
  const day = Number(match[3])
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    .format(new Date(Number(match[1]), month - 1, day))
}

function fmtWindowLength(seconds) {
  if (!seconds) return 'unknown'
  if (seconds % 86400 === 0) return Math.round(seconds / 86400) + ' days'
  return Math.round(seconds / 3600) + ' hours'
}

const pctText = value => (value == null ? '--' : (Math.round(value * 10) / 10) + '%')

function toneOf(used) {
  if (used == null) return 'muted'
  if (used >= WARN_CEILING) return 'bad'
  // Amber starts at the configured threshold; 'bad' is checked first, so a warnAt
  // at the ceiling just means there is no amber stage.
  const warnAt = Number($settings.get().warnAt)
  if (used >= (Number.isFinite(warnAt) ? warnAt : DEFAULT_SETTINGS.warnAt)) return 'warn'
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

// The gateway hands back only the LAST 4000 characters of stdout (see
// tui_gateway/methods_tools.py), so a payload larger than that arrives
// gzipped+base64 as {"ok":...,"gzip":"..."} (see scripts/opencode_go_models.py).
// Inflate it here. Small payloads pass through untouched.
async function unwrap(payload) {
  if (!payload || typeof payload.gzip !== 'string') return payload
  if (typeof DecompressionStream !== 'function') {
    throw new Error('this app build cannot inflate the model list (no DecompressionStream)')
  }
  const binary = atob(payload.gzip)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return JSON.parse(await new Response(stream).text())
}

function windowList(snap) {
  if (!snap || !snap.windows) return []
  return WINDOW_ORDER.map(key => snap.windows[key]).filter(Boolean)
}

// Money in a table: keep the digits that matter, and never a bare '$0.6' where the
// neighbours carry two decimals ('$0.60' next to '$4.40').
function trimMoney(text) {
  const parts = String(text).split('.')
  if (parts.length !== 2) return String(text)
  const kept = parts[1].replace(/0+$/, '')
  return parts[0] + '.' + (kept.length >= 2 ? kept : parts[1].slice(0, 2))
}

function fmtUsd(d) {
  if (!Number.isFinite(d)) return null
  if (d === 0) return '$0'
  if (d < 0.01) return '$' + String(Number(d.toFixed(6)))
  if (d < 1) return '$' + trimMoney(d.toFixed(3))
  return '$' + d.toFixed(2)
}

// Monthly caps are whole dollars in the docs ('$60', not '$60.00').
function fmtCap(d) {
  if (!Number.isFinite(d)) return null
  return Number.isInteger(d) ? '$' + String(d) : '$' + d.toFixed(2)
}

// Grouped in a fixed locale: the app locale may group with '.' (de) or a space
// (fr) while the money and percent columns beside it are always '$1.23' and
// '12.5%'. Three conventions in one table reads worse than one borrowed one.
function fmtInt(n) {
  if (!Number.isFinite(n)) return null
  return Math.round(n).toLocaleString('en-US')
}

function fmtAge(ms) {
  const age = Date.now() - ms
  if (age < 60000) return 'just now'
  if (age < 3600000) return Math.floor(age / 60000) + 'm'
  if (age < 86400000) return Math.floor(age / 3600000) + 'h'
  return Math.floor(age / 86400000) + 'd'
}

// 'updated just now' reads; 'updated just now ago' does not.
function ageText(verb, ms) {
  const age = fmtAge(ms)
  return age === 'just now' ? verb + ' just now' : verb + ' ' + age + ' ago'
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
            className: cn('leading-none font-semibold tabular-nums', tone === 'bad' ? 'text-(--ui-red)' : 'text-foreground'),
            style: { fontSize: '1.75rem', lineHeight: 1 },
            children: used == null ? '--' : String(used)
          }),
          jsx('span', { className: 'text-sm font-medium text-(--ui-text-secondary)', children: '%' }),
          jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: 'of the quota spent' })
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
              'quota spent'
            ]
          }),
          win.elapsed_percent == null
            ? null
            : jsxs('span', {
                className: 'flex items-center gap-1',
                children: [
                  jsx('span', { className: 'inline-block h-1.5 w-3 rounded-full bg-(--ui-stroke-primary)' }),
                  'time gone by'
                ]
              })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1 text-[0.6875rem]',
        children: [
          jsx(Field, { label: 'This window resets in', value: resetsMs == null ? '--' : fmtCountdown(resetsMs - now), strong: true }),
          jsx(Field, { label: 'Reset happens', value: fmtResetLocal(win.resets_at, now) })
        ]
      }),
      verdict
        ? jsxs('div', {
            className: cn(
              'flex items-center gap-1.5 text-[0.6875rem]',
              verdict.tone === 'warn' ? null : 'text-(--ui-text-quaternary)'
            ),
            // Inline colour: the utility class that used to carry this is one the
            // app never compiles (it scans its own sources, never plugin files),
            // so the warn colour would silently do nothing.
            style: verdict.tone === 'warn' ? { color: 'var(--ui-orange)' } : undefined,
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
              jsx(Field, { label: 'Quota left', value: pctText(win.remaining_percent) }),
              jsx(Field, { label: 'Window length', value: fmtWindowLength(win.window_seconds) }),
              jsx(Field, { label: 'Window opened', value: win.window_start ? fmtStamp(win.window_start) : 'unknown' }),
              win.elapsed_percent == null
                ? null
                : jsx(Field, { label: 'Window time gone by', value: pctText(win.elapsed_percent) }),
              jsx(Field, { label: 'Reported status', value: win.status || 'unknown', strong: win.status !== 'ok' }),
              jsx(Field, { label: 'Reset instant', value: fmtUtcStamp(win.resets_at) })
            ]
          })
        : null
    ]
  })
}

// ---- model list controls ---------------------------------------------------
//
// The bar above the models table takes TWO sort keys at once — cost and release
// date — plus a swap control saying which of the two leads, and stacks a ZDR-only
// toggle and a name search on top of them. The ordering rule is a pure function,
// exported so the probe can exercise it without a render — the grouping, the
// footnote numbering and the legend lines all run on its output.

const SORT_DEFAULT = 'default'
const SORT_COST_ASC = 'cost-asc'
const SORT_COST_DESC = 'cost-desc'
const SORT_RELEASED_ASC = 'released-asc'
const SORT_RELEASED_DESC = 'released-desc'

const COST_SORT_OPTIONS = [
  { id: SORT_DEFAULT, label: 'Default' },
  { id: SORT_COST_ASC, label: 'Cheapest' },
  { id: SORT_COST_DESC, label: 'Priciest' }
]
const RELEASED_SORT_OPTIONS = [
  { id: SORT_DEFAULT, label: 'Default' },
  { id: SORT_RELEASED_DESC, label: 'Newest' },
  { id: SORT_RELEASED_ASC, label: 'Oldest' }
]

/** A model's primary input rate: its own rate, else its first priced tier. */
function modelRate(m) {
  if (typeof m.input === 'number') return m.input
  for (const t of m.tiers || []) {
    if (typeof t.input === 'number') return t.input
  }
  return null
}

/** 'asc' | 'desc' for one control's value. Default is not a direction. */
function sortDirOf(value) {
  return value === SORT_COST_DESC || value === SORT_RELEASED_DESC ? 'desc' : 'asc'
}

/** The value one key sorts on: a number for cost, a bare date string for release. */
function sortValueOf(m, key) {
  if (key === 'cost') return modelRate(m)
  return typeof m.released === 'string' ? m.released : null
}

/**
 * Compares two models on ONE key. A model with no rate (or no registry date)
 * sinks to the END in both directions: a missing number is not a low number, and
 * a model with no published date is not the newest one. Equal values compare 0,
 * so the caller falls through to the next key and everything behind a tie keeps
 * its relative order.
 */
function compareKey(a, b, key, dir) {
  const x = sortValueOf(a, key)
  const y = sortValueOf(b, key)
  if (x == null && y == null) return 0
  if (x == null) return 1
  if (y == null) return -1
  if (x === y) return 0
  const less = x < y
  return (dir === 'desc' ? !less : less) ? -1 : 1
}

/** The last-resort tiebreak: the display name, so rows equal on every active key
 *  come out in one fixed order instead of whatever order they happened to have. */
function compareName(a, b) {
  const x = String(a && a.name != null ? a.name : '')
  const y = String(b && b.name != null ? b.name : '')
  if (x === y) return 0
  return x < y ? -1 : 1
}

/**
 * Orders a copy of `list` by the keys the bar has active, in priority order —
 * `sorts` is e.g. [{key:'cost',dir:'asc'},{key:'released',dir:'asc'}]. No active
 * key hands back the payload's own order untouched.
 *
 * With ONE key, rows equal on it keep the payload's order (a stable sort): that
 * is exactly what the single-key sort has always done. With BOTH keys, rows equal
 * on both fall back to the display name so they never swap between renders.
 *
 * `released` is a bare 'YYYY-MM-DD' from the models.dev registry, so it compares
 * as a STRING. The Released column renders it on the viewer's clock on purpose;
 * the ordering must not, or west of UTC the sort would disagree with the column.
 */
export function sortModelsMulti(list, sorts) {
  const out = (list || []).slice()
  const active = (sorts || []).filter(s => s && (s.key === 'cost' || s.key === 'released'))
  if (!active.length) return out
  const primary = active[0]
  const secondary = active[1] || null
  out.sort((a, b) => {
    const byPrimary = compareKey(a, b, primary.key, primary.dir)
    if (byPrimary) return byPrimary
    if (!secondary) return 0
    const bySecondary = compareKey(a, b, secondary.key, secondary.dir)
    if (bySecondary) return bySecondary
    return compareName(a, b)
  })
  return out
}

/**
 * Single-key wrapper, kept for callers and probes that want one key. `key` is
 * 'cost' or 'released'; any other key hands back the payload's own order.
 */
export function sortModels(list, key, dir) {
  if (key !== 'cost' && key !== 'released') return (list || []).slice()
  return sortModelsMulti(list, [{ key, dir }])
}

/** The rows the bar asks for: a ZDR-only toggle and a case-insensitive name
 *  search that stacks on top of it. Returns a new array; never mutates `list`. */
export function filterModels(list, { zdrOnly = false, query = '' } = {}) {
  const needle = String(query == null ? '' : query).trim().toLowerCase()
  return (list || []).filter(m => {
    if (!m) return false
    if (zdrOnly && !(m.privacy && m.privacy.zdr === true)) return false
    if (needle && !String(m.name || '').toLowerCase().includes(needle)) return false
    return true
  })
}

export function ModelsTable({ models, error, initialControls }) {
  const payload = models && models.models ? models : null

  // Hooks run unconditionally, ahead of the early return below: the payload is
  // null on the first render and arrives later, and a hook after that return
  // would change the hook count between those two renders.
  //
  // `initialControls` is the probe's seam — it renders this component straight at
  // a given control state so the empty state and the grouping can be checked
  // without a live React. The app never passes it.
  const seed = initialControls || {}
  // The probe seeds control state directly, because its React stub does not run
  // handlers. `sort` is the single-key seed the older probes still pass: it
  // selects ONE control and leaves the other on Default, exactly as picking that
  // control used to. `costSort` / `releasedSort` set both, and `leader` says which
  // one is primary when both are set.
  const seedCost = typeof seed.costSort === 'string'
    ? seed.costSort
    : seed.sort === SORT_COST_ASC || seed.sort === SORT_COST_DESC ? seed.sort : SORT_DEFAULT
  const seedReleased = typeof seed.releasedSort === 'string'
    ? seed.releasedSort
    : seed.sort === SORT_RELEASED_ASC || seed.sort === SORT_RELEASED_DESC ? seed.sort : SORT_DEFAULT
  const [costSort, setCostSort] = useState(seedCost)
  const [releasedSort, setReleasedSort] = useState(seedReleased)
  // Which of the two keys leads when both are set. Cost leads until the swap
  // control flips it; the swap is the only writer.
  const [leader, setLeader] = useState(seed.leader === 'released' ? 'released' : 'cost')
  const [zdrOnly, setZdrOnly] = useState(seed.zdrOnly === true)
  const [query, setQuery] = useState(typeof seed.query === 'string' ? seed.query : '')

  if (!payload) {
    // Never leave the space silently blank: an empty area with no explanation is
    // the one failure mode nobody can debug from the UI.
    return jsxs('div', {
      className: 'flex flex-col gap-2',
      children: [
        jsx('div', {
          className: 'flex items-baseline gap-2 text-[0.8125rem]',
          children: jsx('span', { className: 'font-medium text-foreground', children: 'Models on Go' })
        }),
        jsx('div', {
          className: cn('text-[0.6875rem]', error ? 'text-(--ui-red)' : 'text-(--ui-text-quaternary)'),
          children: error ? 'Model list unavailable: ' + error : 'Reading the model list...'
        })
      ]
    })
  }
  const list = payload.models || []

  // Each control owns its own key, so both can be set at once. When both are, the
  // swap control says which one leads; with a single key active that key is the
  // whole comparator, unchanged from the one-at-a-time bar.
  const costActive = costSort !== SORT_DEFAULT
  const releasedActive = releasedSort !== SORT_DEFAULT
  const bothSorts = costActive && releasedActive
  const activeSorts = []
  if (bothSorts) {
    const costEntry = { key: 'cost', dir: sortDirOf(costSort) }
    const releasedEntry = { key: 'released', dir: sortDirOf(releasedSort) }
    activeSorts.push(...(leader === 'released' ? [releasedEntry, costEntry] : [costEntry, releasedEntry]))
  } else if (costActive) {
    activeSorts.push({ key: 'cost', dir: sortDirOf(costSort) })
  } else if (releasedActive) {
    activeSorts.push({ key: 'released', dir: sortDirOf(releasedSort) })
  }
  // The swap control is only meaningful with both keys set, so it exists only
  // then — and its label is the effective order it would flip.
  const orderLabel = leader === 'released' ? 'released, then cost' : 'cost, then released'
  const rankLabel = (base, rank) => (rank ? base + ' (' + rank + ')' : base)
  const costRank = bothSorts ? (leader === 'cost' ? '1st' : '2nd') : null
  const releasedRank = bothSorts ? (leader === 'released' ? '1st' : '2nd') : null

  // Order first, then narrow. Everything below — the capped/uncapped grouping,
  // the dividers it draws, the footnote numbering, the legend lines — is
  // computed from what is actually on screen, so a filtered-out model takes its
  // footnote and its mark with it.
  const shown = filterModels(sortModelsMulti(list, activeSorts), { zdrOnly, query })
  // An empty payload is not the same thing as a filter that hid every row: only
  // claim the controls matched nothing when there was something to match.
  const nothingMatches = list.length > 0 && shown.length === 0

  // A served model with nothing published at all (no prices and no cap) would
  // render as a row of dashes; name it once under the table instead.
  const hasPrice = m => m.input != null || m.output != null || m.cache_read != null || m.monthly_usd != null
  const capped = shown.filter(m => m.monthly_usd != null)
  const uncapped = shown.filter(m => m.monthly_usd == null && hasPrice(m))
  const unpriced = shown.filter(m => m.monthly_usd == null && !hasPrice(m))
  // Both the header's age and the footer's stamp come from the payload itself,
  // so a list restored from storage reports its real age and not the restore time.
  const fetchedMs = parseMs(payload.fetched_at)

  // Model | Released | In | Out | Cache | Cap | ≈ Req/mo | ZDR
  const gridTemplate = 'minmax(11rem, 1.6fr) 5.5rem 4rem 4rem 4.5rem 3.5rem 4.5rem 3.5rem'

  // The docs' privacy footnotes, numbered in the order the models first appear
  // top to bottom. A note no rendered model references never gets a line.
  const notesByKey = new Map((payload.privacy_notes || []).map(n => [n.key, n]))
  const noteIndex = new Map()
  const noteLines = []
  for (const m of capped.concat(uncapped)) {
    const key = m.privacy && m.privacy.note_key
    if (!key || noteIndex.has(key)) continue
    const note = notesByKey.get(key)
    if (!note) continue
    noteIndex.set(key, noteLines.length + 1)
    noteLines.push(note)
  }

  function tierTitle(m) {
    const tiers = (m.tiers || []).filter(t => t.label)
    if (!tiers.length) return null
    return tiers.map(t => {
      const pieces = [fmtUsd(t.input) + ' in', fmtUsd(t.output) + ' out']
      if (t.cache_read != null) pieces.push(fmtUsd(t.cache_read) + ' cache')
      return t.label + ': ' + pieces.join(' / ')
    }).join('; ')
  }

  // The numbered notes above explain the ZDR marks only. The name and cap columns
  // carry their own marks, so name those here too -- and, like the notes, only the
  // ones a rendered model actually uses. No mark used, no line.
  const rendered = capped.concat(uncapped)
  const legendLines = []
  if (rendered.some(m => m.price_source === 'catalog')) legendLines.push('† priced from the live catalog, not yet in the docs')
  if (rendered.some(m => tierTitle(m))) legendLines.push('‡ tiered pricing; hover the model name for the tiers')
  if (capped.some(m => m.cap_source === 'announcement')) legendLines.push('* cap announced by OpenCode on X, not in the docs')

  function NameCell({ m }) {
    const catalogTitle = m.price_source === 'catalog' ? 'Priced from the live catalog; not yet listed in the docs' : null
    const tier = tierTitle(m)
    const suffixes = []
    if (m.price_source === 'catalog') suffixes.push({ char: '†', title: catalogTitle })
    if (tier) suffixes.push({ char: '‡', title: tier })
    return jsxs('div', {
      className: 'flex min-w-0 items-center gap-1.5',
      children: [
        jsx('span', { className: 'whitespace-nowrap', title: m.name, children: m.name }),
        m.promo
          ? jsx(Badge, { variant: 'warn', size: 'xs', title: m.promo, children: m.promo })
          : null,
        suffixes.map((s, i) => jsx('span', { key: i, className: 'shrink-0 text-(--ui-text-quaternary)', title: s.title, children: s.char }))
      ]
    })
  }

  function RowCell({ children, right, title }) {
    const props = {
      className: cn('py-1 text-[0.6875rem]', right ? 'text-right tabular-nums' : 'text-(--ui-text-secondary)'),
      children
    }
    if (title) props.title = title
    return jsx('div', props)
  }

  // Money and request counts: a dash always says what is missing.
  function moneyCell(d) {
    const text = fmtUsd(d)
    return text == null ? { right: true, title: NOT_PUBLISHED, children: DASH } : { right: true, children: text }
  }

  function reqCell(d) {
    const text = fmtInt(d)
    return text == null ? { right: true, title: NOT_PUBLISHED, children: DASH } : { right: true, children: text }
  }

  // A raised footnote mark must not touch the value it follows: with no margin a
  // right-aligned tabular-nums cell reads '0d1' / 'No2' as a wrong number. The
  // margin lives here, so both call sites get it.
  //
  // Inline styles, not utility classes: Tailwind compiles the app's OWN sources
  // only and never scans plugin files, so a class here would silently do
  // nothing — that is exactly what happened to the ZDR footnote digit.
  // verify/class-audit.mjs guards the whole class.
  function superMark(text) {
    return jsx('span', {
      style: { fontSize: '0.5rem', verticalAlign: 'super', marginLeft: '0.125rem' },
      children: text
    })
  }

  // Cap: 'no cap' when the docs publish none, a superscript star when the number
  // comes from an OpenCode announcement rather than the docs.
  function capCell(m) {
    if (m.monthly_usd == null) {
      return { right: true, children: jsx('span', { className: 'text-(--ui-text-quaternary)', children: 'no cap' }) }
    }
    if (m.cap_source === 'announcement') {
      const source = (m.announcement && m.announcement.source) || ''
      return {
        right: true,
        title: 'Announced by OpenCode on X, not in the docs' + (source ? ': ' + source : ''),
        children: [fmtCap(m.monthly_usd), superMark('*')]
      }
    }
    return { right: true, children: fmtCap(m.monthly_usd) }
  }

  // ZDR: 0d for zero retention, the retention window compacted otherwise, a dash
  // (with its reason) when the docs privacy table does not list the model.
  function zdrCell(m) {
    const privacy = m.privacy
    if (!privacy) {
      return { right: true, title: 'not listed in the docs privacy table', children: DASH }
    }
    const index = privacy.note_key ? noteIndex.get(privacy.note_key) : null
    const note = index ? notesByKey.get(privacy.note_key) : null
    const text = privacy.zdr ? '0d' : (ZDR_TEXT[privacy.retention] || privacy.retention)
    const props = { right: true, children: note ? [text, superMark(String(index))] : text }
    if (note) props.title = note.text
    else if (privacy.zdr) props.title = 'zero data retention'
    return props
  }

  // Released: the model's release date from the models.dev registry, carried by
  // the gateway's payload. A model the registry does not list gets a dash that
  // says so.
  function releaseCell(m) {
    const text = fmtReleaseDate(m.released)
    return text == null ? { title: NO_REGISTRY_DATE, children: DASH } : { children: text }
  }

  function modelRow(m) {
    return jsxs('div', {
      key: m.id,
      className: cn(rowClass, 'contents'),
      children: [
        jsx('div', { className: 'py-1', children: jsx(NameCell, { m }) }),
        jsx(RowCell, releaseCell(m)),
        jsx(RowCell, moneyCell(m.input)),
        jsx(RowCell, moneyCell(m.output)),
        jsx(RowCell, moneyCell(m.cache_read)),
        jsx(RowCell, capCell(m)),
        jsx(RowCell, reqCell(m.req_month)),
        jsx(RowCell, zdrCell(m))
      ]
    })
  }

  const headerClass = 'border-b border-(--ui-stroke-secondary) py-1 text-[0.625rem] font-medium tracking-wide text-(--ui-text-quaternary) uppercase'
  const rowClass = 'border-b border-(--ui-stroke-tertiary)'

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-3',
        children: [
          jsxs('div', {
            className: 'flex items-baseline gap-2 text-[0.8125rem]',
            children: [
              jsx('span', { className: 'font-medium text-foreground', children: 'Models on Go' }),
              jsx('span', { className: 'text-(--ui-text-quaternary)', children: payload.counts ? payload.counts.served : list.length }),
              fetchedMs ? jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: ageText('updated', fetchedMs) }) : null
            ]
          }),
          jsx(Button, {
            variant: 'outline',
            size: 'xs',
            onClick: () => openExternal(payload.docs_url),
            children: 'Go docs'
          })
        ]
      }),

      (payload.promos || []).length
        ? jsxs('div', {
            className: 'flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem]',
            style: { color: 'var(--ui-orange)' },
            children: payload.promos.map(p => {
              const before = p.monthly_before_usd != null ? fmtCap(p.monthly_before_usd) : null
              const after = p.monthly_usd != null ? fmtCap(p.monthly_usd) : null
              return jsx('span', {
                key: p.model_key,
                className: 'cursor-pointer hover:underline',
                title: 'Promo from the OpenCode Go docs: ' + payload.docs_url,
                onClick: () => openExternal(payload.docs_url),
                children: p.name + ' — ' + p.label + (before && after ? ' (' + before + ' → ' + after + ' cap)' : '')
              })
            })
          })
        : null,

      (payload.announcements || []).length
        ? jsxs('div', {
            className: 'flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem]',
            style: { color: 'var(--ui-orange)' },
            children: payload.announcements.map(a => jsx('span', {
              key: a.model_key,
              title: a.source,
              className: 'cursor-pointer hover:underline',
              onClick: () => openExternal(a.source),
              children: a.name + ' — ' + a.note + ' (announced ' + (fmtCalendarDate(a.date) || a.date) + ')'
            }))
          })
        : null,

      error
        ? jsx('div', { className: 'text-[0.75rem] text-(--ui-red)', children: error })
        : null,

      // The sort/filter bar sits directly above the table it acts on. Only the
      // table's own content obeys it — the grouping, the dividers, the footnotes
      // and the unpriced line are all recomputed from the rows that survive it.
      // The promo and announcement lines above are the payload's, not the table's.
      list.length
        ? jsxs('div', {
            className: 'flex flex-wrap items-center gap-x-3 gap-y-1',
            children: [
              jsxs('div', {
                className: 'flex items-center gap-1.5 text-[0.6875rem] text-(--ui-text-quaternary)',
                children: [
                  jsx('span', { children: rankLabel('Sort cost', costRank) }),
                  jsx(SegmentedControl, { options: COST_SORT_OPTIONS, value: costSort, onChange: setCostSort })
                ]
              }),
              // Between the two controls, and only when both are set: with one key
              // (or none) there is no priority to flip, and a control that looks
              // live but is not is worse than no control.
              bothSorts
                ? jsxs('div', {
                    className: 'flex items-center gap-1.5 text-[0.6875rem] text-(--ui-text-quaternary)',
                    children: [
                      jsx(Button, {
                        variant: 'outline',
                        size: 'xs',
                        title: 'Swap which sort leads',
                        'aria-label': 'Swap which sort leads: ' + orderLabel,
                        onClick: () => setLeader(prev => (prev === 'released' ? 'cost' : 'released')),
                        children: orderLabel
                      })
                    ]
                  })
                : null,
              jsxs('div', {
                className: 'flex items-center gap-1.5 text-[0.6875rem] text-(--ui-text-quaternary)',
                children: [
                  jsx('span', { children: rankLabel('Sort released', releasedRank) }),
                  jsx(SegmentedControl, { options: RELEASED_SORT_OPTIONS, value: releasedSort, onChange: setReleasedSort })
                ]
              }),
              jsxs('div', {
                className: 'flex items-center gap-1.5 text-[0.6875rem] text-(--ui-text-quaternary)',
                children: [
                  jsx(Switch, {
                    checked: zdrOnly,
                    size: 'xs',
                    'aria-label': 'Zero data retention models only',
                    onCheckedChange: next => setZdrOnly(next === true)
                  }),
                  jsx('span', { children: 'ZDR only' })
                ]
              }),
              jsx(SearchField, {
                placeholder: 'Search models',
                'aria-label': 'Search models by name',
                value: query,
                onChange: next => setQuery(next == null ? '' : String(next))
              })
            ]
          })
        : null,

      nothingMatches
        ? jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: 'No models match the current filters.'
          })
        : jsx('div', {
            className: 'overflow-x-auto',
            children: jsxs('div', {
              style: { display: 'grid', gridTemplateColumns: gridTemplate, gap: '0.5rem' },
              children: [
                jsx('div', { className: headerClass, children: 'Model' }),
                jsx('div', { className: headerClass, children: 'Released' }),
                jsx('div', { className: cn(headerClass, 'text-right'), children: 'In' }),
                jsx('div', { className: cn(headerClass, 'text-right'), children: 'Out' }),
                jsx('div', { className: cn(headerClass, 'text-right'), children: 'Cache' }),
                jsx('div', { className: cn(headerClass, 'text-right'), children: 'Cap' }),
                jsx('div', { className: cn(headerClass, 'text-right'), children: '≈ Req/mo' }),
                jsx('div', { className: cn(headerClass, 'text-right'), children: 'ZDR' }),

                capped.map(modelRow),

                uncapped.length
                  ? jsx('div', {
                      className: 'border-b border-(--ui-stroke-secondary) py-1.5 text-[0.625rem] font-medium tracking-wide text-(--ui-text-quaternary) uppercase',
                      // Spans the grid with an inline style: the utility class that
                      // used to try this is one the app never compiles, so the
                      // divider sat in the first column only.
                      style: { gridColumn: '1 / -1' },
                      children: 'Also served by Go, no published cap'
                    })
                  : null,
                uncapped.map(modelRow)
              ]
            })
          }),

      unpriced.length
        ? jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            title: unpriced.map(m => m.id).join(', '),
            children: 'Served, no published price: ' + unpriced.map(m => m.name).join(', ')
          })
        : null,

      noteLines.length
        ? jsx('div', {
            className: 'flex flex-col gap-1 text-[0.6875rem] text-(--ui-text-quaternary)',
            children: noteLines.map((n, i) => jsx('div', { key: n.key, children: (i + 1) + ' ' + n.label + ': ' + n.text }))
          })
        : null,

      legendLines.length
        ? jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: legendLines.map((line, i) => jsx('div', { key: i, children: line }))
          })
        : null,

      (payload.plan && payload.plan.notes && payload.plan.notes.length)
        ? jsxs('div', {
            className: 'flex flex-col gap-1 text-[0.6875rem] text-(--ui-text-quaternary)',
            children: payload.plan.notes.map((n, i) => jsxs('div', { key: i, children: [jsx('strong', { children: n.name + ':' }), ' ', n.text] }))
          })
        : null,

      jsxs('div', {
        className: 'flex flex-col gap-1 text-[0.625rem] text-(--ui-text-quaternary)',
        children: [
          jsx('div', {
            children: 'Prices and caps from the OpenCode Go docs, cross-checked against the live catalog. '
              + (payload.counts ? payload.counts.catalog_mismatch + ' of ' + payload.counts.served + ' prices differ.' : '')
          }),
          payload.plan && (payload.plan.five_hour_share != null || payload.plan.weekly_share != null)
            ? jsx('div', {
                children: 'Window share rules: '
                  + (payload.plan.five_hour_share != null ? '5-hour = ' + Math.round(payload.plan.five_hour_share * 100) + '% of the monthly cap' : '')
                  + (payload.plan.five_hour_share != null && payload.plan.weekly_share != null ? '; ' : '')
                  + (payload.plan.weekly_share != null ? 'weekly = ' + Math.round(payload.plan.weekly_share * 100) + '%' : '')
                  + '.'
              })
            : null,
          fetchedMs ? jsx('div', { children: 'Fetched at ' + new Date(fetchedMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) }) : null
        ]
      })
    ]
  })
}

// One credential's own block: its name (and where it comes from) plus its own
// three quota windows. The gateway returns one of these per key in the pool, so
// a two-key account shows both limits instead of only the highest-priority one.
function KeyBlock({ k, now, settings }) {
  const wins = windowList({ windows: k.windows })
  const failed = k.ok === false || wins.length === 0
  // The pool benched this key after a failure (e.g. 'exhausted'): the badge says
  // so, and its cooldown end is worth carrying in the tooltip.
  const poolNote = k.pool_status && k.pool_status !== 'ok' ? String(k.pool_status) : null
  const poolTitle = poolNote ? poolNote + (k.benched_until ? ' until ' + k.benched_until : '') : null
  // The credential's configured label is a tooltip / opt-in detail, never the
  // heading: see displayName().
  const raw = k.label ? String(k.label) : null
  const source = k.source ? String(k.source) : null
  const showRaw = Boolean(settings && settings.showRawNames)
  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        title: [raw, source, poolTitle].filter(Boolean).join(' · ') || undefined,
        children: [
          jsx(StatusDot, { tone: failed ? 'bad' : k.benched ? 'warn' : 'good' }),
          jsx('span', {
            className: 'text-[0.75rem] font-medium text-foreground',
            children: displayName(k)
          }),
          k.active && !k.benched
            ? jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'in use' })
            : null,
          showRaw && raw
            ? jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: raw })
            : null,
          showRaw && source
            ? jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: source })
            : null,
          poolNote
            ? jsx(Badge, { variant: 'warn', size: 'xs', title: poolTitle || undefined, children: poolNote })
            : null
        ]
      }),
      failed
        ? jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-red)',
            children: k.error || 'no usage data for this key'
          })
        : jsx('div', {
            className: 'grid gap-6 sm:grid-cols-3',
            children: wins.map((win, index) => jsx(WindowColumn, { key: win.key, win, now, first: index === 0 }))
          })
    ]
  })
}

// ---- settings panel --------------------------------------------------------
// Every control writes through applySettings(), which sanitises, persists the whole
// blob and re-arms the poll timer, so a change is live at once and survives a
// reload. Nothing here is required reading: the defaults are what the plugin did
// before these controls existed.
function SettingsPanel({ settings, keys }) {
  const total = Array.isArray(keys) ? keys.length : 0
  const rowClass = 'flex flex-wrap items-center gap-x-3 gap-y-2'
  const labelClass = 'text-[0.6875rem] text-(--ui-text-quaternary)'
  const save = patch => applySettings({ ...settings, ...patch })

  const chipOptions = [
    { id: 'auto', label: 'Key in use' },
    { id: 'combined', label: 'Combined' }
  ]
  if (total > 1) {
    for (let n = 1; n <= total; n += 1) chipOptions.push({ id: 'key:' + n, label: 'Key ' + n })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-3 pt-1',
    children: [
      jsx(Separator, {}),
      jsx('div', {
        className: 'text-[0.625rem] font-medium tracking-wide text-(--ui-text-quaternary) uppercase',
        children: 'Settings'
      }),

      // Only meaningful with more than one credential: a control that cannot
      // change anything is worse than no control.
      total > 1
        ? jsxs('div', {
            className: rowClass,
            children: [
              jsx('span', { className: labelClass, children: 'Chip shows' }),
              jsx(SegmentedControl, {
                options: chipOptions,
                value: String(settings.chipSource),
                onChange: next => save({ chipSource: String(next) })
              }),
              jsx('span', { className: labelClass, children: 'Combined = the mean of every key, what the whole pool is spending' })
            ]
          })
        : null,

      jsxs('div', {
        className: rowClass,
        children: [
          jsx(Switch, {
            checked: settings.chipLabel !== false,
            size: 'xs',
            'aria-label': 'Show the key position on the chip',
            onCheckedChange: next => save({ chipLabel: next === true })
          }),
          jsx('span', {
            className: labelClass,
            children: total > 1
              ? 'Show the key position on the chip, e.g. (2/' + total + ')'
              : 'Show the key position on the chip'
          })
        ]
      }),

      jsxs('div', {
        className: rowClass,
        children: [
          jsx('span', { className: labelClass, children: 'Refresh every' }),
          jsx(SegmentedControl, {
            options: REFRESH_CHOICES.map(s => ({ id: String(s), label: s < 60 ? s + 's' : (s / 60) + 'm' })),
            value: String(settings.refreshSec),
            onChange: next => save({ refreshSec: Number(next) })
          })
        ]
      }),

      jsxs('div', {
        className: rowClass,
        children: [
          jsx('span', { className: labelClass, children: 'Dot turns amber at' }),
          jsx(SegmentedControl, {
            options: WARN_CHOICES.map(w => ({ id: String(w), label: w + '%' })),
            value: String(settings.warnAt),
            onChange: next => save({ warnAt: Number(next) })
          }),
          jsx('span', { className: labelClass, children: 'Red starts at ' + WARN_CEILING + '%.' })
        ]
      }),

      jsxs('div', {
        className: rowClass,
        children: [
          jsx(Switch, {
            checked: settings.showRawNames === true,
            size: 'xs',
            'aria-label': 'Show credential names from the gateway config',
            onCheckedChange: next => save({ showRawNames: next === true })
          }),
          jsx('span', { className: labelClass, children: 'Show credential names from the gateway config' })
        ]
      })
    ]
  })
}

function UsagePage() {
  const snap = useValue($snap)
  const error = useValue($error)
  const loading = useValue($loading)
  const updatedAt = useValue($updatedAt)
  const now = useValue($now)
  const models = useValue($models)
  const modelsError = useValue($modelsError)
  const modelsAt = useValue($modelsAt)
  const settings = useValue($settings)

  // The app keeps this route mounted while you are elsewhere in it, so a check on
  // mount alone is not "every time the page is opened": re-check on a slow tick as
  // well. Both paths read the atoms rather than the captured values, and neither
  // touches the network while the data is still fresh.
  useEffect(() => {
    const check = () => {
      if (pageStale($updatedAt.get(), Date.now())) void refresh()
      if ($modelsAt.get() == null || Date.now() - $modelsAt.get() > MODELS_TTL_MS) void refreshModels()
    }
    check()
    const timer = setInterval(check, PAGE_RECHECK_MS)
    return () => clearInterval(timer)
  }, [])

  const windows = windowList(snap)
  // A multi-key account gets one entry per credential in the pool from the
  // gateway, whatever the keys are named; render each key's own windows rather
  // than only the top-priority key's. One key (the common case) or a payload
  // with no `keys` at all falls through to the plain single grid below, so the
  // familiar layout is unchanged for a single-credential install.
  const keyList = snap && Array.isArray(snap.keys) ? snap.keys : null
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
      ].filter(Boolean).join(' · ')
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
            onClick: () => openExternal(CONSOLE_URL),
            children: 'Console'
          }),
          jsx(Button, {
            variant: 'secondary',
            size: 'xs',
            loading: loading,
            onClick: () => {
              void refresh()
              void refreshModels(true)
            },
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

          keyList && keyList.length > 1
            ? jsx('div', {
                className: 'flex flex-col gap-6',
                children: keyList.map((k, index) => jsx(KeyBlock, { key: 'k' + (k.ordinal || index), k, now, settings }))
              })
            : windows.length
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

          jsx(ModelsTable, { models, error: modelsError }),

          jsx(SettingsPanel, { settings, keys: keyList }),

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

  const settings = useValue($settings)
  // Which key the chip reports is a setting: the key in use (default), the whole
  // pool combined, or one specific key. Following the key in use matters because a
  // benched top-priority key would otherwise report its capped-out numbers here as
  // if they were what the account is spending right now.
  const keys = snap && Array.isArray(snap.keys) ? snap.keys : null
  const picked = chipSelection(keys, settings)
  const windows = picked.windows.length ? picked.windows : windowList(snap)

  const worst = windows.reduce((acc, w) => Math.max(acc, w.used_percent || 0), 0)
  const text = windows.length
    ? windows.map(w => (w.used_percent == null ? '--' : Math.round(w.used_percent))).join('/') + '%'
    : loading
      ? '...'
      : '--'
  // The position marker ('2/2', 'all') says where the numbers came from without
  // repeating a credential's configured name.
  const marker = settings.chipLabel && picked.marker ? '(' + picked.marker + ')' : null

  const tip = keys && keys.length > 1
    ? (picked.marker === 'all'
        ? ['combined pool: ' + (windows.length
            ? windows.map(w => (w.used_percent == null ? '--' : Math.round(w.used_percent))).join('/') + '%'
            : 'no data')]
        : []
      ).concat(keys.map(k => {
        const ks = windowList({ windows: k.windows })
        const pcts = ks.length
          ? ks.map(w => (w.used_percent == null ? '--' : Math.round(w.used_percent))).join('/') + '%'
          : 'no data'
        const shown = picked.marker && picked.marker !== 'all' && String(picked.marker).split('/')[0] === String(k.ordinal)
        const standing = k.active ? 'in use' : k.benched ? 'benched' : 'standby'
        const raw = settings.showRawNames && k.label ? ' [' + k.label + ']' : ''
        return (shown ? '▶ ' : '') + displayName(k) + ' · ' + standing + raw + ' ' + pcts
      })).join('   |   ') + '   (click for the full page)'
    : windows.length
      ? windows.map(w => {
          const at = parseMs(w.resets_at)
          return w.label + ' ' + w.used_percent + '% · resets in ' + (at == null ? '--' : fmtCountdown(at - now))
        }).join('  |  ') + '   (click for the full page)'
      : error
        ? 'OpenCode Go usage unavailable: ' + error
        : 'OpenCode Go usage — click to open'

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
      marker
        ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: marker })
        : null,
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
    pluginCtx = ctx
    async function runScript(scriptName) {
      if (SCRIPTS_DIR.startsWith('__HERMES')) {
        throw new Error('run install.sh on the gateway')
      }
      const cached = ctx.storage && typeof ctx.storage.get === 'function' ? ctx.storage.get('py_cmd') : null
      const candidates = cached && typeof cached === 'string' ? [cached] : PY_CANDIDATES
      let lastCode = null
      let lastError = null
      let sawOutput = false
      const scriptPath = SCRIPTS_DIR + '/' + scriptName
      for (const py of candidates) {
        try {
          // Double-quoted: a scripts dir containing a space (C:/Users/John Smith/...,
          // ~/Library/Application Support/...) otherwise splits into two argv
          // tokens, and the failure reads as a missing python instead of a bad
          // path. Quirk: under POSIX sh a literal $ or backtick in the path would
          // still expand -- rare in a scripts dir, and narrower than no quoting.
          const resp = await host.request('shell.exec', { command: py + ' "' + scriptPath + '"' })
          const stdout = resp && resp.stdout ? String(resp.stdout) : ''
          if (stdout) sawOutput = true
          const code = resp && typeof resp.code === 'number' ? resp.code : 0
          lastCode = code
          const parsed = parseSnapshot(stdout)
          if (code === 0 && parsed) {
            const snap = await unwrap(parsed)
            if (ctx.storage && typeof ctx.storage.set === 'function' && py !== cached) {
              ctx.storage.set('py_cmd', py)
            }
            return snap
          }
        } catch (e) {
          // fall through to next candidate, but keep the reason for the final error
          lastError = e
        }
      }
      const tried = (cached ? [cached] : PY_CANDIDATES).join(', ')
      throw new Error('no working python on the gateway shell (tried ' + tried + ')' + (lastCode != null ? '; exit ' + lastCode : '') + (lastError ? '; ' + (lastError.message || lastError) : '') + (sawOutput ? '; the script printed output this plugin could not parse (larger than the gateway reply limit?)' : '') + '; run install.sh on the gateway')
    }

    // Settings: hydrate from storage (sanitised), and hand the settings UI a way
    // to persist a change and re-arm the poll timer if the interval moved.
    const storedSettings = ctx.storage && typeof ctx.storage.get === 'function' ? ctx.storage.get(SETTINGS_KEY, null) : null
    $settings.set(sanitizeSettings(storedSettings))

    function armRefreshTimer() {
      if (refreshTimer) clearInterval(refreshTimer)
      const secs = Number($settings.get().refreshSec)
      refreshTimer = setInterval(() => void refresh(), (Number.isFinite(secs) && secs >= 10 ? secs : DEFAULT_SETTINGS.refreshSec) * 1000)
    }

    applySettings = next => {
      const clean = sanitizeSettings(next)
      $settings.set(clean)
      if (ctx.storage && typeof ctx.storage.set === 'function') ctx.storage.set(SETTINGS_KEY, clean)
      armRefreshTimer()
    }

    // Storage key v2: the payload gained the per-model `released` date, so a v1
    // cache would render a column of dashes for up to the 6h TTL. Ignore it.
    const storedModels = ctx.storage && typeof ctx.storage.get === 'function' ? ctx.storage.get('models_v2') : null
    if (storedModels && typeof storedModels === 'object' && storedModels.models) {
      $models.set(storedModels)
      // Refetch guard only: the table's 'updated <age>' and 'Fetched at' lines read
      // the payload's own fetched_at, so a restored list shows its real age.
      $modelsAt.set(Date.now() - 60 * 1000)
    }

    refresh = async () => {
      $loading.set(true)
      try {
        const snap = await runScript(SCRIPT_NAME)
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

    refreshModels = async (force) => {
      if (!force && $modelsAt.get() && Date.now() - $modelsAt.get() < MODELS_TTL_MS) return
      $modelsLoading.set(true)
      try {
        const payload = await runScript(MODELS_SCRIPT)
        if (payload.ok === false) {
          $modelsError.set(String(payload.error || 'models endpoint returned no data'))
          return
        }
        $models.set(payload)
        $modelsAt.set(Date.now())
        $modelsError.set(null)
        if (ctx.storage && typeof ctx.storage.set === 'function') {
          ctx.storage.set('models_v2', payload)
        }
      } catch (e) {
        $modelsError.set('Gateway call failed: ' + (e && e.message ? e.message : String(e)))
      } finally {
        $modelsLoading.set(false)
      }
    }

    void refresh()
    const tickTimer = setInterval(() => $now.set(Date.now()), TICK_MS)
    armRefreshTimer() // refreshSec is a setting, so the poll timer is re-armable

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
          run: () => {
            void refresh()
            void refreshModels(true)
          }
        }
      }
    ])

    const dispose = () => {
      if (refreshTimer) clearInterval(refreshTimer)
      clearInterval(tickTimer)
    }
    if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose)
  }
}

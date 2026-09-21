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
const MODELS_TTL_MS = 6 * 3600000
const TICK_MS = 1000
// `install.sh` sets the SCRIPTS_DIR constant below to this gateway's scripts path.
const SCRIPT_NAME = 'opencode_go_usage.py'
const MODELS_SCRIPT = 'opencode_go_models.py'
const SCRIPTS_DIR = '/home/ubuntu/.hermes/scripts'
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

let refresh = async () => {}
let refreshModels = async () => {}

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

// A registry release_date is a bare 'YYYY-MM-DD' in UTC with no time of day.
// Format it through the regex and the month table below, NEVER through
// new Date() + a local formatter: a bare date parses as UTC midnight, which in
// any zone west of UTC (America/Phoenix, UTC-7) renders the PREVIOUS day. The
// registry value is reported as published, never clamped or shifted.
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function fmtReleaseDate(raw) {
  const match = ISO_DATE_RE.exec(String(raw == null ? '' : raw).trim())
  if (!match) return null
  const month = MONTH_ABBR[Number(match[2]) - 1]
  const day = Number(match[3])
  if (!month || !(day >= 1 && day <= 31)) return null
  return month + ' ' + day + ', ' + match[1]
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

function fmtInt(n) {
  if (!Number.isFinite(n)) return null
  return Math.round(n).toLocaleString()
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

function ModelsTable({ models, error }) {
  const payload = models && models.models ? models : null
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
  // A served model with nothing published at all (no prices and no cap) would
  // render as a row of dashes; name it once under the table instead.
  const hasPrice = m => m.input != null || m.output != null || m.cache_read != null || m.monthly_usd != null
  const capped = list.filter(m => m.monthly_usd != null)
  const uncapped = list.filter(m => m.monthly_usd == null && hasPrice(m))
  const unpriced = list.filter(m => m.monthly_usd == null && !hasPrice(m))
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

  function superMark(text) {
    return jsx('span', { className: 'align-super text-[0.5rem]', children: text })
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
            onClick: () => window.open(payload.docs_url, '_blank', 'noopener'),
            children: 'Go docs'
          })
        ]
      }),

      (payload.promos || []).length
        ? jsxs('div', {
            className: 'flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem] text-(--ui-orange)',
            children: payload.promos.map(p => {
              const before = p.monthly_before_usd != null ? fmtCap(p.monthly_before_usd) : null
              const after = p.monthly_usd != null ? fmtCap(p.monthly_usd) : null
              return jsx('span', {
                key: p.model_key,
                children: p.name + ' — ' + p.label + (before && after ? ' (' + before + ' → ' + after + ' cap)' : '')
              })
            })
          })
        : null,

      (payload.announcements || []).length
        ? jsxs('div', {
            className: 'flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem] text-(--ui-orange)',
            children: payload.announcements.map(a => jsx('span', {
              key: a.model_key,
              title: a.source,
              className: 'cursor-pointer hover:underline',
              onClick: () => window.open(a.source, '_blank', 'noopener'),
              children: a.name + ' — ' + a.note + ' (announced ' + a.date + ')'
            }))
          })
        : null,

      error
        ? jsx('div', { className: 'text-[0.75rem] text-(--ui-red)', children: error })
        : null,

      jsx('div', {
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
                  className: 'col-span-8 border-b border-(--ui-stroke-secondary) py-1.5 text-[0.625rem] font-medium tracking-wide text-(--ui-text-quaternary) uppercase',
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

function UsagePage() {
  const snap = useValue($snap)
  const error = useValue($error)
  const loading = useValue($loading)
  const updatedAt = useValue($updatedAt)
  const now = useValue($now)
  const models = useValue($models)
  const modelsError = useValue($modelsError)
  const modelsAt = useValue($modelsAt)

  useEffect(() => {
    if (updatedAt == null || Date.now() - updatedAt > POLL_MS) void refresh()
    if (modelsAt == null || Date.now() - modelsAt > MODELS_TTL_MS) void refreshModels()
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
            onClick: () => window.open(CONSOLE_URL, '_blank', 'noopener'),
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

          jsx(ModelsTable, { models, error: modelsError }),

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
          const resp = await host.request('shell.exec', { command: py + ' ' + scriptPath })
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
          run: () => {
            void refresh()
            void refreshModels(true)
          }
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

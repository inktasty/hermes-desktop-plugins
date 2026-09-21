/**
 * Hermes desktop plugin: current-session usage chip.
 * Plain ESM, loaded uncompiled: UI is jsx() calls, not JSX syntax.
 * Imports: @hermes/plugin-sdk, react, react/jsx-runtime.
 *
 * Shows live per-session API calls / context fill / session cost on hover.
 * The status-bar chip itself shows ONLY the session cost (total tokens and
 * cache-hit rate already have their own Hermes chips).
 *
 * Cost has two sources:
 *  1. `dev_credits_spent_micros` (exact, Nous-routed sessions only),
 *  2. otherwise an estimate from tokens x the model's rates, read over
 *     `shell.exec` from `scripts/model_price_lookup.py` on the gateway (that
 *     script reads the local models.dev registry cache — Hermes's own cost
 *     estimator has no price path for providers like opencode-go).
 * Pairs with the nous-balance plugin (credits), kept deliberately separate.
 */

import { atom, cn, host, Popover, PopoverContent, PopoverTrigger, useValue } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx } from 'react/jsx-runtime'

const ID = 'session-usage'
const POLL_MS = 120000 // light poll; most updates arrive via the live stream
// `install.sh` sets the SCRIPTS_DIR constant below to this gateway's scripts path.
const SCRIPT_NAME = 'model_price_lookup.py'
const SCRIPTS_DIR = '/home/ubuntu/.hermes/scripts'
const PY_CANDIDATES = ['python3', 'python', 'py -3']

// Live atoms are resolved ONCE at import, each with a null-atom fallback: a
// build that lacks one of them can then never throw inside a render, and every
// useValue call stays unconditional (a conditional hook shifts React's call
// order and throws #310 "rendered more hooks than during the previous render").
const NULL_ATOM = atom(null)
const STATE = (host && host.state) || {}
const USAGE_ATOM = STATE.focusedUsage || NULL_ATOM
const FOCUS_ATOM = STATE.focusedSessionId || NULL_ATOM
const ACTIVE_ATOM = STATE.activeSessionId || NULL_ATOM

function focusedSid() {
  try {
    return FOCUS_ATOM.get() || ACTIVE_ATOM.get() || null
  } catch (e) {
    return null
  }
}

// ---- Formatting -------------------------------------------------------------

function fmtTokens(n) {
  if (n == null || !Number.isFinite(n)) return null
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'K'
  return String(n)
}

function fmtCents(micros) {
  // micros -> dollars, trimmed to meaningful digits
  const d = micros / 1000000
  if (d === 0) return '$0.00'
  if (d < 0.01) return '$' + d.toFixed(4)
  if (d < 1) return '$' + d.toFixed(3)
  return '$' + d.toFixed(2)
}

function fmtUsd(d) {
  if (!Number.isFinite(d)) return null
  if (d === 0) return '$0.00'
  if (d < 0.01) return '$' + d.toFixed(4)
  if (d < 1) return '$' + d.toFixed(3)
  return '$' + d.toFixed(2)
}

// ---- Cost estimation --------------------------------------------------------

// Rates come from the gateway (models.dev registry cache) as $ per 1M tokens.
function parseRates(stdout) {
  const lines = String(stdout || '').split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue
    try {
      const parsed = JSON.parse(lines[i])
      if (parsed && parsed.ok === true && Number.isFinite(parsed.input) && Number.isFinite(parsed.output)) return parsed
      return null
    } catch (e) {
      return null
    }
  }
  return null
}

// ---- Peak windows -----------------------------------------------------------

// DeepSeek bills peak (2x the off-peak card) at 01:00-04:00 and 06:00-10:00 UTC,
// Monday to Friday. Every provider that resells DeepSeek models on that same
// card doubles what the registry lists for them.
const PEAK_BLOCKS = [[1, 4], [6, 10]] // UTC hours, start inclusive / end exclusive
const PEAK_MULTIPLIER = 2
const PEAK_PROVIDERS = ['opencode-go', 'opencode-zen', 'opencode', 'deepseek', 'openrouter']

function isPeakNow(ms) {
  const d = new Date(ms)
  const day = d.getUTCDay()
  if (day < 1 || day > 5) return false
  const hour = d.getUTCHours()
  return PEAK_BLOCKS.some(block => hour >= block[0] && hour < block[1])
}

function isDeepSeekModel(model) {
  return /deepseek/i.test(String(model || ''))
}

function peakApplies(model, provider) {
  const name = String(provider || '').toLowerCase()
  return /deepseek/i.test(String(model || '')) && PEAK_PROVIDERS.indexOf(name) >= 0
}

// $ per 1M tokens, doubled when the peak card is in effect.
function rateCard(rates, peak) {
  const mult = peak ? PEAK_MULTIPLIER : 1
  return {
    input: rates.input * mult,
    output: rates.output * mult,
    cacheRead: (Number.isFinite(rates.cache_read) ? rates.cache_read : rates.input) * mult,
    priced: Number.isFinite(rates.cache_read)
  }
}

// Cache reads are derived from cache_hit_pct against the prompt total; the
// other counters come straight from the gateway.
function tokensOf(u) {
  const prompt = Number.isFinite(u.prompt) && u.prompt > 0 ? u.prompt : Number.isFinite(u.input) ? u.input : 0
  const output = Number.isFinite(u.output) ? u.output : 0
  const pct = Number.isFinite(u.cache_hit_pct) ? Math.max(0, Math.min(100, u.cache_hit_pct)) : 0
  const cacheRead = prompt * (pct / 100)
  return { prompt, output, cacheRead, miss: Math.max(0, prompt - cacheRead) }
}

function costOf(miss, cacheRead, output, card) {
  return (miss * card.input + cacheRead * card.cacheRead + output * card.output) / 1000000
}

// Price only the tokens NEW since the last sample, at the card in effect now, so
// a session that crosses a peak boundary is not repriced as a whole. The first
// sample of a session prices whatever it already has at that moment's card.
// `sessionModel` is the model THIS session actually ran (from its usage frame);
// the rate card alone can say deepseek while the session ran something else,
// because loadRates falls back to the configured default before the first
// session report lands. Peak 2x applies only when BOTH agree on DeepSeek.
function accumulate(prev, u, rates, nowMs, sessionModel) {
  if (!u || !rates) return prev || null
  const peak = peakApplies(rates.model, rates.provider)
    && isDeepSeekModel(sessionModel || rates.model)
    && isPeakNow(nowMs)
  const card = rateCard(rates, peak)
  const now = tokensOf(u)
  const base = prev || { miss: 0, cacheRead: 0, output: 0, usd: 0 }
  const deltaUsd = costOf(
    Math.max(0, now.miss - (base.miss || 0)),
    Math.max(0, now.cacheRead - (base.cacheRead || 0)),
    Math.max(0, now.output - (base.output || 0)),
    card
  )
  const usd = (base.usd || 0) + deltaUsd
  if (!Number.isFinite(usd)) return prev || null
  const tierApplies = peakApplies(rates.model, rates.provider)
  return {
    usd,
    peak,
    tierApplies,
    priced: card.priced,
    provider: rates.provider,
    model: rates.model,
    miss: now.miss,
    cacheRead: now.cacheRead,
    output: now.output
  }
}

// Merge a live streamed usage frame over the last polled snapshot.
// Monotonic max on counters guards against an out-of-order event clobbering
// newer polled numbers.
function mergeUsage(polled, live) {
  const base = polled ? { ...polled } : {}
  if (!live || typeof live !== 'object') return base
  for (const k of ['input', 'output', 'reasoning', 'total', 'calls', 'prompt', 'completion']) {
    if (Number.isFinite(live[k])) {
      if (!Number.isFinite(base[k]) || live[k] > base[k]) base[k] = live[k]
    }
  }
  for (const k of ['context_used', 'context_max', 'compressions']) {
    if (Number.isFinite(live[k])) base[k] = Math.max(base[k] || 0, live[k])
  }
  // cache_hit_pct is a ratio, not a counter: take the latest value, never max.
  if (Number.isFinite(live.cache_hit_pct)) base.cache_hit_pct = live.cache_hit_pct
  if (typeof live.model === 'string' && live.model) base.model = live.model
  if (Number.isFinite(live.dev_credits_spent_micros)) base.dev_credits_spent_micros = live.dev_credits_spent_micros
  if (typeof live.active_subagents === 'number') base.active_subagents = live.active_subagents
  return base
}

// ---- UI --------------------------------------------------------------------

function Row({ label, value, strong }) {
  return jsx('div', {
    className: 'flex items-center justify-between gap-3',
    children: [
      jsx('span', { className: 'text-(--ui-text-secondary)', children: label }),
      jsx('span', { className: strong ? 'font-semibold text-foreground' : 'text-foreground', children: value })
    ]
  })
}

// Rates are small numbers: keep the digits that matter, and never a bare '$0.6'
// where the neighbours carry two decimals ('$0.60' next to '$4.40').
function trimMoney(text) {
  const parts = String(text).split('.')
  if (parts.length !== 2) return String(text)
  const kept = parts[1].replace(/0+$/, '')
  return parts[0] + '.' + (kept.length >= 2 ? kept : parts[1].slice(0, 2))
}

function fmtRateAmount(n) {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '$0'
  if (n < 0.01) return '$' + String(Number(n.toFixed(6)))
  if (n < 1) return '$' + trimMoney(n.toFixed(3))
  return '$' + n.toFixed(2)
}

// Rates read as a small reference block: one muted caption line, one data line of
// label/value pairs. Three prices never crowd a single label/value row this way,
// and each number keeps its own label instead of relying on the caption's order.
function RateBlock({ card, peak }) {
  const cells = [
    ['in', card.input],
    ['out', card.output],
    ['cache', card.cacheRead]
  ]
  return jsx('div', {
    className: 'space-y-1 pt-0.5',
    children: [
      jsx('div', {
        className: 'text-[10px] text-(--ui-text-quaternary)',
        children: peak ? 'Peak rates per 1M tokens (2\u00d7)' : 'Rates per 1M tokens'
      }),
      jsx('div', {
        className: 'flex items-baseline justify-between gap-2 text-[0.6875rem] tabular-nums',
        children: cells.map(cell => jsx('span', {
          key: cell[0],
          className: 'flex items-baseline gap-1',
          children: [
            jsx('span', { className: 'text-(--ui-text-quaternary)', children: cell[0] }),
            jsx('span', { className: 'text-foreground', children: fmtRateAmount(cell[1]) })
          ]
        }))
      })
    ]
  })
}

function SessionPanel({ u, est, error, rates }) {
  const billed = Number.isFinite(u && u.dev_credits_spent_micros)
  const peak = est ? est.peak : false
  const card = rates ? rateCard(rates, peak) : null
  const kids = [
    jsx('div', {
      key: 'head',
      className: 'flex items-center justify-between',
      children: [
        jsx('span', { className: 'font-semibold text-foreground', children: 'This session' }),
        u.model ? jsx('span', { className: 'max-w-[150px] truncate text-[10px] text-(--ui-text-tertiary)', title: u.model, children: u.model }) : null
      ]
    })
  ]

  const tot = fmtTokens(u && u.total)
  if (tot == null && !(u && u.calls) && !Number.isFinite(u && u.context_percent)) {
    kids.push(jsx('div', { key: 'empty', className: 'text-[11px] text-(--ui-text-tertiary)', children: 'No turns yet in this session' }))
    if (card) {
      kids.push(jsx(RateBlock, { key: 'rates', card, peak }))
    }
    return jsx('div', { className: 'space-y-1.5', children: kids })
  }

  if (u && u.input != null) kids.push(jsx(Row, { key: 'in', label: 'Input tokens', value: fmtTokens(u.input) || '0' }))
  if (u && u.output != null) kids.push(jsx(Row, { key: 'out', label: 'Output tokens', value: fmtTokens(u.output) || '0' }))
  if (u && Number.isFinite(u.reasoning) && u.reasoning > 0) kids.push(jsx(Row, { key: 'reas', label: 'Reasoning tokens', value: fmtTokens(u.reasoning) || '0' }))
  if (tot != null) kids.push(jsx(Row, { key: 'tot', label: 'Total tokens', value: tot, strong: true }))
  if (u && Number.isFinite(u.cache_hit_pct)) kids.push(jsx(Row, { key: 'cache', label: 'Cache hit', value: '◎ ' + u.cache_hit_pct + '%' }))
  if (u && u.calls != null) kids.push(jsx(Row, { key: 'calls', label: 'API calls', value: String(u.calls) }))
  kids.push(
    jsx(Row, {
      key: 'cost',
      label: billed ? 'Session cost' : 'Session cost (est.)',
      value: billed ? fmtCents(u.dev_credits_spent_micros) : est ? fmtUsd(est.usd) : '—'
    })
  )
  if (card) {
    kids.push(jsx(RateBlock, { key: 'rates', card, peak }))
  }
  if (u && Number.isFinite(u.context_percent)) kids.push(jsx(Row, { key: 'ctx', label: 'Context used', value: u.context_percent + '%' }))
  if (u && Number.isFinite(u.compressions) && u.compressions > 0) kids.push(jsx(Row, { key: 'comp', label: 'Compressions', value: String(u.compressions) }))
  if (u && Number.isFinite(u.active_subagents)) kids.push(jsx(Row, { key: 'subs', label: 'Active subagents', value: String(u.active_subagents) }))

  if (error) {
    kids.push(jsx('div', { key: 'pyerr', className: 'pt-0.5 text-[10px] text-(--ui-red)', children: error }))
  }
  if (billed) {
    kids.push(costNote('key-billed', 'Billed spend reported by the provider'))
  } else if (est) {
    const tier = est.tierApplies ? (est.peak ? ' · peak rates (2×)' : ' · off-peak rates') : ''
    const cache = est.priced ? '' : ' · no cache-read rate, cached tokens priced as input'
    kids.push(costNote('est', 'Estimated at ' + est.provider + ' / ' + est.model + ' rates' + tier + cache))
  } else {
    kids.push(costNote('nocost', 'No spend reported and no rates cached for this model'))
  }

  return jsx('div', { className: 'space-y-1.5', children: kids })
}

function costNote(key, text) {
  return jsx('div', { key, className: 'pt-0.5 text-[10px] text-(--ui-text-quaternary)', children: text })
}

export { SessionPanel }

export default {
  id: ID, // must match the folder name
  name: 'Session Usage',
  SessionPanel,
  register(ctx) {
    const sessData = atom({})   // merged usage map: { [sid]: usage }
    const fetchedAt = atom({})  // fetched time map: { [sid]: time }
    const ratesData = atom(null) // { input, output, cache_read, provider, model } from the gateway
    const ratesError = atom(null) // last script-run diagnostic, visible in the panel
    const costData = atom({})   // { [sid]: { usd, peak, provider, model, ... } } estimated spend
    let ratesFor = null         // model id the cached rates belong to

    // Rates are per 1M tokens, read from the gateway's model registry cache
    // (Hermes's own estimator cannot price providers like opencode-go).
    async function runPriceScript(args) {
      if (SCRIPTS_DIR.startsWith('__HERMES')) {
        throw new Error('run install.sh on the gateway')
      }
      const cached = ctx.storage && typeof ctx.storage.get === 'function' ? ctx.storage.get('py_cmd') : null
      const candidates = cached && typeof cached === 'string' ? [cached] : PY_CANDIDATES
      let lastCode = null
      const scriptPath = SCRIPTS_DIR + '/' + SCRIPT_NAME
      for (const py of candidates) {
        try {
          const resp = await host.request('shell.exec', { command: py + ' ' + scriptPath + (args ? ' ' + args : '') })
          const stdout = resp && resp.stdout ? String(resp.stdout) : ''
          const code = resp && typeof resp.code === 'number' ? resp.code : 0
          lastCode = code
          const parsed = parseRates(stdout)
          if (code === 0 && parsed) {
            if (ctx.storage && typeof ctx.storage.set === 'function' && py !== cached) {
              ctx.storage.set('py_cmd', py)
            }
            return parsed
          }
        } catch (e) {
          // fall through to next candidate
        }
      }
      const tried = (cached ? [cached] : PY_CANDIDATES).join(', ')
      throw new Error('no working python on the gateway shell (tried ' + tried + ')' + (lastCode != null ? '; exit ' + lastCode : '') + '; run install.sh on the gateway')
    }

    async function loadRates(model) {
      const want = String(model || '').trim()
      if (ratesFor === want) return
      try {
        const parsed = await runPriceScript(want ? JSON.stringify(want) : '')
        ratesFor = parsed ? want : null
        ratesData.set(parsed)
        ratesError.set(null)
      } catch (e) {
        ratesFor = null
        ratesData.set(null)
        ratesError.set(e && e.message ? e.message : String(e))
      }
    }

    // Persist the running estimate so each new chunk of tokens is priced at the
    // card in effect when it was spent (see accumulate()).
    function trackCost(sid, usage) {
      const rates = ratesData.get()
      if (!sid || !usage || !rates) return
      const prev = costData.get()[sid] || null
      const next = accumulate(prev, usage, rates, Date.now(), usage.model)
      if (!next) return
      if (prev && prev.usd === next.usd && prev.peak === next.peak && prev.model === next.model) return
      costData.set({ ...costData.get(), [sid]: next })
    }

    async function fetchOnce() {
      const sid = focusedSid()
      if (!sid) return
      try {
        const resp = await host.request('session.usage', { session_id: sid })
        if (resp && typeof resp === 'object') {
          delete resp.credits_lines // nous-balance owns credits display
          const curMap = sessData.get()
          const prev = curMap[sid] || null
          const merged = mergeUsage(prev, resp)
          merged.sid = sid
          sessData.set({ ...curMap, [sid]: merged })
          const times = fetchedAt.get()
          fetchedAt.set({ ...times, [sid]: new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) })
          // Await the rates BEFORE pricing: trackCost() reads whatever card is
          // cached, so pricing first would charge this session's opening
          // sample to the previously loaded model's rates.
          if (merged.model) await loadRates(merged.model)
          trackCost(sid, merged)
        }
      } catch (e) {
        // Poll failure is non-fatal; the live stream still updates tokens.
      }
    }

    fetchOnce()
    void loadRates() // rates for the configured model, before the first session lands
    const timer = setInterval(fetchOnce, POLL_MS)

    function SessionChip() {
      const sessMap = useValue(sessData)
      const timesMap = useValue(fetchedAt)
      const rates = useValue(ratesData)
      const ratesErr = useValue(ratesError)
      const costs = useValue(costData)
      const focusValue = useValue(FOCUS_ATOM)
      const sid = focusValue || ACTIVE_ATOM.get()

      const sess = sessMap[sid] || null
      const updated = timesMap[sid] || null

      useEffect(() => {
        fetchOnce()
      }, [sid])

      // Live mid-turn counters, if this app build exposes them.
      const live = useValue(USAGE_ATOM)

      const u = mergeUsage(sess, live)

      const [open, setOpen] = useState(false)

      // Chip = session cost only. Total tokens and cache-hit rate are Hermes's
      // own chips; do not repeat them here. Everything else stays in the panel.
      // Exact billed spend wins; otherwise the running token estimate. The atom
      // holds the accumulated figure; this render also folds in anything new
      // since the last sample (accumulate() is pure).
      const billed = u && Number.isFinite(u.dev_credits_spent_micros) ? fmtCents(u.dev_credits_spent_micros) : null
      const extra = accumulate(costs[sid] || null, u, rates, Date.now(), u.model) || costs[sid] || null
      const est = rates ? extra : costs[sid] || null
      useEffect(() => {
        trackCost(sid, u)
      }, [sid, sid ? costs[sid] && costs[sid].usd : 0, rates, u.total, u.output])
      const cost = billed || (est ? fmtUsd(est.usd) : null)
      const display = cost || 'usage'
      const hasSess = u && ((u.total > 0) || u.calls > 0 || Number.isFinite(u.context_percent))

      return jsx(Popover, {
        open,
        onOpenChange: setOpen,
        children: [
          jsx(PopoverTrigger, {
            asChild: true,
            children: jsx('button', {
              className: cn(
                'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] font-mono transition-colors',
                cost
                  ? 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground'
                  : 'text-(--ui-text-tertiary)'
              ),
              type: 'button',
              onMouseEnter: () => setOpen(true),
              onMouseLeave: () => setOpen(false),
              onClick: () => {
                fetchOnce()
              },
              children: display
            })
          }),
          jsx(PopoverContent, {
            side: 'top',
            align: 'end',
            sideOffset: 6,
            className: 'pointer-events-none w-[19rem] select-none',
            children: jsx(SessionPanel, { u, est, error: ratesErr, rates })
          })
        ]
      })
    }

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 20,
      render: () => jsx(SessionChip, {})
    })

    const dispose = () => clearInterval(timer)
    if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose)
  }
}
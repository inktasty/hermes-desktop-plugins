/**
 * Hermes desktop plugin: DeepSeek peak / off-peak rate chip.
 *
 * A single status-bar chip that turns green while DeepSeek bills off-peak and
 * orange while it bills peak (2x) on OpenCode Go. While any other model is
 * active for the focused session the same badge renders in the neutral
 * variant: same text, no color.
 *
 * No network, no gateway call for the tier: the billing tier is a pure
 * function of the UTC clock. DeepSeek prices per UTC hour, so the tier math is
 * done in UTC and only the tooltip is shown in the machine's local time.
 *
 * Peak: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. Everything else,
 * weekends included, is off-peak (half of peak).
 * Source: https://api-docs.deepseek.com/quick_start/pricing and
 * https://opencode.ai/docs/go/ (Go passes the same tiers through).
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls, not JSX syntax.
 * Deploy: %LOCALAPPDATA%\hermes\desktop-plugins\deepseek-rate\plugin.js
 */

// `host` is an SDK export, not a renderer global. Using it unimported throws a
// ReferenceError inside the render path, which the defensive readers swallow —
// the chip then renders neutral forever with no visible error.
import { atom, Badge, host, PALETTE_AREA, ROUTES_AREA, STATUSBAR_AREAS, Tip, useValue } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'deepseek-rate'
const PLANNER_ROUTE = '/deepseek-window-planner'
const MINUTE_MS = 60000

// The tier only changes on a UTC hour boundary, so a cheap local tick is exact
// enough to land the flip within seconds of the boundary without any polling.
const TICK_MS = 20000

// UTC peak blocks, start hour inclusive / end hour exclusive.
const PEAK_BLOCKS = [
  [1, 4],
  [6, 10]
]

// Peak windows in the viewer's own clock, for the tooltip. Built from the UTC
// blocks above so the text is right in ANY timezone: a hardcoded
// author-timezone string was wrong for every other user of this plugin.
function localHourLabel(ms) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', hour12: true }).format(new Date(ms))
}

function localPeakText(atMs) {
  const d = new Date(atMs)
  const midnightUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return PEAK_BLOCKS.map(
    b => localHourLabel(midnightUtc + b[0] * 3600000) + '-' + localHourLabel(midnightUtc + b[1] * 3600000)
  ).join(' and ')
}

// Badge variants this app build defines: default, muted, success, warn,
// destructive, outline, solid. "none" is deliberately NOT one of them, so the
// pill renders with the base classes only — the unfilled, uncolored look the
// chip wants whenever a non-DeepSeek model is active. If a future build adds a
// "none" (or any) variant that paints a color, re-check this chip: the look is
// the requirement here, not the variant name.
const NEUTRAL_VARIANT = 'none'

const MAX_SCAN_HOURS = 96 // longest off-peak stretch is ~63h (Fri 10:00 -> Mon 01:00 UTC)

// How often the focused session's own usage is re-read. The live stream
// (`focusedUsage`) only carries frames mid-turn, so a freshly opened session
// reports nothing until it polls; focus changes re-poll immediately.
const FOCUS_POLL_MS = 10000

// Only DeepSeek models have a peak tier. Match the slug anywhere in the model
// id: providers prefix it (deepseek/deepseek-v4-flash-0731, opencode-go
// slugs) but the token is unique to them.
function isDeepSeekModel(model) {
  return /deepseek/i.test(String(model || ''))
}

// ---- tier math -------------------------------------------------------------

function isPeak(ms) {
  const d = new Date(ms)
  const weekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5
  if (!weekday) return false
  const hour = d.getUTCHours()
  return PEAK_BLOCKS.some(b => hour >= b[0] && hour < b[1])
}

// DeepSeek's weekend (Sat/Sun UTC) has no peak tier at all, so the tooltip
// drops the window list there: one short line beats three when nothing can
// change until the week starts again.
function isWeekend(ms) {
  const day = new Date(ms).getUTCDay()
  return day === 0 || day === 6
}

function nextChangeAt(ms) {
  const d = new Date(ms)
  const thisHour = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())
  const peak = isPeak(ms)
  for (let i = 1; i <= MAX_SCAN_HOURS; i += 1) {
    const t = thisHour + i * 3600000
    if (isPeak(t) !== peak) return t
  }
  return null
}

function snapshot(ms) {
  return { peak: isPeak(ms), weekend: isWeekend(ms), nextChangeAt: nextChangeAt(ms), at: ms }
}

export function offPeakWindows(now, minutes) {
  if (!Number.isSafeInteger(minutes) || minutes < 1) return []
  const until = new Date(now)
  until.setDate(until.getDate() + 7)
  const windows = []
  for (let start = now; start < +until;) {
    const end = Math.min(nextChangeAt(start) ?? +until, +until)
    if (!isPeak(start) && end - start >= minutes * MINUTE_MS) windows.push({ start, end })
    start = end
  }
  return windows
}

const plannerTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
})

function durationLabel(minutes) {
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return [hours && hours + ' h', remainder && remainder + ' min'].filter(Boolean).join(' ')
}

function WindowPlanner() {
  const [duration, setDuration] = useState('90')
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS)
    return () => clearInterval(timer)
  }, [])

  const minutes = Number(duration)
  const valid = Number.isSafeInteger(minutes) && minutes > 0
  const windows = offPeakWindows(now, minutes)
  const time = ms => jsx('time', { dateTime: new Date(ms).toISOString(), children: plannerTime.format(ms) })
  const zone = plannerTime.resolvedOptions().timeZone
  const panel = { border: '1px solid var(--ui-stroke-secondary)', borderRadius: 12, background: 'var(--ui-bg-elevated)' }

  return jsx('div', {
    className: 'h-full overflow-y-auto',
    children: jsxs('main', {
      style: { maxWidth: 780, margin: '0 auto', padding: '32px clamp(12px, 4vw, 28px)', display: 'grid', gap: 20 },
      children: [
        jsxs('header', {
          style: { display: 'grid', gap: 6 },
          children: [
            jsx('div', {
              className: 'text-xs font-semibold text-(--ui-text-secondary)',
              style: { letterSpacing: '0.12em' },
              children: 'DEEPSEEK RATE'
            }),
            jsx('h1', { className: 'font-semibold text-foreground', style: { fontSize: 27, lineHeight: 1.2 }, children: 'DeepSeek Window Planner' }),
            jsx('p', {
              className: 'text-sm text-(--ui-text-secondary)',
              children: 'Find off-peak windows that fit your whole task over the next seven days.'
            })
          ]
        }),
        jsxs('section', {
          style: { ...panel, padding: 16, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'end', gap: 14 },
          children: [
            jsxs('label', {
              className: 'text-sm font-semibold text-foreground',
              style: { display: 'grid', gap: 6 },
              children: [
                'Task duration (minutes)',
                jsx('input', {
                  type: 'number', min: 1, step: 1, value: duration,
                  'aria-invalid': !valid,
                  onChange: event => setDuration(event.target.value),
                  className: 'text-sm tabular-nums',
                  style: {
                    width: 155, padding: '7px 10px', borderRadius: 6,
                    border: '1px solid var(--ui-stroke-secondary)', background: 'var(--background)'
                  }
                })
              ]
            }),
            jsxs('div', {
              className: 'text-xs text-(--ui-text-secondary)',
              style: { display: 'grid', gap: 4 },
              children: [
                jsx('span', { children: 'Times are shown in your local time' }),
                jsx('strong', { className: 'text-foreground', children: zone })
              ]
            })
          ]
        }),
        jsxs('section', {
          style: { display: 'grid', gap: 10 },
          children: [
            jsxs('div', {
              className: 'flex items-baseline justify-between gap-2',
              children: [
                jsx('h2', { className: 'text-sm font-semibold text-foreground', children: 'Matching off-peak windows' }),
                jsx('span', {
                  'aria-live': 'polite', className: 'text-xs text-(--ui-text-secondary)',
                  children: valid ? windows.length + (windows.length === 1 ? ' match' : ' matches') : ''
                })
              ]
            }),
            windows.length ? jsx('ol', {
              style: { display: 'grid', gap: 8 },
              children: windows.map(({ start, end }, i) => jsxs('li', {
                style: {
                  ...panel, padding: 14, display: 'flex', flexWrap: 'wrap',
                  alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  borderInlineStart: i === 0 ? '3px solid var(--ui-green)' : panel.border
                },
                children: [
                  jsxs('div', {
                    style: { display: 'grid', gap: 4 },
                    children: [
                      i === 0 ? jsx('span', {
                        className: 'text-xs font-semibold', style: { color: 'var(--ui-green)' }, children: 'First available'
                      }) : null,
                      jsxs('div', {
                        className: 'text-sm font-semibold text-foreground',
                        children: [time(start), ' → ', time(end)]
                      }),
                      jsxs('div', {
                        className: 'text-xs text-(--ui-text-secondary)',
                        children: ['Start by ', time(end - minutes * MINUTE_MS)]
                      })
                    ]
                  }),
                  jsx('span', {
                    className: 'text-xs tabular-nums text-(--ui-text-secondary)',
                    children: durationLabel(Math.floor((end - start) / MINUTE_MS)) + ' available'
                  })
                ]
              }, start))
            }) : jsx('p', {
              role: 'status', className: 'text-sm text-(--ui-text-secondary)', style: { ...panel, padding: 16 },
              children: valid ? 'No window fits that duration in the next seven days. Try a shorter task.'
                : 'Enter a positive whole number of minutes.'
            })
          ]
        })
      ]
    })
  })
}

// Hour only, 12-hour clock: "3 AM", "Mon 11 PM".
function fmtWhen(iso, nowMs) {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return 'soon'
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', hour12: true }).format(d)
  if (d.toDateString() === new Date(nowMs).toDateString()) return time
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d)
  return day + ' ' + time
}

// ---- state -----------------------------------------------------------------

const $rate = atom(snapshot(Date.now()))

// Model reported by the focused session's own usage, plus the session it
// belongs to. Tracking the owner lets a render ignore a model polled for a
// session the user has already left.
const $sessModel = atom('')
const $sessModelFor = atom(null)

// The live atoms are resolved ONCE at import so the chip can call useValue
// unconditionally on every render (a conditional hook shifts React's call
// order, which the chip's optional-atom guards used to risk). NULL_ATOM stands
// in on an app build that does not expose one of them.
const NULL_ATOM = atom(null)
const STATE = (host && host.state) || {}
const MODEL_ATOM = STATE.model || NULL_ATOM
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

let pollFailures = 0

// Current gateways answer `session.stats` and reject the legacy
// `session.usage` (-32601); older ones only have `session.usage`. Try stats
// first and remember whichever method answered, so each poll is one request.
let modelMethod = null

async function requestModel(sid) {
  if (modelMethod === 'session.usage') return host.request('session.usage', { session_id: sid })
  try {
    const resp = await host.request('session.stats', { session_id: sid })
    modelMethod = 'session.stats'
    return resp
  } catch (e) {
    const resp = await host.request('session.usage', { session_id: sid })
    if (resp && typeof resp === 'object') modelMethod = 'session.usage'
    return resp
  }
}

async function pollFocusedModel() {
  const sid = focusedSid()
  if (!sid) return
  try {
    const resp = await requestModel(sid)
    pollFailures = 0
    const model = resp && typeof resp.model === 'string' ? resp.model : ''
    // Focus moved while the request was in flight: the reply describes a
    // session the user has left, so it may not paint the chip.
    if (focusedSid() !== sid) return
    if ($sessModelFor.get() !== sid) $sessModelFor.set(sid)
    if ($sessModel.get() !== model) $sessModel.set(model)
  } catch (e) {
    pollFailures += 1
    // One line per failure streak: a broken link shows up in the app log
    // without a 10s heartbeat filling it.
    if (pollFailures === 1) {
      console.error('[deepseek-rate] session model poll failed: ' + String((e && e.message) || e))
    }
  }
}

// ---- chip ------------------------------------------------------------------

function RateChip() {
  const rate = useValue($rate)
  const pickerModel = useValue(MODEL_ATOM) || ''
  const sessUsage = useValue(USAGE_ATOM)
  // Both reads run every render: folding the fallback into `useValue(A) ||
  // useValue(B)` makes the second hook conditional, so the focus atom going
  // from empty to set changes the hook count and React throws #310
  // ("rendered more hooks than during the previous render").
  const focusAtomValue = useValue(FOCUS_ATOM)
  const activeAtomValue = useValue(ACTIVE_ATOM)
  const focused = focusAtomValue || activeAtomValue || null
  const polledModel = useValue($sessModel)
  const polledFor = useValue($sessModelFor)

  const liveModel = sessUsage && typeof sessUsage.model === 'string' ? sessUsage.model : ''
  // The FOCUSED session decides. Its own reported model wins whenever there is
  // one. The composer atom only speaks for a session that cannot report a
  // model at all: a fresh draft with no session id, or one polled and found
  // empty (no agent built yet). A poll result owned by a session the user has
  // left, or one still in flight, never colors this session — that is how a
  // composer pick left over from another session used to keep it lit.
  const polledForFocus = focused !== null && polledFor === focused
  const sessionModel = liveModel || (polledForFocus ? polledModel : '')
  const pickerDecides = focused === null || (polledForFocus && !sessionModel)
  const deepseekActive = sessionModel
    ? isDeepSeekModel(sessionModel)
    : pickerDecides && isDeepSeekModel(pickerModel)

  const when = fmtWhen(rate.nextChangeAt, rate.at)
  const localPeak = localPeakText(rate.at)
  const label = rate.weekend
    ? 'DeepSeek is off-peak all weekend: half rate on OpenCode Go. Peak (2x) returns ' + when + '.'
    : rate.peak
      ? 'DeepSeek is at peak right now: 2x the off-peak rate on OpenCode Go. Half rate returns ' +
        when +
        '. Peak is ' + localPeak + ' your time.'
      : 'DeepSeek is off-peak right now: half rate on OpenCode Go. Peak (2x) starts ' +
        when +
        '. Peak is ' + localPeak + ' your time.'

  return jsx(Tip, {
    label,
    // A status readout, not a control: a non-interactive element, so it is not a
    // tab stop and does not read as a dead button to assistive tech.
    children: jsxs('span', {
      className: 'inline-flex h-full cursor-default items-center gap-1.5 px-1.5 text-[0.6875rem]',
      children: [
        jsx('span', { className: 'text-(--ui-text-quaternary)', children: 'DeepSeek' }),
        jsx(Badge, {
          // Color ONLY while a DeepSeek model is active for this session: green
          // off-peak, orange at peak. Every other model gets the neutral,
          // unfilled pill (see NEUTRAL_VARIANT).
          variant: deepseekActive ? (rate.peak ? 'warn' : 'success') : NEUTRAL_VARIANT,
          size: 'xs',
          children: rate.peak ? 'Peak 2\u00d7' : 'Off-peak'
        })
      ]
    })
  })
}

// ---- registration ----------------------------------------------------------

export default {
  id: ID, // must match the folder name
  name: 'DeepSeek Rate',
  register(ctx) {
    // Poll the focused session's model, re-poll the moment focus moves, and
    // keep the tier tick. The stale-session guard lives in pollFocusedModel().
    void pollFocusedModel()
    const pollTimer = setInterval(pollFocusedModel, FOCUS_POLL_MS)
    const stopFocusWatch =
      typeof FOCUS_ATOM.listen === 'function' ? FOCUS_ATOM.listen(() => void pollFocusedModel()) : null

    const tickTimer = setInterval(() => {
      const next = snapshot(Date.now())
      const prev = $rate.get()
      // Write only on a real change: same tier + same boundary + same weekend
      // state = no re-render.
      if (prev.peak !== next.peak || prev.weekend !== next.weekend || prev.nextChangeAt !== next.nextChangeAt) $rate.set(next)
    }, TICK_MS)

    // Every timer and subscription this plugin arms has to die with it, or each
    // hot-reload leaves another poll loop running against the gateway.
    const dispose = () => {
      clearInterval(pollTimer)
      clearInterval(tickTimer)
      if (typeof stopFocusWatch === 'function') stopFocusWatch()
    }
    if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose)

    ctx.registerMany([
      { id: 'chip', area: STATUSBAR_AREAS.right, order: 30, render: () => jsx(RateChip, {}) },
      { id: 'planner', area: ROUTES_AREA, data: { path: PLANNER_ROUTE }, render: () => jsx(WindowPlanner, {}) },
      {
        id: 'open-planner',
        area: PALETTE_AREA,
        data: {
          id: 'deepseekRate.openPlanner',
          label: 'DeepSeek: Open Window Planner',
          keywords: ['deepseek', 'off-peak', 'billing', 'schedule'],
          run: () => host.navigate(PLANNER_ROUTE)
        }
      }
    ])
  }
}

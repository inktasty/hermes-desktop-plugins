import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { atom, host, Popover, PopoverContent, PopoverTrigger, STATUSBAR_AREAS, useValue } from '@hermes/plugin-sdk'

const ID = 'context-runway'
const SAMPLE_LIMIT = 20
const number = new Intl.NumberFormat()

function contextSample(usage, fromStats = false) {
  const used = fromStats ? usage?.last_prompt_tokens : usage?.context_used
  const max = fromStats ? usage?.context_length : usage?.context_max
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(max) || max <= 0) return null
  if (fromStats && used === 0 && usage.context_source == null) return null
  const count = fromStats ? usage.compression_count : usage.compressions
  const total = fromStats ? usage.total_tokens : usage.total
  return {
    used: Math.min(used, max),
    max,
    compressions: Number.isFinite(count) && count >= 0 ? count : null,
    total: Number.isFinite(total) ? total : null
  }
}

function appendSample(samples, next) {
  const previous = samples.at(-1)
  if (previous && previous.max === next.max) {
    const compressions = next.compressions ?? previous.compressions
    if (compressions != null && previous.compressions != null && compressions < previous.compressions) return samples
    const compressed = compressions != null && previous.compressions != null && compressions > previous.compressions
    if (!compressed && next.total != null && previous.total != null && next.total < previous.total) return samples
    const total = next.total ?? previous.total
    if (previous.used === next.used && !compressed) {
      if (previous.total === total && previous.compressions === compressions) return samples
      return [...samples.slice(0, -1), { ...previous, total, compressions }]
    }
    return [...samples.slice(1 - SAMPLE_LIMIT), { ...next, total, compressions, compressed }]
  }
  return [next]
}

function historyChart(samples, color) {
  const points = samples.map(({ used, max }, i) => [
    samples.length === 1 ? 306 : 6 + 300 * i / (samples.length - 1),
    76 - 68 * used / max
  ])
  const compressions = samples.filter(sample => sample.compressed).length
  const first = samples[0]
  const last = samples.at(-1)
  const change = last.used - first.used
  const trend = samples.length < 2 ? 'First sample'
    : change === 0 ? 'No net change'
    : (change > 0 ? '+' : '−') + number.format(Math.abs(change)) + ' tokens since first sample'
  return jsxs('div', {
    style: { display: 'grid', gap: 6 },
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-2 text-[0.6875rem] text-(--ui-text-secondary)',
        children: [jsx('span', { children: 'Context used · ' + samples.length + (samples.length === 1 ? ' sample' : ' samples') }),
          jsx('span', { children: compressions + (compressions === 1 ? ' compression' : ' compressions') })]
      }),
      jsxs('svg', {
        viewBox: '0 0 312 84',
        role: 'img',
        'aria-label': 'Recent context history. ' + trend + '.',
        style: { display: 'block', width: '100%', borderRadius: 6, background: 'var(--chrome-action-hover)' },
        children: [
          ...[8, 42, 76].map(y => jsx('line', {
            x1: 6, x2: 306, y1: y, y2: y, stroke: 'currentColor', opacity: 0.14
          }, y)),
          jsx('polyline', {
            points: points.map(point => point.join(',')).join(' '),
            fill: 'none', stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round'
          }),
          ...points.flatMap(([x, y], i) => samples[i].compressed || i === points.length - 1 ? [
            jsx('circle', { cx: x, cy: y, r: samples[i].compressed ? 4 : 3, fill: color }, i)
          ] : [])
        ]
      }),
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: trend })
    ]
  })
}

function RunwayChip({ view }) {
  const { samples, sid } = useValue(view)
  const [open, setOpen] = useState(false)
  const latest = samples.at(-1)
  const remaining = latest ? latest.max - latest.used : null
  const percent = latest ? Math.floor(100 * remaining / latest.max) : null
  const color = percent != null && percent <= 15 ? 'var(--ui-yellow)' : null
  return jsxs(Popover, {
    open,
    onOpenChange: setOpen,
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsx('button', {
          type: 'button',
          className: 'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] font-mono text-(--ui-text-secondary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
          style: { color, opacity: latest ? 1 : 0.7 },
          'aria-label': latest ? 'Context Runway: ' + percent + '% remaining' : 'Context Runway: unavailable',
          children: latest ? 'Context · ' + percent + '% left' : 'Context · —'
        })
      }),
      jsx(PopoverContent, {
        side: 'top',
        align: 'end',
        sideOffset: 6,
        style: { width: 'min(20rem, calc(100vw - 1rem))' },
        children: jsxs('div', {
          style: { display: 'grid', gap: 12 },
          children: [
            jsx('div', { className: 'font-semibold text-foreground', children: 'Context Runway' }),
            latest ? jsxs('div', {
              style: { display: 'grid', gap: 4 },
              children: [
                jsx('div', {
                  className: 'font-semibold text-foreground tabular-nums',
                  style: { fontSize: 22, lineHeight: 1.2 },
                  children: number.format(remaining) + ' tokens left'
                }),
                jsx('div', {
                  className: 'text-[0.6875rem] text-(--ui-text-secondary)',
                  children: number.format(latest.used) + ' of ' + number.format(latest.max) + ' used'
                })
              ]
            }) : jsx('div', {
              className: 'text-[0.6875rem] text-(--ui-text-secondary)',
              children: sid ? 'This session has not reported a context size yet.' : 'Focus a session to see its context headroom.'
            }),
            latest ? historyChart(samples, color || 'var(--ui-blue)') : null
          ]
        })
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Context Runway',
  register(ctx) {
    const { focusedSessionId, activeSessionId, focusedUsage } = host.state || {}
    const focused = () => focusedSessionId?.get() || activeSessionId?.get() || null
    const view = atom({ sid: null, samples: [] })
    let lastUsage
    let generation = 0
    let queued = false
    let disposed = false

    function record(sid, sample) {
      const current = view.get()
      const samples = appendSample(current.samples, sample)
      if (samples !== current.samples) view.set({ sid, samples })
    }

    async function loadBaseline(sid, version) {
      const current = () => !disposed && generation === version && focused() === sid && !view.get().samples.length
      try {
        const params = { session_id: sid }
        let sample
        try {
          sample = contextSample(await host.request('session.stats', params), true)
        } catch (error) {
          if (!current() || (error?.code !== -32601 && !/unknown method|method not found/i.test(error?.message || ''))) return
          sample = contextSample(await host.request('session.usage', params))
        }
        if (sample && current()) record(sid, sample)
      } catch {
        // The live stream can still supply context after a failed baseline.
      }
    }

    function sync() {
      queued = false
      if (disposed) return
      const sid = focused()
      const usage = focusedUsage?.get()
      const changed = view.get().sid !== sid
      if (changed) {
        generation += 1
        view.set({ sid, samples: [] })
      }
      const sample = sid && usage !== lastUsage ? contextSample(usage) : null
      lastUsage = usage
      if (sample) record(sid, sample)
      else if (sid && changed) void loadBaseline(sid, generation)
    }

    function scheduleSync() {
      if (queued) return
      queued = true
      queueMicrotask(sync)
    }

    const stops = [focusedSessionId, activeSessionId, focusedUsage].map(store => store?.listen?.(scheduleSync))
    scheduleSync()
    ctx.onDispose?.(() => {
      disposed = true
      stops.forEach(stop => stop?.())
    })
    ctx.register({ id: 'chip', area: STATUSBAR_AREAS.right, order: 25, render: () => jsx(RunwayChip, { view }) })
  }
}

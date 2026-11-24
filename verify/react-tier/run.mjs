import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { JSDOM } from 'jsdom'

register('./resolve.mjs', import.meta.url)
const { act, createElement } = await import('react')
const sdk = await import('./sdk.mjs')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://synthetic.invalid' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const source = process.env.PLUGIN_SRC
  ? path.resolve(process.env.PLUGIN_SRC)
  : fileURLToPath(new URL('../../desktop-plugins/', import.meta.url))
const SESSION_PAYLOAD = { model: 'synthetic-model', total_tokens: 100, dev_credits_spent_micros: 2500000 }
const MODELS_PAYLOAD = { ok: true, models: [] }
const STATS_PAYLOAD = {
  model: 'synthetic-model', input_tokens: 100000, prompt_tokens: 100000, total_tokens: 100000
}
const PRICE_PAYLOAD = { ok: true, model: 'synthetic-model', input: 1, output: 1, cache_read: 1 }
const USAGE_PAYLOAD = {
  ok: true,
  windows: {
    rolling: {
      label: 'Rolling',
      used_percent: 25,
      remaining_percent: 75,
      window_seconds: 18000,
      resets_at: '2030-01-01T00:00:00Z'
    }
  }
}
let passes = 0
let fails = 0
function check(name, cond, detail = '') {
  if (cond) passes++
  else {
    fails++
    console.log('FAIL  ' + name + (detail ? '  :: ' + detail : ''))
  }
}
const timers = new Map()
const originalInterval = globalThis.setInterval
const originalClear = globalThis.clearInterval
globalThis.setInterval = (fn, ms) => {
  const id = Symbol()
  timers.set(id, { fn, ms })
  return id
}
globalThis.clearInterval = id => timers.delete(id)
const settle = fn => act(async () => {
  await fn?.()
  for (let i = 0; i < 30; i++) await Promise.resolve()
})

async function mountAndTest(name, test, canonicalStats = false, entryId = name === 'opencode-usage' ? 'page' : 'chip') {
  const entries = []
  const disposers = []
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const state = sdk.host.state
  state.focusedSessionId.set(null)
  state.activeSessionId.set(null)
  state.model.set('')
  state.focusedUsage.set(null)
  const baseline = [...sdk.atoms].reduce((n, a) => n + a.listenerCount, 0)
  const calls = []
  let failRpc = false
  let sessionPayload = { ...SESSION_PAYLOAD }
  let statsPayload = { ...STATS_PAYLOAD }
  const pendingPrices = []
  if (canonicalStats === 'race') {
    state.focusedSessionId.set('synthetic-race')
    statsPayload.provider = 'synthetic-alpha'
  }
  sdk.setRpc(async (method, params) => {
    calls.push({ method, params })
    if (failRpc) throw new Error('synthetic offline')
    if (method === 'session.stats') {
      if (!canonicalStats) throw new Error('synthetic unknown method: session.stats')
      return { ...statsPayload }
    }
    if (method === 'session.usage') return { ...sessionPayload }
    if (name === 'session-usage' && canonicalStats) {
      if (canonicalStats === 'race') {
        return new Promise(resolve => pendingPrices.push({ command: params.command, resolve }))
      }
      const input = canonicalStats === 'providers'
        ? params.command.includes("'synthetic-alpha'") ? 2 : params.command.includes("'synthetic-beta'") ? 5 : 7
        : PRICE_PAYLOAD.input
      return { code: 0, stdout: JSON.stringify({ ...PRICE_PAYLOAD, input }) }
    }
    const payload = params.command.includes('opencode_go_models') ? MODELS_PAYLOAD : USAGE_PAYLOAD
    return { code: 0, stdout: JSON.stringify(payload) }
  })
  try {
    const plugin = (await import(pathToFileURL(path.join(source, name, 'plugin.js')))).default
    await settle(() => plugin.register({
      register: e => entries.push(e),
      registerMany: es => entries.push(...es),
      onDispose: fn => disposers.push(fn),
      storage: { get: () => null, set() {} }
    }))
    const entry = entries.find(e => e.id === entryId)
    const beforeMountTimers = timers.size
    await settle(() => root.render(createElement(entry.render)))
    await test({
      container,
      state,
      calls,
      pendingPrices,
      beforeMountTimers,
      failRpc: () => { failRpc = true },
      setSessionPayload: next => { sessionPayload = next },
      setStatsPayload: next => { statsPayload = next }
    })
    await settle(() => root.unmount())
    check(name + ' unmount cleans React subscriptions/timers', timers.size === beforeMountTimers)
  } catch (error) {
    check(name + ' execution', false, error.stack)
    await settle(() => root.unmount())
  } finally {
    await teardown(name, disposers, baseline, container)
  }
}

async function teardown(name, disposers, baseline, container) {
  await settle(() => disposers.forEach(fn => fn()))
  const listeners = [...sdk.atoms].reduce((n, a) => n + a.listenerCount, 0)
  check(name + ' dispose cleans all timers/listeners', timers.size === 0 && listeners === baseline)
  if (name === 'session-usage') {
    check('session-usage unmount/dispose clears registration poll', ![...timers.values()].some(t => t.ms === 120000))
  }
  timers.clear()
  container.remove()
}

async function testDeepseekRate({ container, state, failRpc }) {
  const badge = () => container.querySelector('[data-prim="Badge"]')
  const neutral = badge().dataset.variant
  await settle(() => state.model.set('deepseek/deepseek-v4-pro'))
  check('deepseek-rate atom subscription repaints badge', badge().dataset.variant !== neutral)
  await settle(() => state.model.set(''))
  check('deepseek-rate empty model restores neutral', badge().dataset.variant === neutral)
  failRpc()
  await settle(() => state.focusedSessionId.set('synthetic-failure'))
  check('deepseek-rate failed poll stays neutral', badge().dataset.variant === neutral)
}

async function testDeepseekWindowPlanner({ container, calls }) {
  const input = container.querySelector('input')
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const enter = value => settle(() => {
    setValue.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const firstWindow = () => container.querySelector('li time')?.dateTime
  check('planner displays its default task and matching windows', input.value === '90' && Boolean(firstWindow()))
  await enter('3781')
  check('planner updates to a no-match state for a longer task', !firstWindow() && container.textContent.includes('No window fits'))
  await enter('')
  check('planner distinguishes invalid input from no matches', input.getAttribute('aria-invalid') === 'true' &&
    container.textContent.includes('Enter a positive whole number'))
  await enter('90')
  check('planner restores matching windows when duration changes', Boolean(firstWindow()))
  const previous = Date.now
  const clock = [...timers.values()].find(timer => timer.ms === 60000)
  try {
    const start = Date.UTC(2026, 8, 18, 12, 30)
    Date.now = () => start
    await settle(() => clock?.fn())
    check('planner clock refreshes the start of the in-progress window', firstWindow() === new Date(start).toISOString())
  } finally {
    Date.now = previous
  }
  check('planner mount and interaction make no RPCs', calls.length === 0)
}

async function testSessionUsage({ container, state, calls, failRpc, setSessionPayload }) {
  check('session-usage empty chip', container.querySelector('button').textContent === 'usage')
  await settle(() => state.focusedSessionId.set('synthetic-session'))
  check('session-usage focus effect fetches new session', calls.some(c => (
    c.method === 'session.usage' && c.params.session_id === 'synthetic-session'
  )))
  check('session-usage fetched cost repaints chip', container.querySelector('button').textContent === '$2.50')
  await settle(() => container.querySelector('button').dispatchEvent(
    new dom.window.FocusEvent('focusin', { bubbles: true })
  ))
  check('session-usage focus state opens panel', !!container.querySelector('[data-prim="PopoverContent"]'))
  await settle(() => container.querySelector('button').dispatchEvent(
    new dom.window.FocusEvent('focusout', { bubbles: true })
  ))
  check('session-usage blur state closes panel', !container.querySelector('[data-prim="PopoverContent"]'))
  const poll = [...timers.values()].find(t => t.ms === 120000)
  const beforePoll = calls.filter(c => c.method === 'session.usage').length
  setSessionPayload({ ...SESSION_PAYLOAD, dev_credits_spent_micros: 3500000 })
  await settle(() => poll.fn())
  check('session-usage legacy poll fetches again', (
    calls.filter(c => c.method === 'session.usage').length === beforePoll + 1
  ))
  check('session-usage legacy poll repaints chip', container.querySelector('button').textContent === '$3.50')
  check('session-usage legacy poll stays armed', [...timers.values()].includes(poll))
  failRpc()
  await settle(() => state.focusedSessionId.set('synthetic-failure'))
  check('session-usage failed fetch leaves empty chip', container.querySelector('button').textContent === 'usage')
}

async function testSessionStatsPolling({ container, state, calls, setStatsPayload, failRpc }) {
  await settle(() => state.focusedSessionId.set('synthetic-stats'))
  const chip = () => container.querySelector('button').textContent
  check('session-usage canonical stats initializes chip', chip() === '$0.100', chip())
  const poll = [...timers.values()].find(t => t.ms === 120000)
  const beforePoll = calls.filter(c => c.method === 'session.stats').length
  setStatsPayload({ ...STATS_PAYLOAD, input_tokens: 200000, prompt_tokens: 200000, total_tokens: 200000 })
  await settle(() => poll.fn())
  check('session-usage canonical poll fetches again', (
    calls.filter(c => c.method === 'session.stats').length === beforePoll + 1
  ))
  check('session-usage canonical poll avoids legacy RPC', !calls.some(c => c.method === 'session.usage'))
  check('session-usage canonical poll repaints chip', chip() === '$0.200', chip())
  check('session-usage canonical poll stays armed', [...timers.values()].includes(poll))
  setStatsPayload({ ...STATS_PAYLOAD, input_tokens: 0, prompt_tokens: 0, total_tokens: 0 })
  await settle(() => poll.fn())
  check('session-usage empty poll keeps accumulated cost', chip() === '$0.200', chip())
  failRpc()
  await settle(() => poll.fn())
  check('session-usage failed poll keeps accumulated cost', chip() === '$0.200', chip())
}

async function testSessionProviders({ container, state, setStatsPayload }) {
  const before = passes
  for (const [provider, cost] of [['synthetic-alpha', '$0.200'], ['synthetic-beta', '$0.500'], ['', '$0.700']]) {
    setStatsPayload({ ...STATS_PAYLOAD, provider })
    await settle(() => state.focusedSessionId.set('synthetic-provider-' + (provider || 'default')))
    check('session provider focus uses correct rate: ' + (provider || 'configured'),
      container.querySelector('button').textContent === cost, container.textContent)
  }
  console.log('provider focus regression: ' + (passes - before) + '/3 passed')
}

async function testSessionRateRace({ container, calls, pendingPrices }) {
  const before = passes
  const sessionReplies = pendingPrices.filter(p => p.command.includes("'synthetic-alpha'"))
  check('rate race starts focused stats and configured lookup',
    calls.filter(c => c.method === 'session.stats').length === 2 &&
    pendingPrices.some(p => !p.command.includes("'synthetic-model'")))
  await settle(() => sessionReplies.forEach(p => p.resolve({ code: 0, stdout: JSON.stringify(PRICE_PAYLOAD) })))
  await settle(() => container.querySelector('button').dispatchEvent(
    new dom.window.FocusEvent('focusin', { bubbles: true })
  ))
  check('rate race session reply shows rate block', container.textContent.includes('Rates per 1M tokens'))
  const estimate = container.querySelector('button').textContent
  await settle(() => pendingPrices.filter(p => !sessionReplies.includes(p)).forEach(p => p.resolve({
    code: 0, stdout: JSON.stringify({ ...PRICE_PAYLOAD, model: 'synthetic-configured', input: 7 })
  })))
  check('rate race late configured reply preserves active rate block', container.textContent.includes('Rates per 1M tokens'))
  check('rate race late configured reply preserves saved estimate', container.querySelector('button').textContent === estimate)
  const count = calls.filter(c => c.method === 'shell.exec').length
  const poll = [...timers.values()].find(t => t.ms === 120000)
  await settle(() => { void poll.fn() })
  check('rate race unchanged session does not refetch price', calls.filter(c => c.method === 'shell.exec').length === count)
  check('rate race deduplicates pending session lookups', sessionReplies.length === 1)
  await settle(() => pendingPrices.forEach(p => p.resolve({ code: 0, stdout: JSON.stringify(PRICE_PAYLOAD) })))
  console.log('rate race regression: ' + (passes - before) + '/6 passed')
}

async function testOpencodeUsage({ container, calls, beforeMountTimers, failRpc }) {
  check('opencode-usage mount effect fetches models', calls.some(c => (
    c.params?.command?.includes('opencode_go_models')
  )))
  check('opencode-usage mount effect owns recheck timer', timers.size === beforeMountTimers + 1)
  const details = [...container.querySelectorAll('button')].find(b => b.textContent.includes('Show details'))
  check('opencode-usage fixture renders quota', !!details)
  if (details) {
    await settle(() => details.click())
    check('opencode-usage state opens details', (
      details.textContent.includes('Hide details') && container.textContent.includes('Quota left')
    ))
    await settle(() => details.click())
    check('opencode-usage state closes details', (
      details.textContent.includes('Show details') && !container.textContent.includes('Quota left')
    ))
  }
  failRpc()
  const refresh = [...container.querySelectorAll('button')].find(b => b.textContent.includes('Refresh'))
  await settle(() => refresh.click())
  check('opencode-usage RPC error reaches DOM', container.textContent.includes('Gateway call failed'))
}
async function testRestoredModels(label, fetchedAt, shouldRefresh, failRefresh = false) {
  const entries = []
  const disposers = []
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const baseline = [...sdk.atoms].reduce((n, a) => n + a.listenerCount, 0)
  const cached = {
    ok: true,
    models: [{ id: 'synthetic-cached', name: 'Synthetic cached model', input: 1 }],
    ...(fetchedAt === undefined ? {} : { fetched_at: fetchedAt })
  }
  let modelCalls = 0
  let finishRefresh
  sdk.setRpc(async (method, params) => {
    if (params?.command?.includes('opencode_go_models')) {
      modelCalls++
      return new Promise(resolve => { finishRefresh = resolve })
    }
    return { code: 0, stdout: JSON.stringify(USAGE_PAYLOAD) }
  })
  try {
    const url = pathToFileURL(path.join(source, 'opencode-usage/plugin.js'))
    url.searchParams.set('restored', label)
    const plugin = (await import(url)).default
    await settle(() => plugin.register({
      register: e => entries.push(e),
      registerMany: es => entries.push(...es),
      onDispose: fn => disposers.push(fn),
      storage: { get: key => key === 'models_v3' ? cached : null, set() {} }
    }))
    await settle(() => root.render(createElement(entries.find(e => e.id === 'page').render)))
    check('restored models ' + label + ' refresh decision', modelCalls === (shouldRefresh ? 1 : 0), 'model calls=' + modelCalls)
    check('restored models ' + label + ' keeps cached list visible', container.textContent.includes('Synthetic cached model'))
    if (finishRefresh) {
      await settle(() => finishRefresh({ code: 0, stdout: JSON.stringify(failRefresh
        ? { ok: false, error: 'synthetic models failure' }
        : { ...cached, fetched_at: new Date().toISOString() }) }))
      check('restored models ' + label + ' keeps list after refresh', container.textContent.includes('Synthetic cached model'))
      if (failRefresh) {
        check('restored models failure reaches DOM', container.textContent.includes('synthetic models failure'))
      } else {
        await settle(() => [...timers.values()].filter(t => t.ms === 60000).forEach(t => t.fn()))
        check('restored models ' + label + ' refreshes exactly once', modelCalls === 1)
      }
    }
  } finally {
    await settle(() => root.unmount())
    await teardown('restored models ' + label, disposers, baseline, container)
  }
}

await testRestoredModels('expired', new Date(Date.now() - 7 * 3600000).toISOString(), true)
await testRestoredModels('fresh', new Date(Date.now() - 3600000).toISOString(), false)
await testRestoredModels('missing timestamp', undefined, true)
await testRestoredModels('invalid timestamp', 'not-a-date', true)
await testRestoredModels('failed refresh', new Date(Date.now() - 7 * 3600000).toISOString(), true, true)
await mountAndTest('deepseek-rate', testDeepseekRate)
await mountAndTest('deepseek-rate', testDeepseekWindowPlanner, false, 'planner')
await mountAndTest('session-usage', testSessionUsage)
await mountAndTest('session-usage', testSessionStatsPolling, true)
await mountAndTest('session-usage', testSessionProviders, 'providers')
await mountAndTest('session-usage', testSessionRateRace, 'race')
await mountAndTest('opencode-usage', testOpencodeUsage)
globalThis.setInterval = originalInterval
globalThis.clearInterval = originalClear
dom.window.close()
console.log(`react-tier: ${passes} passed, ${fails} failed`)
process.exitCode = fails ? 1 : 0

import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { JSDOM } from 'jsdom'

register('./resolve.mjs', import.meta.url)
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const sdk = await import('./sdk.mjs')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://synthetic.invalid' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
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

async function mountAndTest(name, test, canonicalStats = false) {
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
  sdk.setRpc(async (method, params) => {
    calls.push({ method, params })
    if (failRpc) throw new Error('synthetic offline')
    if (method === 'session.stats') {
      if (!canonicalStats) throw new Error('synthetic unknown method: session.stats')
      return { ...statsPayload }
    }
    if (method === 'session.usage') return { ...sessionPayload }
    if (name === 'session-usage' && canonicalStats) {
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
    const entry = entries.find(e => e.id === (name === 'opencode-usage' ? 'page' : 'chip'))
    const beforeMountTimers = timers.size
    await settle(() => root.render(createElement(entry.render)))
    await test({
      container,
      state,
      calls,
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
await mountAndTest('deepseek-rate', testDeepseekRate)
await mountAndTest('session-usage', testSessionUsage)
await mountAndTest('session-usage', testSessionStatsPolling, true)
await mountAndTest('session-usage', testSessionProviders, 'providers')
await mountAndTest('opencode-usage', testOpencodeUsage)
globalThis.setInterval = originalInterval
globalThis.clearInterval = originalClear
dom.window.close()
console.log(`react-tier: ${passes} passed, ${fails} failed`)
process.exitCode = fails ? 1 : 0

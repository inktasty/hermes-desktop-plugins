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
const source = process.env.PLUGIN_SRC ? path.resolve(process.env.PLUGIN_SRC) : fileURLToPath(new URL('../../desktop-plugins/', import.meta.url))
let passes = 0, fails = 0
function check(name, cond, detail = '') {
  if (cond) passes++
  else { fails++; console.log('FAIL  ' + name + (detail ? '  :: ' + detail : '')) }
}
const timers = new Map()
const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval
globalThis.setInterval = (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id }
globalThis.clearInterval = id => timers.delete(id)
const settle = fn => act(async () => { await fn?.(); for (let i = 0; i < 30; i++) await Promise.resolve() })

for (const name of ['deepseek-rate', 'session-usage', 'opencode-usage']) {
  const entries = [], disposers = []
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const state = sdk.host.state
  state.focusedSessionId.set(null); state.activeSessionId.set(null); state.model.set(''); state.focusedUsage.set(null)
  const baseline = [...sdk.atoms].reduce((n, a) => n + a.listenerCount, 0)
  const calls = []
  let failRpc = false
  sdk.setRpc(async (method, params) => {
    calls.push({ method, params })
    if (failRpc) throw new Error('synthetic offline')
    if (method === 'session.usage') return { model: 'synthetic-model', total_tokens: 100, dev_credits_spent_micros: 2500000 }
    const payload = params.command.includes('opencode_go_models') ? { ok: true, models: [] } : { ok: true, windows: { rolling: { label: 'Rolling', used_percent: 25, remaining_percent: 75, window_seconds: 18000, resets_at: '2030-01-01T00:00:00Z' } } }
    return { code: 0, stdout: JSON.stringify(payload) }
  })
  try {
    const plugin = (await import(pathToFileURL(path.join(source, name, 'plugin.js')))).default
    await settle(() => plugin.register({ register: e => entries.push(e), registerMany: es => entries.push(...es), onDispose: fn => disposers.push(fn), storage: { get: () => null, set() {} } }))
    const entry = entries.find(e => e.id === (name === 'opencode-usage' ? 'page' : 'chip'))
    const beforeMountTimers = timers.size
    await settle(() => root.render(createElement(entry.render)))
    if (name === 'deepseek-rate') {
      const badge = () => container.querySelector('[data-prim="Badge"]')
      const neutral = badge().dataset.variant
      await settle(() => state.model.set('deepseek/deepseek-v4-pro'))
      check('deepseek-rate atom subscription repaints badge', badge().dataset.variant !== neutral)
      await settle(() => state.model.set(''))
      check('deepseek-rate empty model restores neutral', badge().dataset.variant === neutral)
      failRpc = true
      await settle(() => state.focusedSessionId.set('synthetic-failure'))
      check('deepseek-rate failed poll stays neutral', badge().dataset.variant === neutral)
    } else if (name === 'session-usage') {
      check('session-usage empty chip', container.querySelector('button').textContent === 'usage')
      await settle(() => state.focusedSessionId.set('synthetic-session'))
      check('session-usage focus effect fetches new session', calls.some(c => c.method === 'session.usage' && c.params.session_id === 'synthetic-session'))
      check('session-usage fetched cost repaints chip', container.querySelector('button').textContent === '$2.50')
      await settle(() => container.querySelector('button').dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true })))
      check('session-usage focus state opens panel', !!container.querySelector('[data-prim="PopoverContent"]'))
      await settle(() => container.querySelector('button').dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })))
      check('session-usage blur state closes panel', !container.querySelector('[data-prim="PopoverContent"]'))
      failRpc = true
      await settle(() => state.focusedSessionId.set('synthetic-failure'))
      check('session-usage failed fetch leaves empty chip', container.querySelector('button').textContent === 'usage')
    } else {
      check('opencode-usage mount effect fetches models', calls.some(c => c.params?.command?.includes('opencode_go_models')))
      check('opencode-usage mount effect owns recheck timer', timers.size === beforeMountTimers + 1)
      const details = [...container.querySelectorAll('button')].find(b => b.textContent.includes('Show details'))
      check('opencode-usage fixture renders quota', !!details)
      if (details) {
        await settle(() => details.click())
        check('opencode-usage state opens details', details.textContent.includes('Hide details') && container.textContent.includes('Quota left'))
        await settle(() => details.click())
        check('opencode-usage state closes details', details.textContent.includes('Show details') && !container.textContent.includes('Quota left'))
      }
      failRpc = true
      const refresh = [...container.querySelectorAll('button')].find(b => b.textContent.includes('Refresh'))
      await settle(() => refresh.click())
      check('opencode-usage RPC error reaches DOM', container.textContent.includes('Gateway call failed'))
    }
    await settle(() => root.unmount())
    check(name + ' unmount cleans React subscriptions/timers', timers.size === beforeMountTimers)
  } catch (error) {
    check(name + ' execution', false, error.stack)
    await settle(() => root.unmount())
  } finally {
    await settle(() => disposers.forEach(fn => fn()))
    check(name + ' dispose cleans all timers/listeners', timers.size === 0 && [...sdk.atoms].reduce((n, a) => n + a.listenerCount, 0) === baseline)
    timers.clear(); container.remove()
  }
}
globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear
dom.window.close()
console.log(`react-tier: ${passes} passed, ${fails} failed`)
process.exitCode = fails ? 1 : 0

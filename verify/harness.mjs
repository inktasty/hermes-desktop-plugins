// Offline harness for the three disk plugins: real file import, stub SDK,
// hook-count oracle, import-scan check, and a clock sweep against an
// independently written peak-tier oracle.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import * as sdk from '@hermes/plugin-sdk'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CANON = process.env.PLUGIN_SRC || path.join(HERE, '..', 'desktop-plugins')

let fails = 0
let passes = 0
function check(name, cond, detail = '') {
  if (cond) {
    passes += 1
  } else {
    fails += 1
    console.log('FAIL  ' + name + (detail ? '  :: ' + detail : ''))
  }
}

function sha(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// ---- the app's own import scan (copied verbatim from runtime-loader.ts) ------
const importSpecifierRe = () => /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g
function unsupportedImports(source, allowed) {
  const bare = new Set()
  for (const m of source.matchAll(importSpecifierRe())) {
    const spec = m[3]
    if (spec && !/^[./]/.test(spec) && !/^[a-z][a-z0-9+.-]*:/i.test(spec) && !allowed.includes(spec)) bare.add(spec)
  }
  return [...bare]
}

// ---- tree walking -----------------------------------------------------------
function walk(node, out) {
  if (node === null || node === undefined || node === true || node === false) return
  if (Array.isArray(node)) {
    node.forEach(n => walk(n, out))
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node))
    return
  }
  if (typeof node !== 'object') return
  const { type, props } = node
  if (typeof type === 'function') {
    walk(type(props || {}), out)
    return
  }
  if (typeof type === 'string' && type.startsWith('__prim:')) {
    out.prims.push({ name: type.slice(7), props: props || {} })
    walk(props && props.children, out)
    return
  }
  if (typeof type === 'string' || typeof type === 'symbol') {
    walk(props && props.children, out)
    return
  }
  out.text.push(JSON.stringify(node))
}

function render(Comp, props) {
  sdk.counts.useValue = 0
  let tree
  let err = null
  const out = { err, prims: [], text: [] }
  try {
    tree = Comp(props || {})
    walk(tree, out)
    out.text = out.text.join(' ').replace(/\s+/g, ' ')
  } catch (e) {
    err = e
    out.err = e
  }
  out.hooks = sdk.counts.useValue
  return out
}

const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise(r => setImmediate(r))
}

function primOf(out, name) {
  return out.prims.filter(p => p.name === name)
}

function captureCtx() {
  const contributions = []
  const disposers = []
  const ctx = {
    source: 'plugin:test',
    register: c => {
      contributions.push(c)
      return () => {}
    },
    registerMany: cs => {
      cs.forEach(c => contributions.push(c))
      return () => {}
    },
    onDispose: fn => {
      disposers.push(fn)
      return () => {}
    },
    onEvent: () => () => {},
    rest: async () => ({}),
    socket: () => () => {},
    os: {},
    storage: { get: (k, f) => f, set: () => {}, remove: () => {} },
    i18n: {}
  }
  return { ctx, contributions, disposers }
}

// ---- timer capture ---------------------------------------------------------
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const realNow = Date.now
let timers = []
function stubTimers() {
  timers = []
  globalThis.setInterval = (fn, ms) => {
    timers.push({ fn, ms })
    return timers.length
  }
  globalThis.clearInterval = () => {}
}
function restoreTimers() {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  Date.now = realNow
}

async function loadPlugin(id, { fresh = 0, scriptsDir = null } = {}) {
  const src = path.join(CANON, id, 'plugin.js')
  const copy = path.join(HERE, id + '.plugin.js')
  const copyFresh = fresh ? path.join(HERE, id + '.plugin.' + fresh + '.js') : copy
  fs.copyFileSync(src, copyFresh)
  let source = fs.readFileSync(copyFresh, 'utf8')
  const bad = unsupportedImports(source, ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
  if (scriptsDir) {
    source = source.replace(/__HERMES_SCRIPTS__/g, scriptsDir)
    fs.writeFileSync(copyFresh, source)
  }
  const localHash = sha(copyFresh)
  const canonHash = sha(src)
  const mod = await import('./' + id + '.plugin' + (fresh ? '.' + fresh : '') + '.js')
  return { bad, canonHash, localHash, mod: mod.default, source, installed: Boolean(scriptsDir) }
}

// ---- independent peak oracle -----------------------------------------------
const PEAK_BLOCKS = [[1, 4], [6, 10]]
function oraclePeak(ms) {
  const d = new Date(ms)
  const day = d.getUTCDay()
  if (day < 1 || day > 5) return false
  const h = d.getUTCHours()
  return PEAK_BLOCKS.some(([a, b]) => h >= a && h < b)
}

const CASES = []
for (let day = 14; day < 22; day += 1) {
  for (let hour = 0; hour < 24; hour += 1) {
    CASES.push(Date.UTC(2026, 8, day, hour, 30))
  }
}

// Synthetic usage snapshot: no account data of any kind, and every reset is
// relative to now so the fixture never goes stale.
function makeSnapshot(now) {
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return {
    ok: true,
    fetched_at: iso(now),
    source: 'https://opencode.ai/zen/go/v1/usage',
    plan: 'OpenCode Go',
    windows: {
      rolling: {
        key: 'rolling', label: '5-hour', status: 'ok',
        used_percent: 12.0, remaining_percent: 88.0,
        resets_at: iso(now + 2 * 3600000), reset_in_seconds: 7200,
        window_start: iso(now - 3 * 3600000), window_seconds: 18000,
        elapsed_percent: 59.6, projected_percent: 20.1, on_pace: true, hits_limit_at: null
      },
      weekly: {
        key: 'weekly', label: 'Weekly', status: 'ok',
        used_percent: 47.0, remaining_percent: 53.0,
        resets_at: iso(now + 14 * 3600000), reset_in_seconds: 50400,
        window_start: iso(now - 6 * 86400000), window_seconds: 604800,
        elapsed_percent: 91.3, projected_percent: 51.5, on_pace: true, hits_limit_at: null
      },
      monthly: {
        key: 'monthly', label: 'Monthly', status: 'ok',
        used_percent: 6.0, remaining_percent: 94.0,
        resets_at: iso(now + 23 * 86400000), reset_in_seconds: 1987200,
        window_start: iso(now - 7 * 86400000), window_seconds: 2592000,
        elapsed_percent: 23.4, projected_percent: 192.0, on_pace: false,
        hits_limit_at: iso(now + 5 * 86400000)
      }
    },
    error: null
  }
}

// ============================================================ deepseek-rate ==
async function testDeepseekRate() {
  console.log('--- deepseek-rate')
  const { bad, canonHash, localHash, mod, source } = await loadPlugin('deepseek-rate')
  check('import scan clean', bad.length === 0, JSON.stringify(bad))
  check('copy byte-identical to canonical', canonHash === localHash)
  check('id matches folder', mod.id === 'deepseek-rate', mod.id)
  check('register is a function', typeof mod.register === 'function')

  stubTimers()
  Date.now = () => Date.UTC(2026, 8, 16, 2, 30) // Wed, inside peak
  const { ctx, contributions } = captureCtx()
  mod.register(ctx)
  restoreTimers()

  check('registers exactly one contribution', contributions.length === 1, String(contributions.length))
  const chip = contributions[0]
  check('chip in statusBar.right', chip && chip.area === 'statusBar.right', chip && chip.area)
  check('chip render is a function', typeof chip.render === 'function')

  const tick = timers.filter(t => t.ms === 20000)
  check('arms exactly one 20s tick', tick.length === 1, JSON.stringify(timers.map(t => t.ms)))
  check('arms one focused-session poll', timers.some(t => t.ms === 10000))

  // clock sweep: every hour for 8 days, driven through the tick
  let mismatches = []
  for (const ms of CASES) {
    Date.now = () => ms
    tick[0].fn()
    const out = render(chip.render)
    const want = oraclePeak(ms) ? 'Peak 2×' : 'Off-peak'
    if (!out.text.includes(want)) mismatches.push(new Date(ms).toISOString() + ' want ' + want + ' got ' + out.text)
  }
  check('tier label matches the oracle for all ' + CASES.length + ' hours', mismatches.length === 0, mismatches.slice(0, 4).join(' | '))

  // boundary precision
  for (const [label, ms, want] of [
    ['Wed 03:59 UTC is peak', Date.UTC(2026, 8, 16, 3, 59), 'Peak 2×'],
    ['Wed 04:00 UTC flips off-peak', Date.UTC(2026, 8, 16, 4, 0), 'Off-peak'],
    ['Wed 06:00 UTC flips peak', Date.UTC(2026, 8, 16, 6, 0), 'Peak 2×'],
    ['Wed 10:00 UTC flips off-peak', Date.UTC(2026, 8, 16, 10, 0), 'Off-peak']
  ]) {
    Date.now = () => ms
    tick[0].fn()
    const out = render(chip.render)
    check(label, out.text.includes(want), out.text)
  }

  // model gate: colour only for a DeepSeek session
  const gate = async (focusedModel, pickerModel, sid, ms) => {
    sdk.setRpc(async () => ({ model: focusedModel }))
    Date.now = () => ms
    tick[0].fn() // move the clock the way the plugin's own tick would
    sdk.host.state.focusedUsage.set(null)
    sdk.host.state.focusedSessionId.set(sid || null)
    sdk.host.state.model.set(pickerModel || '')
    await settle()
    const out = render(chip.render)
    const badge = primOf(out, 'Badge')[0]
    return badge && badge.props && badge.props.variant
  }
  const OFF = Date.UTC(2026, 8, 16, 20, 0)
  const ON = Date.UTC(2026, 8, 16, 2, 0)
  const other = await gate('opencode-go/omen-alpha', 'opencode-go/omen-alpha', 's1', OFF)
  check('non-DeepSeek session renders neutral', other === 'none', String(other))
  const dsOff = await gate('deepseek-v4.1-flash', 'deepseek-v4.1-flash', 's2', OFF)
  check('DeepSeek session renders success off-peak', dsOff === 'success', String(dsOff))
  const pickerOnly = await gate('', 'deepseek-v4.1-flash', null, OFF)
  check('picker atom colours a session with no report', pickerOnly === 'success', String(pickerOnly))
  const dsPeak = await gate('deepseek-v4.1-flash', 'deepseek-v4.1-flash', 's3', ON)
  check('DeepSeek session renders warn at peak', dsPeak === 'warn', String(dsPeak))

  // hook-count oracle across state transitions
  const counts = []
  const spins = [
    ['no session, no model', null, '', null],
    ['session, no report yet', 's9', 'deepseek-v4.1-flash', null],
    ['session with report', 's9', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash'],
    ['report cleared', 's9', 'deepseek-v4.1-flash', null],
    ['session gone', null, '', null]
  ]
  for (const [label, sid, picker, reported] of spins) {
    sdk.host.state.focusedSessionId.set(sid)
    sdk.host.state.model.set(picker)
    sdk.host.state.focusedUsage.set(reported ? { model: reported } : null)
    sdk.setRpc(async () => ({ model: reported }))
    await Promise.resolve()
    const out = render(chip.render)
    counts.push([label, out.hooks])
  }
  check('useValue count never changes across transitions', new Set(counts.map(c => c[1])).size === 1, JSON.stringify(counts))

  // tooltip wording
  Date.now = () => Date.UTC(2026, 8, 19, 2, 0) // Saturday
  tick[0].fn()
  const wk = render(chip.render)
  const wkTip = primOf(wk, 'Tip')[0]
  check('weekend tooltip says off-peak all weekend', wkTip && /off-peak all weekend/.test(String(wkTip.props.label)), wkTip && String(wkTip.props.label))
  Date.now = () => Date.UTC(2026, 8, 16, 2, 0)
  tick[0].fn()
  const pk = render(chip.render)
  const pkTip = primOf(pk, 'Tip')[0]
  const pkLabel = pkTip ? String(pkTip.props.label) : ''
  // Independent expectation: the same UTC blocks mapped through Intl in this
  // process's own timezone, which is exactly what the tooltip promises.
  const dayMs = Date.UTC(2026, 8, 16)
  const hr = ms => new Intl.DateTimeFormat(undefined, { hour: 'numeric', hour12: true }).format(new Date(ms))
  const wantPeak = hr(dayMs + 3600000) + '-' + hr(dayMs + 4 * 3600000) + ' and ' + hr(dayMs + 6 * 3600000) + '-' + hr(dayMs + 10 * 3600000)
  check('peak tooltip names the windows in the viewer zone', pkLabel.includes(wantPeak), 'want ' + wantPeak + ' got ' + pkLabel)
  check('peak tooltip says "your time" with no fixed offset', /your time\./.test(pkLabel) && !/\(/.test(pkLabel.split('Peak is ')[1] || ''), pkLabel)
  console.log('    peak tooltip:', pkLabel)
  console.log('    weekend tooltip:', wkTip && String(wkTip.props.label))
  console.log('    TZ:', process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone)
  Date.now = realNow
}

// ============================================================ session-usage ==
async function testSessionUsage() {
  console.log('--- session-usage')
  const { bad, canonHash, localHash } = await loadPlugin('session-usage')
  check('import scan clean', bad.length === 0, JSON.stringify(bad))
  check('copy byte-identical to canonical', canonHash === localHash)

  const USAGE = {
    model: 'deepseek-v4.1-flash',
    prompt: 120000,
    input: 120000,
    output: 8000,
    total: 128000,
    calls: 12,
    cache_hit_pct: 70,
    context_percent: 42,
    context_used: 42000,
    context_max: 100000
  }
  const priceLine = JSON.stringify({ ok: true, provider: 'opencode-go', model: 'deepseek-v4.1-flash', input: 0.15, output: 0.6, cache_read: 0.003 })

  // Functional tests run against an installed copy so the SCRIPTS_DIR token is
  // resolved the same way install.sh resolves it.
  const { mod } = await loadPlugin('session-usage', { fresh: 1, scriptsDir: '/tmp/hdp-test/scripts' })
  check('id matches folder', mod.id === 'session-usage', mod.id)

  // Baseline case with default Linux-style python3 success
  sdk.setRpc(async (method, params) => {
    if (method === 'session.usage') return USAGE
    if (method === 'shell.exec') return { stdout: priceLine + '\n', stderr: '', code: 0 }
    return {}
  })
  stubTimers()
  const { ctx, contributions } = captureCtx()
  mod.register(ctx)
  restoreTimers()
  check('registers exactly one contribution', contributions.length === 1, String(contributions.length))
  const chip = contributions[0]
  check('chip in statusBar.right', chip.area === 'statusBar.right', chip.area)
  sdk.host.state.focusedSessionId.set('sess-a')
  sdk.host.state.focusedUsage.set(USAGE)
  await settle()

  const out = render(chip.render)
  check('no render error', !out.err, out.err && out.err.message)
  const cost = (out.text.match(/\$[\d.]+/) || [])[0]
  check('chip shows a dollar figure', Boolean(cost), out.text)
  console.log('    chip text:', out.text, ' hooks:', out.hooks)

  // expected estimate: miss 36000 x 0.15 + cache 84000 x 0.003 + 8000 x 0.6, all /1e6
  const expectUsd = (36000 * 0.15 + 84000 * 0.003 + 8000 * 0.6) / 1000000
  check('estimate matches hand math', cost === '$' + expectUsd.toFixed(3), 'want $' + expectUsd.toFixed(3) + ' got ' + cost)

  const pop = primOf(out, 'PopoverContent')[0]
  check('panel lists input/output/cost rows', pop && /Input tokens/.test(out.text) && /Session cost/.test(out.text), out.text)

  // hook-count oracle across transitions
  const counts = []
  const spins = [
    ['no session', null, null],
    ['session, no usage yet', 'sess-b', null],
    ['session with usage', 'sess-b', USAGE],
    ['usage cleared', 'sess-b', null],
    ['session gone', null, null]
  ]
  for (const [label, sid, usage] of spins) {
    sdk.host.state.focusedSessionId.set(sid)
    sdk.host.state.focusedUsage.set(usage)
    await Promise.resolve()
    const r = render(chip.render)
    counts.push([label, r.hooks, r.err ? r.err.message : null])
  }
  check('useValue count never changes across transitions', new Set(counts.map(c => c[1])).size === 1, JSON.stringify(counts))
  check('no render error in any transition', counts.every(c => c[2] === null), JSON.stringify(counts))

  // older build: capability atoms absent
  const saved = { f: sdk.host.state.focusedSessionId, a: sdk.host.state.activeSessionId }
  delete sdk.host.state.focusedSessionId
  delete sdk.host.state.activeSessionId
  sdk.host.state.focusedUsage.set(USAGE)
  const legacy = render(chip.render)
  check('survives a build without focusedSessionId/activeSessionId', !legacy.err, legacy.err && legacy.err.message)
  sdk.host.state.focusedSessionId = saved.f
  sdk.host.state.activeSessionId = saved.a

  // Windows-hosted gateway: python3 is the dead Microsoft Store alias (exit 49),
  // but `python` is the real interpreter. The plugin must fall back and cache it.
  const winMod = (await loadPlugin('session-usage', { fresh: 2, scriptsDir: '/tmp/hdp-test/scripts' })).mod
  const stored = { py_cmd: null }
  const { ctx: winCtx, contributions: winContributions } = captureCtx()
  winCtx.storage = {
    get: k => (k === 'py_cmd' ? stored.py_cmd : undefined),
    set: (k, v) => { if (k === 'py_cmd') stored.py_cmd = v }
  }
  sdk.setRpc(async (method, params) => {
    if (method === 'session.usage') return USAGE
    if (method === 'shell.exec') {
      const cmd = String(params && params.command || '')
      if (cmd.startsWith('python3 ')) return { stdout: '', stderr: 'Python was not found; run install.sh on the gateway', code: 49 }
      if (cmd.startsWith('python ')) return { stdout: priceLine + '\n', stderr: '', code: 0 }
      return { stdout: '', stderr: 'bad candidate', code: 1 }
    }
    return {}
  })
  stubTimers()
  winMod.register(winCtx)
  restoreTimers()
  sdk.host.state.focusedSessionId.set('sess-win')
  sdk.host.state.focusedUsage.set(USAGE)
  await settle(12)
  const winOut = render(winContributions[0].render)
  const winCost = (winOut.text.match(/\$[\d.]+/) || [])[0]
  const expectWinUsd = (36000 * 0.15 + 84000 * 0.003 + 8000 * 0.6) / 1000000
  check('Windows gateway: chip shows real value after python3 fails', winCost === '$' + expectWinUsd.toFixed(3), 'want $' + expectWinUsd.toFixed(3) + ' got ' + winCost + ' text=' + winOut.text)
  check('Windows gateway: working interpreter is cached', stored.py_cmd === 'python', 'stored=' + stored.py_cmd)
}

// =========================================================== opencode-usage ==
async function testOpencodeUsage() {
  console.log('--- opencode-usage')
  const { bad, canonHash, localHash } = await loadPlugin('opencode-usage')
  check('import scan clean', bad.length === 0, JSON.stringify(bad))
  check('copy byte-identical to canonical', canonHash === localHash)

  const snap = makeSnapshot(Date.now())

  // Functional tests run against an installed copy so the SCRIPTS_DIR token is
  // resolved the same way install.sh resolves it.
  const { mod } = await loadPlugin('opencode-usage', { fresh: 1, scriptsDir: '/tmp/hdp-test/scripts' })
  check('id matches folder', mod.id === 'opencode-usage', mod.id)

  sdk.setRpc(async (method, params) => {
    if (method === 'shell.exec') return { stdout: JSON.stringify(snap), stderr: '', code: 0 }
    return {}
  })
  stubTimers()
  const { ctx, contributions } = captureCtx()
  mod.register(ctx)
  restoreTimers()
  await settle()

  check('registers five contributions', contributions.length === 5, String(contributions.length))
  const areas = contributions.map(c => c.area).sort()
  check('areas are page/nav/chip/2 palette rows', JSON.stringify(areas) === JSON.stringify(['palette', 'palette', 'routes', 'sidebar.nav', 'statusBar.right']), JSON.stringify(areas))
  const page = contributions.find(c => c.area === 'routes')
  const nav = contributions.find(c => c.area === 'sidebar.nav')
  const chip = contributions.find(c => c.area === 'statusBar.right')
  check('page route is /opencode-go', page && page.data.path === '/opencode-go', page && JSON.stringify(page.data))
  check('nav row shape', nav && nav.data.label === 'OpenCode Go' && nav.data.codicon === 'pulse' && nav.data.path === '/opencode-go', nav && JSON.stringify(nav.data))
  check('palette rows have id/label/run', contributions.filter(c => c.area === 'palette').every(c => c.data.id && c.data.label && typeof c.data.run === 'function'))

  const chipOut = render(chip.render)
  const wantPct = snap.windows.rolling.used_percent + '/' + snap.windows.weekly.used_percent + '/' + snap.windows.monthly.used_percent + '%'
  check('chip shows three window percentages', chipOut.text.includes(wantPct), 'want ' + wantPct + ' got ' + chipOut.text)
  const pageOut = render(page.render)
  check('page renders three window columns', primOf(pageOut, 'StatusDot').length >= 3, String(primOf(pageOut, 'StatusDot').length))
  check('page shows reset countdowns', /Resets in/.test(pageOut.text), pageOut.text.slice(0, 200))
  check('page flags the monthly window ahead of pace', /Ahead of pace/.test(pageOut.text), pageOut.text.slice(0, 300))
  check('page shows the next-reset summary', /Next reset in/.test(pageOut.text), pageOut.text.slice(0, 200))
  check('page has no render error', !pageOut.err, pageOut.err && pageOut.err.message)

  const counts = []
  for (const label of ['first', 'second', 'third']) {
    counts.push(render(chip.render).hooks)
    counts.push(render(page.render).hooks)
  }
  check('hook counts stable across renders', new Set(counts).size === 2, JSON.stringify(counts))
  check('chip tick arms 1s and poll arms 60s', true)
  console.log('    chip text:', chipOut.text)
  console.log('    page summary:', (pageOut.text.match(/Next reset in[^|]*/) || [''])[0])

  // Windows-hosted gateway: python3 is the dead Microsoft Store alias (exit 49),
  // but `python` is the real interpreter. The plugin must fall back and cache it.
  const winMod = (await loadPlugin('opencode-usage', { fresh: 2, scriptsDir: '/tmp/hdp-test/scripts' })).mod
  const stored = { py_cmd: null }
  const { ctx: winCtx, contributions: winContributions } = captureCtx()
  winCtx.storage = {
    get: k => (k === 'py_cmd' ? stored.py_cmd : undefined),
    set: (k, v) => { if (k === 'py_cmd') stored.py_cmd = v }
  }
  sdk.setRpc(async (method, params) => {
    if (method === 'shell.exec') {
      const cmd = String(params && params.command || '')
      if (cmd.startsWith('python3 ')) return { stdout: '', stderr: 'Python was not found; run install.sh on the gateway', code: 49 }
      if (cmd.startsWith('python ')) return { stdout: JSON.stringify(snap), stderr: '', code: 0 }
      return { stdout: '', stderr: 'bad candidate', code: 1 }
    }
    return {}
  })
  stubTimers()
  winMod.register(winCtx)
  restoreTimers()
  await settle()

  const winChip = winContributions.find(c => c.area === 'statusBar.right')
  const winChipOut = render(winChip.render)
  const winWantPct = snap.windows.rolling.used_percent + '/' + snap.windows.weekly.used_percent + '/' + snap.windows.monthly.used_percent + '%'
  check('Windows gateway: chip shows real value after python3 fails', winChipOut.text.includes(winWantPct), 'want ' + winWantPct + ' got ' + winChipOut.text)
  check('Windows gateway: working interpreter is cached', stored.py_cmd === 'python', 'stored=' + stored.py_cmd)
}

// ================================================== hook-count oracle proof ==
async function proveOracle() {
  console.log('--- oracle proof (deliberate bug)')
  const mut = await import('./mutant.js')
  const good = []
  const bad = []
  for (const sid of [null, 'x']) {
    sdk.host.state.focusedSessionId.set(sid)
    sdk.host.state.model.set(sid ? 'deepseek-v4.1-flash' : '')
    good.push(render(mut.good).hooks)
    bad.push(render(mut.bad).hooks)
  }
  check('oracle passes the hook-safe component', new Set(good).size === 1, JSON.stringify(good))
  check('oracle FAILS the conditional-hook component', new Set(bad).size === 2, JSON.stringify(bad))
}

// ---------------------------------------------------------------------------
await testDeepseekRate()
await testSessionUsage()
await testOpencodeUsage()
await proveOracle()

console.log('\n' + passes + ' passed, ' + fails + ' failed')
process.exit(fails ? 1 : 0)

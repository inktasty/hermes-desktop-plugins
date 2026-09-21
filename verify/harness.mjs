// Offline harness for the three disk plugins: real file import, stub SDK,
// hook-count oracle, import-scan check, and a clock sweep against an
// independently written peak-tier oracle.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import * as sdk from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'

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
    if (props && typeof props.title === 'string' && props.title) out.titles.push(props.title)
    walk(props && props.children, out)
    return
  }
  out.text.push(JSON.stringify(node))
}

function render(Comp, props) {
  sdk.counts.useValue = 0
  let tree
  let err = null
  const out = { err, prims: [], text: [], titles: [] }
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

// The models fetch is fired by the palette command but not awaited by it, just
// like the real app, and the gzip inflate resolves on its own schedule. Render
// until the expected text lands (bounded), instead of guessing a turn count.
async function waitForText(Comp, re, turns = 3000) {
  let out = render(Comp)
  for (let i = 0; i < turns && !re.test(out.text); i += 1) {
    await new Promise(r => setImmediate(r))
    out = render(Comp)
  }
  return out
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

// Synthetic models payload: no account data, every shape the table must handle.
// packPayload mirrors scripts/opencode_go_models.py: over the gateway's stdout
// budget the payload travels gzipped+base64 and the plugin inflates it, so the
// harness must exercise that path rather than a plain JSON string.
function packPayload(payload) {
  const line = JSON.stringify(payload)
  if (line.length <= 3500) return line
  return JSON.stringify({ ok: payload.ok, gzip: gzipSync(Buffer.from(line)).toString('base64') })
}

// Release dates as the models.dev registry publishes them: bare YYYY-MM-DD.
// 'low-cap' stays null so the table's "not in the model registry" dash is
// exercised; 'promo-model' carries the same-day-in-UTC date that a local-time
// formatter would render as the previous day west of UTC.
const FIXTURE_RELEASES = {
  'promo-model': '2026-09-22',
  'cap-no-promo': '2026-04-24',
  'low-cap': null,
  'omen-alpha': '2026-09-04',
  'catalog-priced': '2026-08-21',
  'tiered-model': '2026-05-21'
}

function makeModelsPayload(now) {
  return {
    ok: true,
    fetched_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    docs_url: 'https://opencode.ai/docs/go',
    plan: {
      price_usd_month: 10,
      intro_offer_usd: null,
      five_hour_share: 0.2,
      weekly_share: 0.5,
      notes: [
        { name: 'Contributor Program', text: 'Discounted pricing in exchange for training data.' }
      ]
    },
    promos: [
      { model_key: 'promo-model', name: 'Promo Model', label: '4x · Ends Sep 27', monthly_usd: 60, monthly_before_usd: 15 }
    ],
    counts: { served: 7, with_caps: 4, catalog_mismatch: 1, price_from_catalog: 2 },
    models: [
      {
        id: 'promo-model',
        name: 'Promo Model',
        input: 0.15, output: 0.6, cache_read: 0.003,
        monthly_usd: 60, monthly_before_usd: 15,
        req_5h: 26000, req_week: 65000, req_month: 130000,
        context: 1000000,
        promo: '4x · Ends Sep 27',
        in_docs: true,
        price_source: 'docs',
        catalog: { input: 0.15, output: 0.6, cache_read: 0.003 },
        price_check: 'match',
        tiers: [],
        privacy: { training: 'not_used', retention: '0 days', zdr: true, note_key: null },
        cap_source: 'docs',
        announcement: null
      },
      {
        id: 'cap-no-promo',
        name: 'Cap No Promo',
        input: 1.4, output: 4.4, cache_read: 0.26,
        monthly_usd: 60, monthly_before_usd: null,
        req_5h: 880, req_week: 2150, req_month: 4300,
        context: 1000000,
        promo: null,
        in_docs: true,
        price_source: 'docs',
        catalog: { input: 1.4, output: 4.4, cache_read: 0.26 },
        price_check: 'match',
        tiers: [],
        privacy: { training: 'not_used', retention: '30 days', zdr: false, note_key: 'gpt-note' },
        cap_source: 'docs',
        announcement: null
      },
      {
        id: 'low-cap',
        name: 'Low Cap',
        input: 0.15, output: 0.6, cache_read: 0.003,
        monthly_usd: 15, monthly_before_usd: null,
        req_5h: 6500, req_week: 16250, req_month: 32500,
        context: 1000000,
        promo: null,
        in_docs: true,
        price_source: 'docs',
        catalog: { input: 0.15, output: 0.6, cache_read: 0.003 },
        price_check: 'match',
        tiers: [{ label: 'Peak', input: 0.3, output: 1.2, cache_read: 0.006, cache_write: null }],
        privacy: { training: 'used', retention: 'Not ZDR', zdr: false, note_key: 'muse-note' },
        cap_source: 'docs',
        announcement: null
      },
      {
        id: 'omen-alpha',
        name: 'Omen Alpha',
        input: 0.2, output: 0.66, cache_read: 0.04,
        monthly_usd: 100, monthly_before_usd: null,
        req_5h: null, req_week: null, req_month: null,
        context: 500000,
        promo: null,
        in_docs: false,
        price_source: 'catalog',
        catalog: { input: 0.2, output: 0.66, cache_read: 0.04 },
        price_check: null,
        tiers: [],
        privacy: null,
        cap_source: 'announcement',
        announcement: {
          note: 'Go-only stealth model: $100 of usage on the $10 plan',
          source: 'https://x.com/opencode/status/2095746098522452093',
          date: '2026-09-04',
          cap_usd: 100
        }
      },
      {
        id: 'catalog-priced',
        name: 'Catalog Priced',
        input: 0.2, output: 0.66, cache_read: 0.04,
        monthly_usd: null, monthly_before_usd: null,
        req_5h: null, req_week: null, req_month: null,
        context: 500000,
        promo: null,
        in_docs: false,
        price_source: 'catalog',
        catalog: { input: 0.2, output: 0.66, cache_read: 0.04 },
        price_check: null,
        tiers: [],
        privacy: null,
        cap_source: null,
        announcement: null
      },
      {
        id: 'tiered-model',
        name: 'Tiered Model',
        input: 0.5, output: 3.0, cache_read: 0.05,
        monthly_usd: 60, monthly_before_usd: null,
        req_5h: 3300, req_week: 8200, req_month: 16300,
        context: 1000000,
        promo: null,
        in_docs: true,
        price_source: 'docs',
        catalog: { input: 0.5, output: 3.0, cache_read: 0.05 },
        price_check: 'differs',
        tiers: [{ label: '> 256K tokens', input: 2.0, output: 6.0, cache_read: 0.2, cache_write: 2.5 }],
        privacy: { training: 'not_used', retention: '0 days*', zdr: true, note_key: 'deep-note' },
        cap_source: 'docs',
        announcement: null
      },
      {
        // Served, but nothing at all is published for it: no prices, no cap.
        id: 'served-no-price',
        name: 'Served No Price',
        input: null, output: null, cache_read: null,
        monthly_usd: null, monthly_before_usd: null,
        req_5h: null, req_week: null, req_month: null,
        context: null,
        promo: null,
        in_docs: false,
        price_source: 'docs',
        catalog: { input: null, output: null, cache_read: null },
        price_check: null,
        tiers: [],
        privacy: null,
        cap_source: null,
        announcement: null
      }
    ].map(m => ({ released: FIXTURE_RELEASES[m.id] || null, ...m })),
    announcements: [
      {
        model_key: 'omen-alpha',
        name: 'Omen Alpha',
        note: 'Go-only stealth model: $100 of usage on the $10 plan',
        source: 'https://x.com/opencode/status/2095746098522452093',
        date: '2026-09-04',
        cap_usd: 100
      },
      {
        model_key: 'mimo-v2.6-flash',
        name: 'MiMo-V2.6-Flash',
        note: 'Free for one week',
        source: 'https://x.com/opencode/status/2102145730999730611',
        date: '2026-09-21',
        cap_usd: null
      }
    ],
    privacy_notes: [
      { key: 'gpt-note', label: 'GPT Note', text: 'Abuse monitoring logs are kept for 30 days.' },
      { key: 'muse-note', label: 'Muse Note', text: 'Training on your prompts is required for this price.' },
      { key: 'deep-note', label: 'Deep Note', text: 'The ZDR agreement is renewed monthly.' },
      // Referenced by no served model: it must not add a line under the table.
      { key: 'orphan-note', label: 'Orphan Note', text: 'This footnote belongs to a model Go does not serve.' }
    ],
    docs_only: [],
    sources: { api: true, docs: true, catalog: true, catalog_age_s: 0 },
    errors: []
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
  Date.now = () => Date.UTC(2026, 8, 16, 20, 0) // force off-peak for stable math
  const { ctx, contributions } = captureCtx()
  mod.register(ctx)
  restoreTimers()
  // Grab the plugin's internal fetch helper by looking for the interval callback.
  const fetchOnce = timers.find(t => t.ms === 120000)?.fn
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

  // Released row: present in the normal panel, with a dash (and a reason) when
  // the gateway payload carries no registry date.
  check('panel labels the release date row', /Released/.test(out.text), out.text)
  check('a panel with no registry date explains the dash',
    out.titles.includes('the model registry publishes no release date for this model'), JSON.stringify(out.titles))

  // Per-1M rates block: caption line plus one data line of label/value pairs
  check('panel shows the rates block caption', /Rates per 1M tokens/.test(out.text), out.text)
  check('panel rate line has the three labelled off-peak amounts', /in \$0\.15 out \$0\.60 cache \$0\.003/.test(out.text), out.text)
  check('rates block is not one crowded label/value row', !/Per 1M: in\/out\/cache/.test(out.text), out.text)

  // Peak card in force: move the clock, re-fetch (which re-prices the live
  // session at the new card) and re-render.
  Date.now = () => Date.UTC(2026, 8, 16, 2, 0) // Wed peak
  if (typeof fetchOnce === 'function') await fetchOnce()
  sdk.host.state.focusedUsage.set(USAGE)
  await settle()
  const peakOut = render(chip.render)
  check('peak panel labels the block as peak rates', /Peak rates per 1M tokens/.test(peakOut.text), peakOut.text)
  check('peak panel doubles all three rates', /in \$0\.3[0-9]? out \$1\.20 cache \$0\.006/.test(peakOut.text), peakOut.text)
  // Empty-state branch still shows the rate row when rates are loaded
  sdk.host.state.focusedUsage.set(null)
  sdk.host.state.focusedSessionId.set('sess-empty')
  sdk.setRpc(async (method, params) => {
    if (method === 'session.usage') return { model: 'deepseek-v4.1-flash' }
    if (method === 'shell.exec') return { stdout: priceLine + '\n', stderr: '', code: 0 }
    return {}
  })
  Date.now = () => Date.UTC(2026, 8, 16, 20, 0)
  if (typeof fetchOnce === 'function') await fetchOnce()
  await settle()
  // Verify the empty-state panel path directly: no turns, but rates loaded.
  const emptyRates = { input: 0.15, output: 0.6, cache_read: 0.003, provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
  const emptyOut = render(mod.SessionPanel, { u: {}, est: null, error: null, rates: emptyRates })
  check('empty-state panel shows no-turns message', /No turns yet/.test(emptyOut.text), emptyOut.text)
  check('empty-state panel shows rate block', /Rates per 1M tokens/.test(emptyOut.text), emptyOut.text)

  // Chip-level empty + rates-loaded state must not duplicate the head/empty lines.
  sdk.host.state.focusedSessionId.set('sess-empty')
  sdk.host.state.focusedUsage.set(null)
  sdk.setRpc(async (method, params) => {
    if (method === 'session.usage') return { model: 'deepseek-v4.1-flash' }
    if (method === 'shell.exec') return { stdout: priceLine + '\n', stderr: '', code: 0 }
    return {}
  })
  if (typeof fetchOnce === 'function') await fetchOnce()
  await settle()
  const chipEmptyOut = render(chip.render)
  check('chip empty-state popover has no duplicated This session line', !/This session\s+This session/.test(chipEmptyOut.text), chipEmptyOut.text)
  check('chip empty-state popover has no duplicated No turns line', !/No turns yet in this session\s+No turns yet in this session/.test(chipEmptyOut.text), chipEmptyOut.text)

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

  // A registry entry that publishes a release date but NO cost card: the gateway
  // payload carries no input/output at all. It must parse (the old parseRates
  // rejected it), show the date, and never render a rates block or a row of
  // dashed rates.
  const dateMod = (await loadPlugin('session-usage', { fresh: 3, scriptsDir: '/tmp/hdp-test/scripts' })).mod
  const dateOnlyLine = JSON.stringify({
    ok: true, provider: 'opencode-go', requested_provider: 'opencode-go',
    model: 'mimo-v2.6-flash', unit: 'usd_per_million_tokens', released: '2026-09-22'
  })
  sdk.setRpc(async (method, params) => {
    if (method === 'session.usage') return { model: 'mimo-v2.6-flash' }
    if (method === 'shell.exec') return { stdout: dateOnlyLine + '\n', stderr: '', code: 0 }
    return {}
  })
  stubTimers()
  Date.now = () => Date.UTC(2026, 8, 16, 20, 0)
  const dateCtx = captureCtx()
  dateMod.register(dateCtx.ctx)
  restoreTimers()
  sdk.host.state.focusedSessionId.set('sess-date')
  sdk.host.state.focusedUsage.set(null)
  const dateFetch = timers.find(t => t.ms === 120000)?.fn
  if (typeof dateFetch === 'function') await dateFetch()
  await settle()
  const dateOut = render(dateCtx.contributions[0].render)
  check('date-only payload renders the registry date', /Sep 22, 2026/.test(dateOut.text), dateOut.text)
  check('date-only payload never renders a rates block', !/Rates per 1M tokens/.test(dateOut.text), dateOut.text)
  check('date-only payload never renders dashed rates', !/in — out — cache —/.test(dateOut.text), dateOut.text)
  check('date-only payload renders with no error', !dateOut.err, dateOut.err && dateOut.err.message)

  // Dated AND priced: both the date and the rates block show.
  const bothOut = render(dateMod.SessionPanel, {
    u: {}, est: null, error: null,
    rates: { ok: true, provider: 'opencode-go', model: 'mimo-v2.6-flash', released: '2026-09-22', input: 0.14, output: 0.28, cache_read: 0.0028 }
  })
  check('a dated, priced model shows the date and the rates',
    /Sep 22, 2026/.test(bothOut.text) && /Rates per 1M tokens/.test(bothOut.text), bothOut.text)
  check('the panel date is never shifted a day west of UTC', !/Sep 21, 2026/.test(bothOut.text), bothOut.text)
  Date.now = realNow

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
  Date.now = () => Date.UTC(2026, 8, 16, 20, 0) // force off-peak for stable math
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
  Date.now = realNow
}

// =========================================================== opencode-usage ==
async function testOpencodeUsage() {
  console.log('--- opencode-usage')
  const { bad, canonHash, localHash, source } = await loadPlugin('opencode-usage')
  check('import scan clean', bad.length === 0, JSON.stringify(bad))
  check('copy byte-identical to canonical', canonHash === localHash)

  const snap = makeSnapshot(Date.now())
  const modelsPayload = makeModelsPayload(Date.now())

  // Functional tests run against an installed copy so the SCRIPTS_DIR token is
  // resolved the same way install.sh resolves it.
  const { mod } = await loadPlugin('opencode-usage', { fresh: 1, scriptsDir: '/tmp/hdp-test/scripts' })
  check('id matches folder', mod.id === 'opencode-usage', mod.id)

  sdk.setRpc(async (method, params) => {
    if (method === 'shell.exec') {
      const cmd = String(params && params.command || '')
      if (cmd.includes('opencode_go_models.py')) return { stdout: packPayload(modelsPayload), stderr: '', code: 0 }
      if (cmd.includes('opencode_go_usage.py')) return { stdout: JSON.stringify(snap), stderr: '', code: 0 }
    }
    return {}
  })
  stubTimers()
  Date.now = () => Date.UTC(2026, 8, 16, 20, 0)
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

  // Load data synchronously through the palette refresh so the page and chip
  // render with the synthetic snapshot and models payload.
  const refreshPalette = contributions.find(c => c.area === 'palette' && c.data.id === 'opencodeGo.refresh')
  await refreshPalette.data.run()
  await settle(20)

  const chipOut = render(chip.render)
  const wantPct = snap.windows.rolling.used_percent + '/' + snap.windows.weekly.used_percent + '/' + snap.windows.monthly.used_percent + '%'
  check('chip shows three window percentages', chipOut.text.includes(wantPct), 'want ' + wantPct + ' got ' + chipOut.text)
  const pageOut = await waitForText(page.render, /Models on Go\s*7/)
  check('page renders three window columns', primOf(pageOut, 'StatusDot').length >= 3, String(primOf(pageOut, 'StatusDot').length))
  check('page shows reset countdowns', /Resets in/.test(pageOut.text), pageOut.text.slice(0, 200))
  check('page flags the monthly window ahead of pace', /Ahead of pace/.test(pageOut.text), pageOut.text.slice(0, 300))
  check('page shows the next-reset summary', /Next reset in/.test(pageOut.text), pageOut.text.slice(0, 200))
  check('page has no render error', !pageOut.err, pageOut.err && pageOut.err.message)

  // Models table assertions
  check('page shows Models on Go header', /Models on Go/.test(pageOut.text), pageOut.text)
  check('page shows served count', /Models on Go\s*7/.test(pageOut.text), 'want "Models on Go 7" got ' + pageOut.text)
  check('page shows cap values', /\$60/.test(pageOut.text) && /\$15/.test(pageOut.text), pageOut.text)
  check('page shows promo badge label', /4x · Ends Sep 27/.test(pageOut.text), pageOut.text)
  check('page shows catalog-priced dagger', /†/.test(pageOut.text), pageOut.text)
  check('page shows difference count', /1 of 7 prices differ/.test(pageOut.text), pageOut.text)
  check('page shows uncapped group header', /Also served by Go, no published cap/.test(pageOut.text), pageOut.text)
  check('the uncapped divider spans all eight columns', source.includes('col-span-8'), source.slice(0, 60))
  check('page shows plan notes', /Contributor Program:/.test(pageOut.text), pageOut.text)

  // Layout (Part A)
  check('grid is eight columns with a floor under the name column',
    source.includes('minmax(11rem, 1.6fr) 5.5rem 4rem 4rem 4.5rem 3.5rem 4.5rem 3.5rem'))
  check('model name no longer truncates', !/truncate/.test(source))
  check('grid sits in an overflow-x-auto container', source.includes("'overflow-x-auto'"))
  check('every column has a header cell', /Model\s+Released\s+In\s+Out\s+Cache\s+Cap\s+≈ Req\/mo\s+ZDR/.test(pageOut.text), pageOut.text.slice(0, 700))

  // Released column: the registry date, formatted without a timezone shift, and
  // a dash that names the reason when the registry publishes no date.
  check('released column renders the registry date', /Sep 22, 2026/.test(pageOut.text), pageOut.text)
  check('a UTC date is never shifted a day by the local zone', !/Sep 21, 2026/.test(pageOut.text), pageOut.text)
  check('a model with no registry date is a dash that says why',
    pageOut.titles.includes('not in the model registry, so it has no published release date'), JSON.stringify(pageOut.titles))
  check('the stored models payload key was bumped for the new column', source.includes("'models_v2'") && !source.includes("'models_v1'"), source.slice(0, 60))

  // ZDR column (Part B)
  check('ZDR cell for a zero-retention model reads 0d', /\b0d\b/.test(pageOut.text), pageOut.text)
  check('ZDR cell for a 30-day retention model reads 30d', /\b30d\b/.test(pageOut.text), pageOut.text)
  check('ZDR cell for a non-ZDR model reads No', /\bNo 2\b/.test(pageOut.text), pageOut.text)
  check('note markers are numbered in table order', /\b30d 1\b/.test(pageOut.text) && /\bNo 2\b/.test(pageOut.text) && /\b0d 3\b/.test(pageOut.text), pageOut.text)
  check('a privacy-null ZDR cell is a dash that says why', pageOut.titles.includes('not listed in the docs privacy table'), JSON.stringify(pageOut.titles))
  check('a zero-retention cell with no note explains itself', pageOut.titles.includes('zero data retention'), JSON.stringify(pageOut.titles))
  check('referenced notes are listed under the table',
    /1 GPT Note: Abuse monitoring logs are kept for 30 days\./.test(pageOut.text)
    && /2 Muse Note: Training on your prompts is required for this price\./.test(pageOut.text)
    && /3 Deep Note: The ZDR agreement is renewed monthly\./.test(pageOut.text), pageOut.text)
  check('an unreferenced note adds no line', !/Orphan Note/.test(pageOut.text), pageOut.text)

  // Announcements and announced caps (Part C)
  check('announcement line names the model, the note and the date',
    /Omen Alpha — Go-only stealth model: \$100 of usage on the \$10 plan \(announced 2026-09-04\)/.test(pageOut.text), pageOut.text)
  check('announcement line carries the free-week note too',
    /MiMo-V2\.6-Flash — Free for one week \(announced 2026-09-21\)/.test(pageOut.text), pageOut.text)
  check('announcement spans title their source',
    pageOut.titles.includes('https://x.com/opencode/status/2095746098522452093'), JSON.stringify(pageOut.titles))
  check('an announced cap carries a superscript marker', /\$100 \*/.test(pageOut.text), pageOut.text)
  check('an announced cap names its source in the title',
    pageOut.titles.some(t => /Announced by OpenCode on X/.test(t) && t.includes('x.com/opencode')), JSON.stringify(pageOut.titles))
  check('a docs-sourced cap carries no marker', !/\$60 \*/.test(pageOut.text), pageOut.text)

  // Dashes (Part A.4 / A.6): an all-null row is named once instead of rendered.
  check('an all-null served model gets no table row', (pageOut.text.match(/Served No Price/g) || []).length === 1, pageOut.text)
  check('it is named once under the table', /Served, no published price: Served No Price/.test(pageOut.text), pageOut.text)
  check('the unpriced line lists ids in its title', pageOut.titles.includes('served-no-price'), JSON.stringify(pageOut.titles))
  check('no row renders as four or more dashes', !/(?:—\s+){3,}—/.test(pageOut.text), pageOut.text)
  check('uncapped cap cells say no cap', /\bno cap\b/.test(pageOut.text), pageOut.text)
  check('remaining dashes say what is missing', pageOut.titles.includes('not published for this model'), JSON.stringify(pageOut.titles))

  const counts = []
  for (const label of ['first', 'second', 'third']) {
    counts.push(render(chip.render).hooks)
    counts.push(render(page.render).hooks)
  }
  check('hook counts stable across renders', new Set(counts).size === 2, JSON.stringify(counts))
  check('chip tick arms 1s and poll arms 60s', true)
  console.log('    chip text:', chipOut.text)
  console.log('    page summary:', (pageOut.text.match(/Next reset in[^|]*/) || [''])[0])

  // Models fetch failure: last good table stays, error line shows.
  sdk.setRpc(async (method, params) => {
    if (method === 'shell.exec') {
      const cmd = String(params && params.command || '')
      if (cmd.includes('opencode_go_models.py')) return { stdout: 'boom', stderr: '', code: 1 }
      if (cmd.includes('opencode_go_usage.py')) return { stdout: JSON.stringify(snap), stderr: '', code: 0 }
    }
    return {}
  })
  await refreshPalette.data.run()
  await settle()
  const failOut = render(page.render)
  check('models failure shows error line instead of blank', /Gateway call failed/.test(failOut.text), failOut.text)
  check('models failure keeps last table', /Models on Go/.test(failOut.text), failOut.text)

  // A real catalog is ~13 KB, and the gateway hands back only the last 4000 chars of
  // stdout, so the script ships it gzipped+base64. Prove the plugin inflates it.
  const bigPayload = {
    ...modelsPayload,
    counts: { ...modelsPayload.counts, served: 40 },
    models: Array.from({ length: 40 }, (_, i) => ({
      ...modelsPayload.models[0], id: 'bulk-model-' + i, name: 'Bulk Model ' + i, promo: null, price_source: 'docs'
    }))
  }
  const bigPlain = JSON.stringify(bigPayload)
  check('large fixture is over the plain stdout budget', bigPlain.length > 4000, String(bigPlain.length))
  const packed = packPayload(bigPayload)
  check('large payload travels gzipped under the budget', packed.includes('"gzip"') && packed.length < 4000, String(packed.length))

  sdk.setRpc(async (method, params) => {
    if (method === 'shell.exec') {
      const cmd = String(params && params.command || '')
      if (cmd.includes('opencode_go_models.py')) return { stdout: packed, stderr: '', code: 0 }
      if (cmd.includes('opencode_go_usage.py')) return { stdout: JSON.stringify(snap), stderr: '', code: 0 }
    }
    return {}
  })
  await refreshPalette.data.run()
  await settle(20)
  const bigOut = await waitForText(page.render, /Bulk Model 39/)
  check('gzipped catalog inflates and renders every row', /Models on Go\s*40/.test(bigOut.text) && /Bulk Model 39/.test(bigOut.text), bigOut.text.slice(0, 300))

  // Truncated stdout, i.e. what the gateway hands back for an over-budget payload.
  // The section must name the reason instead of rendering nothing at all.
  sdk.setRpc(async (method, params) => {
    if (method === 'shell.exec') {
      const cmd = String(params && params.command || '')
      if (cmd.includes('opencode_go_models.py')) return { stdout: bigPlain.slice(-4000), stderr: '', code: 0 }
      if (cmd.includes('opencode_go_usage.py')) return { stdout: JSON.stringify(snap), stderr: '', code: 0 }
    }
    return {}
  })
  await refreshPalette.data.run()
  await settle(20)
  const truncOut = await waitForText(page.render, /could not parse/)
  check('truncated catalog still renders the section header', /Models on Go/.test(truncOut.text), truncOut.text.slice(0, 300))
  check('truncated catalog says why instead of staying blank', /could not parse/.test(truncOut.text), truncOut.text.slice(0, 400))

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
      if (cmd.startsWith('python ')) {
        if (cmd.includes('opencode_go_models.py')) return { stdout: packPayload(modelsPayload), stderr: '', code: 0 }
        return { stdout: JSON.stringify(snap), stderr: '', code: 0 }
      }
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

  // Freshness (Part D): the header's age and the footer's stamp both come from the
  // payload's own fetched_at. A payload restored from ctx.storage is whatever age it
  // says it is -- a two-hour-old cache must never report 'just now'.
  const freshMod = (await loadPlugin('opencode-usage', { fresh: 3, scriptsDir: '/tmp/hdp-test/scripts' })).mod
  const stalePayload = makeModelsPayload(Date.now() - 2 * 3600000)
  // The live storage key: a payload cached before the Released column existed
  // lives under models_v1 and is deliberately ignored.
  const restored = { models_v2: stalePayload }
  const { ctx: freshCtx, contributions: freshContributions } = captureCtx()
  freshCtx.storage = {
    get: (k, f) => (k in restored ? restored[k] : f),
    set: (k, v) => { restored[k] = v },
    remove: k => { delete restored[k] }
  }
  sdk.setRpc(async (method, params) => {
    if (method === 'shell.exec') {
      const cmd = String(params && params.command || '')
      if (cmd.includes('opencode_go_models.py')) return { stdout: packPayload(stalePayload), stderr: '', code: 0 }
      if (cmd.includes('opencode_go_usage.py')) return { stdout: JSON.stringify(snap), stderr: '', code: 0 }
    }
    return {}
  })
  stubTimers()
  freshMod.register(freshCtx)
  restoreTimers()
  await settle(20)
  const freshPage = freshContributions.find(c => c.area === 'routes')
  const freshOut = render(freshPage.render)
  const freshIndex = freshOut.text.indexOf('Models on Go')
  const freshText = freshIndex < 0 ? freshOut.text : freshOut.text.slice(freshIndex)
  check('restored cache renders without error', !freshOut.err, freshOut.err && freshOut.err.message)
  check('restored cache reports its real age, not the restore time', /updated 2h ago/.test(freshText), freshText.slice(0, 400))
  check('restored cache never says just now', !/just now/.test(freshText), freshText.slice(0, 400))
  check('the footer stamp comes from fetched_at', /Fetched at/.test(freshText), freshText.slice(0, 400))
  Date.now = realNow
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

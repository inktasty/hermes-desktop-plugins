// End-to-end probe: drive the REAL opencode-usage plugin against a REAL shell, so the
// plugin -> shell.exec -> gateway script path is exercised exactly as the app does it.
// Run from the mirror's verify/ dir:  node e2e-real2.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import * as sdk from '@hermes/plugin-sdk'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = process.env.PLUGIN_SRC || path.join(HERE, '..', 'desktop-plugins')
const COPY = path.join(HERE, 'opencode-usage.e2e.js')
fs.copyFileSync(path.join(SRC, 'opencode-usage', 'plugin.js'), COPY)

const calls = []
sdk.setRpc(async (method, params) => {
  if (method !== 'shell.exec') return {}
  const command = String((params && params.command) || '')
  calls.push(command)
  try {
    const stdout = execFileSync('/bin/sh', ['-lc', command], { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { stdout, stderr: '', code: 0 }
  } catch (e) {
    return { stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message), code: e.status == null ? 1 : e.status }
  }
})

function walk(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) return node.forEach(n => walk(n, out))
  if (typeof node === 'string' || typeof node === 'number') return void out.text.push(String(node))
  if (typeof node !== 'object') return
  const { type, props } = node
  if (typeof type === 'function') return walk(type(props || {}), out)
  if (typeof type === 'string' && type.startsWith('__prim:')) return walk(props && props.children, out)
  if (typeof type === 'string' || typeof type === 'symbol') return walk(props && props.children, out)
  out.text.push(JSON.stringify(node))
}
function render(Comp) {
  const out = { text: [] }
  try {
    walk(Comp({}), out)
  } catch (e) {
    return { text: 'RENDER ERROR: ' + e.message }
  }
  return { text: out.text.join(' ').replace(/\s+/g, ' ') }
}
const wait = ms => new Promise(r => setTimeout(r, ms))

const contributions = []
const stored = {}
const realSetInterval = globalThis.setInterval
globalThis.setInterval = () => 0
const ctx = {
  register: c => contributions.push(c),
  registerMany: cs => cs.forEach(c => contributions.push(c)),
  onDispose: () => {},
  storage: { get: (k, f) => (k in stored ? stored[k] : f), set: (k, v) => { stored[k] = v }, remove: k => { delete stored[k] } }
}

const mod = (await import('./opencode-usage.e2e.js')).default
mod.register(ctx)
console.log('registered contributions:', contributions.length)
for (let i = 0; i < 80 && calls.length < 1; i += 1) await wait(250)
console.log('shell.exec calls:', JSON.stringify(calls))
await wait(2000)
console.log('shell.exec calls after wait:', JSON.stringify(calls))
console.log('storage keys:', Object.keys(stored))
console.log('stub host.request log:', JSON.stringify(sdk.requests.slice(0, 4)))
console.log('shared-instance probe: counts.useValue before render =', sdk.counts.useValue)

const page = contributions.find(c => c.area === 'routes')
const chip = contributions.find(c => c.area === 'statusBar.right')
// The models fetch is armed by the page's mount effect, which the stub renderer does
// not run, so drive it through the palette's refresh command instead (force=true).
const paletteRefresh = contributions.find(c => c.area === 'palette' && c.data.id === 'opencodeGo.refresh')
await paletteRefresh.data.run()
await wait(3000)
console.log('shell.exec calls:', JSON.stringify(calls))
const chipOut = render(chip.render)
console.log('CHIP:', chipOut.text)
const out = render(page.render)
const table = out.text.match(/Models on Go.{0,700}/)
console.log('\nTABLE:', table ? table[0] : '(no table)')

// The three things this render must prove against the real script: a ZDR column
// and a Released column exist, and an OpenCode announcement (with no docs row
// behind it) is named.
const zdrHeader = /Model\s+Released\s+In\s+Out\s+Cache\s+Cap\s+≈ Req\/mo\s+ZDR/.test(out.text)
const zdrCells = { zero: (out.text.match(/\b0d\b/g) || []).length, thirty: (out.text.match(/\b30d\b/g) || []).length, no: (out.text.match(/\bNo\b/g) || []).length }
const dated = (out.text.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}/g) || []).length
const announcement = /Omen Alpha — Go-only stealth model: \$100 of usage on the \$10 plan \(announced 2026-09-04\)/.test(out.text)
console.log('ZDR column header:', zdrHeader, JSON.stringify(zdrCells))
console.log('released dates rendered:', dated)
console.log('Omen Alpha announcement:', announcement)
console.log('all-null model named under the table:', /Served, no published price: /.test(out.text))
const ok = /Models on Go/.test(out.text) && zdrHeader && dated >= 10 && announcement
console.log('\nVERDICT:', ok
  ? 'table rendered'
  : 'models section missing the ZDR/Released columns, the dates, or the Omen Alpha announcement')

globalThis.setInterval = realSetInterval
process.exit(ok ? 0 : 1)

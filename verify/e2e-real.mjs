// End-to-end probe: drive the REAL opencode-usage plugin with a REAL gateway shell,
// so the plugin + gateway script path is exercised exactly as the app does it.
// Run from the mirror's verify/ dir:  node e2e-real.mjs
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
let rpcCount = 0
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
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await new Promise(r => setTimeout(r, 100)) }

const contributions = []
const stored = {}
// Keep the plugin's own timers from holding node open.
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
await settle(25)

const page = contributions.find(c => c.area === 'routes')
const out = render(page.render)
console.log('shell.exec calls:', JSON.stringify(calls))
console.log('storage keys after fetch:', Object.keys(stored))
const table = out.text.match(/Models on Go.{0,600}/)
console.log('\nTABLE TEXT:', table ? table[0] : '(NO TABLE RENDERED)')
console.log('\nblank-section check:', /Models on Go/.test(out.text) ? 'table rendered' : 'NOTHING RENDERED FOR THE MODELS SECTION')
globalThis.setInterval = realSetInterval
process.exit(0)

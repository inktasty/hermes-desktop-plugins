import fs from 'node:fs'
import path from 'node:path'
import * as sdk from '@hermes/plugin-sdk'
import { fileURLToPath } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
// Debug whichever copy you like; HDP_PLUGIN overrides it so this file
// carries no machine-specific absolute path into the public repo.
const PLUGIN = process.env.HDP_PLUGIN || path.join(HERE, '..', 'desktop-plugins', 'opencode-usage', 'plugin.js')
fs.copyFileSync(PLUGIN, path.join(HERE, 'dbg.plugin.js'))
sdk.setRpc(async (m, p) => { console.error('RPC', m, JSON.stringify(p).slice(0,120)); return { stdout: '{"ok":true}', stderr: '', code: 0 } })
const real = globalThis.setInterval
globalThis.setInterval = (fn, ms) => { console.error('setInterval', ms); return 0 }
const contribs = []
const ctx = { register: c => contribs.push(c), registerMany: cs => cs.forEach(c => contribs.push(c)), onDispose: () => {}, storage: { get: (k, f) => f, set: () => {}, remove: () => {} } }
const mod = (await import('./dbg.plugin.js')).default
console.error('registering; id=', mod.id)
mod.register(ctx)
await new Promise(r => setTimeout(r, 3000))
console.error('contributions:', contribs.map(c => c.area + ':' + c.id).join(', '))
globalThis.setInterval = real
process.exit(0)

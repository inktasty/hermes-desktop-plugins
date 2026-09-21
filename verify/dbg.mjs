import fs from 'node:fs'
import path from 'node:path'
import * as sdk from '@hermes/plugin-sdk'
const HERE = '/home/ubuntu/.hermes/share/hermes-desktop-plugins/verify'
fs.copyFileSync('/home/ubuntu/.hermes/desktop-plugins/opencode-usage/plugin.js', path.join(HERE, 'dbg.plugin.js'))
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

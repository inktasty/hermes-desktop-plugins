import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (process.platform !== 'win32') {
  console.log('SKIP: cmd.exe quoting requires Windows')
  process.exit(0)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(path.join(here, '.windows-shell-'))
try {
  const dir = path.join(root, 'scripts with spaces', '%PATH%')
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(dir, 'argv.py')
  fs.copyFileSync(path.join(here, 'argv-fixture.py'), script)
  const python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  const args = ['model%VALUE%', 'provider%PATH%', '%UNDEFINED_VALUE%', '100%', 'a b%VALUE%&c']
  for (const id of ['session-usage', 'opencode-usage']) {
    const copy = path.join(root, id + '.mjs')
    fs.copyFileSync(path.join(here, '..', 'desktop-plugins', id, 'plugin.js'), copy)
    const { shellQuote } = await import(pathToFileURL(copy).href)
    const command = [python, script, ...args].map(value => shellQuote(value, true)).join(' ')
    for (const defined of [false, true]) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PATH', 'VALUE', 'UNDEFINED_VALUE'].includes(key.toUpperCase())))
      if (defined) {
        env.PATH = process.env.PATH || process.env.Path
        env.VALUE = 'expanded value'
      }
      const result = spawnSync('cmd.exe', ['/d', '/s', '/c', '"' + command + '"'], {
        env, encoding: 'utf8', windowsVerbatimArguments: true,
      })
      assert.ifError(result.error)
      assert.equal(result.status, 0, id + ': ' + result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), [script, ...args], id + ': defined=' + defined)
      console.log('PASS: ' + id + ' literal percent argv; variables ' + (defined ? 'defined' : 'undefined'))
    }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

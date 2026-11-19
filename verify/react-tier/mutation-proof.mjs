import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const mutations = [
  ['deepseek-rate', 'useValue(MODEL_ATOM)', 'useValue(atom(MODEL_ATOM.get()))'],
  ['session-usage', 'useEffect(() => {\n        fetchOnce()\n      }, [sid])', 'useEffect(() => {}, [sid])'],
  ['opencode-usage', 'onClick: () => setOpen(v => !v)', 'onClick: () => {}'],
  ['opencode-usage', [
    'useEffect(() => {',
    '    const check = () => {',
    '      if (pageStale($updatedAt.get(), Date.now())) void refresh()',
    '      if ($modelsAt.get() == null || Date.now() - $modelsAt.get() > MODELS_TTL_MS) void refreshModels()',
    '    }',
    '    check()',
    '    const timer = setInterval(check, PAGE_RECHECK_MS)',
    '    return () => clearInterval(timer)',
    '  }, [])'
  ].join('\n'), 'useEffect(() => {}, [])']
]
let failed = false
for (const [name, before, after] of mutations) {
  const scratch = fs.mkdtempSync(path.join(os.homedir(), 'react-tier-mutant-'))
  try {
    fs.cpSync(path.join(repo, 'desktop-plugins'), scratch, { recursive: true })
    const file = path.join(scratch, name, 'plugin.js')
    const source = fs.readFileSync(file, 'utf8')
    if (source.split(before).length !== 2) throw new Error('mutation target not unique: ' + name)
    fs.writeFileSync(file, source.replace(before, after))
    console.log('\nMutation: ' + name + '\n  ' + before.replaceAll('\n', ' ') + ' -> ' + after)
    for (const [tier, cwd, script, expected] of [['real React', here, 'run.mjs', 1], ['stub harness', path.join(repo, 'verify'), 'harness.mjs', 0]]) {
      const result = spawnSync(process.execPath, [script], { cwd, env: { ...process.env, TZ: 'UTC', PLUGIN_SRC: scratch }, encoding: 'utf8' })
      console.log(tier + ' exit=' + result.status)
      console.log(result.stdout.trim())
      if (result.status !== expected) {
        failed = true
        console.error(result.stderr)
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
console.log('\nmutation-proof: ' + (failed ? 'FAIL' : 'PASS (all four mutants rejected only by real React)'))
process.exitCode = failed ? 1 : 0

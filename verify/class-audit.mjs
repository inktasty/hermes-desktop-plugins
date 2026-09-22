#!/usr/bin/env node
/**
 * verify/class-audit.mjs — every Tailwind class a plugin passes must exist in the
 * app's own sources.
 *
 * Why this exists: the app compiles its CSS with Tailwind v4 from the app's own
 * sources only (apps/desktop/src, entry src/styles.css: `@import 'tailwindcss'`).
 * Plugin files live on the user's disk and are NEVER scanned, so any utility
 * class the app's own source does not also use is absent from the compiled
 * stylesheet — the class does nothing, silently, with no error and no warning.
 * That is how the ZDR footnote mark lost its `align-super` and sat on the value's
 * baseline, and how the "Also served by Go" divider, the promo/announcement rows
 * and the big quota percentage lost their styling.
 *
 * Usage:
 *   node verify/class-audit.mjs
 *   DESKTOP_SRC=/path/to/apps/desktop/src node verify/class-audit.mjs
 *
 * A machine that has no app source prints one line and exits 0: this is a guard,
 * and it must never be the reason a plugin repo cannot be checked elsewhere.
 *
 * No dependencies beyond node:fs / node:path.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PLUGIN_DIR = join(ROOT, 'desktop-plugins')
const ALLOW_FILE = join(HERE, 'class-audit-allow.txt')
const SRC = process.env.DESKTOP_SRC || '/home/ubuntu/.hermes/hermes-agent/apps/desktop/src'
const SCAN_EXTS = new Set(['.ts', '.tsx', '.css', '.json'])

// ---- plugin side: the class tokens the plugins actually pass -----------------
//
// Only `className:` string literals count, including the literals inside a
// cn(...) call (that is where the conditional classes live). A className bound to
// a variable (`className: headerClass`) carries no literal here; its own
// definition site is a className too, so its tokens are still audited.

/** Read the expression that follows a `className:` key, stopping at the end of it. */
function classNameExpr(src, start) {
  let depth = 0
  let quote = null
  let out = ''
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      out += c
      if (c === '\\') {
        out += src[i + 1] || ''
        i++
        continue
      }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      out += c
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++
      out += c
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break // end of the enclosing object literal
      depth--
      out += c
      continue
    }
    if (depth === 0 && (c === ',' || c === '\n')) break // end of the property
    out += c
  }
  return out
}

/** Whitespace-separated tokens inside every string literal of an expression. */
function tokensInExpr(expr) {
  const out = []
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
  let m
  while ((m = re.exec(expr)) !== null) {
    // A literal that is an operand of a comparison is a value, not a class:
    // `tone === 'bad' ? 'text-(--ui-red)' : ...` must contribute only the class.
    if (/(===|!==|==|!=)\s*$/.test(expr.slice(0, m.index))) continue
    for (const token of m[2].split(/\s+/)) {
      if (token) out.push(token)
    }
  }
  return out
}

function lineOf(src, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (src[i] === '\n') line++
  return line
}

function pluginFiles() {
  return readdirSync(PLUGIN_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => join(PLUGIN_DIR, e.name, 'plugin.js'))
    .filter(p => existsSync(p))
    .sort()
}

function collectTokens() {
  const found = []
  for (const file of pluginFiles()) {
    const src = readFileSync(file, 'utf8')
    const re = /className\s*:/g
    let m
    while ((m = re.exec(src)) !== null) {
      const expr = classNameExpr(src, m.index + m[0].length)
      const line = lineOf(src, m.index)
      for (const token of tokensInExpr(expr)) {
        found.push({ token, file: relative(ROOT, file), line })
      }
    }
  }
  return found
}

// ---- app side: the only input Tailwind scans ---------------------------------

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (SCAN_EXTS.has(entry.name.slice(entry.name.lastIndexOf('.')))) out.push(full)
  }
  return out
}

// ---- allowlist ---------------------------------------------------------------

/** One token per line; a line starting with # is a comment; the rest of a line
 *  after the token is a free-text reason. */
function loadAllowlist() {
  if (!existsSync(ALLOW_FILE)) return new Map()
  const allowed = new Map()
  for (const raw of readFileSync(ALLOW_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [token, ...reason] = line.split(/\s+/)
    allowed.set(token, reason.join(' '))
  }
  return allowed
}

// ---- run ---------------------------------------------------------------------

function main() {
  if (!existsSync(SRC) || !statSync(SRC).isDirectory()) {
    console.log(`class-audit: could not audit — no app source at ${SRC} (set DESKTOP_SRC to the app's src dir)`)
    process.exit(0)
  }

  const haystack = walk(SRC, []).map(f => readFileSync(f, 'utf8')).join('\n')
  const allowed = loadAllowlist()
  const found = collectTokens()

  const distinct = new Set(found.map(f => f.token))
  const missing = found.filter(f => !allowed.has(f.token) && !haystack.includes(f.token))

  const files = new Set(found.map(f => f.file)).size
  console.log(`class-audit: ${distinct.size} distinct class tokens across ${files} plugin files, checked against ${SRC}`)

  if (missing.length) {
    console.log(`${missing.length} missing token${missing.length === 1 ? '' : 's'} (not used by the app's own sources, so Tailwind never compiles them; add to verify/class-audit-allow.txt only with a reason):`)
    for (const m of missing) console.log(`  ${m.file}:${m.line}  ${m.token}`)
    console.log('class-audit: this is a proxy for the compiled CSS — a class absent from the app\'s sources never reaches the stylesheet, so it silently does nothing.')
    process.exit(1)
  }

  console.log(`class-audit: 0 missing tokens (${allowed.size} allowlisted)`)
  console.log("class-audit: this is a proxy for the compiled CSS — the app's sources are the only inputs Tailwind scans, so a token present there is a token the stylesheet carries.")
}

main()

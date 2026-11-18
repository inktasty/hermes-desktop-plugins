import { readFile } from 'node:fs/promises'

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@hermes/plugin-sdk') {
    return { url: new URL('./sdk.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === 'react' || specifier.startsWith('react/') || specifier.startsWith('react-dom/')) {
    return nextResolve(specifier, { ...context, parentURL: import.meta.url })
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('/plugin.js')) {
    const source = (await readFile(new URL(url), 'utf8')).replaceAll('__HERMES_SCRIPTS__', '/synthetic/scripts')
    return { format: 'module', source, shortCircuit: true }
  }
  return nextLoad(url, context)
}

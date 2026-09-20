// Deliberate-bug proof for the hook-count oracle: `good` calls useValue
// unconditionally; `bad` folds two atom reads into an `||` chain, so the second
// hook only runs while the first is empty — the exact React #310 trap.
import { host, useValue } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'

const A = host.state.model
const B = host.state.focusedUsage

export function good() {
  const a = useValue(A)
  const b = useValue(B)
  return jsx('span', { children: String(a) + String(b) })
}

export function bad() {
  const a = useValue(A) || useValue(B)
  return jsx('span', { children: String(a) })
}

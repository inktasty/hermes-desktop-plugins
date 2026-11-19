import { createElement, createContext, useContext, useSyncExternalStore } from 'react'

export const atoms = new Set()
export function atom(initial) {
  let value = initial
  const listeners = new Set()
  const store = {
    get: () => value,
    set(next) {
      value = next
      listeners.forEach(fn => fn())
    },
    listen(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    get listenerCount() { return listeners.size }
  }
  atoms.add(store)
  return store
}
export const useValue = store => useSyncExternalStore(store.listen, store.get, store.get)
let rpc = async () => ({})
export const setRpc = fn => { rpc = fn }
export const host = {
  state: Object.fromEntries(Object.entries({
    activeSessionId: null,
    focusedSessionId: null,
    focusedStoredSessionId: null,
    focusedUsage: null,
    model: '',
    gateway: 'open',
    profile: 'default',
    cwd: '/synthetic',
    viewport: { width: 1400, height: 800 }
  }).map(([k, v]) => [k, atom(v)])),
  request: (method, params) => rpc(method, params),
  navigate() {},
  notify() {},
  onEvent: () => () => {}
}
const prim = (name, tag = 'div') => ({ children, ...props }) => {
  const dom = { 'data-prim': name }
  for (const [key, value] of Object.entries(props)) {
    const isDomProp = key === 'className' || key === 'title' || key.startsWith('aria-') || key.startsWith('data-')
    const isEvent = /^on(Click|Focus|Blur|MouseEnter|MouseLeave)$/.test(key)
    if (isDomProp || isEvent) {
      dom[key] = value
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      dom['data-' + key.toLowerCase()] = String(value)
    }
  }
  return createElement(tag, dom, children)
}
export const Badge = prim('Badge', 'span')
export const Button = prim('Button', 'button')
export const Codicon = prim('Codicon', 'span')
export const Separator = prim('Separator')
export const StatusDot = prim('StatusDot', 'span')
export const Tip = prim('Tip')
export const SearchField = prim('SearchField')
export const SegmentedControl = prim('SegmentedControl')
export const Switch = prim('Switch')
const Open = createContext(false)
export const Popover = ({ open, children }) => createElement(
  Open.Provider,
  { value: open },
  createElement('div', { 'data-open': String(open) }, children)
)
export const PopoverTrigger = ({ children }) => children
export const PopoverContent = ({ children }) => useContext(Open)
  ? createElement('div', { 'data-prim': 'PopoverContent' }, children)
  : null
export const cn = (...parts) => parts.filter(Boolean).join(' ')
export const haptic = () => {}
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const PALETTE_AREA = 'palette'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'

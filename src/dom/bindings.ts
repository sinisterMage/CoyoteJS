// Prop/attribute/event binding for real DOM elements.
//
// Rules:
//   - A prop whose value is a FUNCTION is a reactive binding: it's read inside an
//     owned effect and written on change. EXCEPTION: names starting with `on`
//     are event handlers (used as-is via addEventListener, never called
//     reactively).
//   - `class` (string or reactive), `classList` (object of booleans, each key
//     reactive), `style` (object, per-key, reactive values allowed), `ref`
//     (function called with the element / a setter), `value`/`checked` (set as
//     properties; paired with onInput/onChange to wire back), `innerHTML`, and
//     `children` are special-cased.
//   - Everything else is an attribute (or DOM property when appropriate),
//     reactive when a function.
//
// All reactive bindings run under the enclosing owner and dispose on unmount.

import { effect } from '../reactivity'

/** Property names that are set as DOM properties rather than attributes. */
const DOM_PROPS = new Set([
  'value',
  'checked',
  'selected',
  'disabled',
  'multiple',
  'muted',
  'readOnly',
  'indeterminate',
])

/** Boolean attributes toggled by presence/absence. */
function isBooleanish(v: unknown): boolean {
  return typeof v === 'boolean'
}

/** Apply a whole prop bag to an element. */
export function applyProps(el: Element, props: Record<string, unknown> | null): void {
  if (!props) return
  for (const key in props) {
    if (key === 'children') continue
    applyProp(el, key, props[key])
  }
}

function applyProp(el: Element, key: string, value: unknown): void {
  if (key === 'ref') {
    applyRef(el, value)
    return
  }
  if (key === 'class' || key === 'className') {
    bind(value, (v) => setClass(el, v))
    return
  }
  if (key === 'classList') {
    applyClassList(el, value)
    return
  }
  if (key === 'style') {
    applyStyle(el, value)
    return
  }
  if (key === 'innerHTML') {
    bind(value, (v) => {
      ;(el as HTMLElement).innerHTML = v == null ? '' : String(v)
    })
    return
  }
  if (key.startsWith('on') && key.length > 2) {
    // Event handler: value used as-is, never called reactively.
    addEventHandler(el, key, value)
    return
  }
  if (key === 'value' || key === 'checked') {
    bind(value, (v) => setDomProperty(el, key, v))
    return
  }
  // Generic attribute / DOM property.
  if (DOM_PROPS.has(key)) {
    bind(value, (v) => setDomProperty(el, key, v))
  } else {
    bind(value, (v) => setAttr(el, key, v))
  }
}

/**
 * Bind a possibly-reactive value: when it's a function, wrap the write in an
 * owned effect; otherwise write once.
 */
function bind(value: unknown, write: (v: unknown) => void): void {
  if (typeof value === 'function') {
    effect(() => write((value as () => unknown)()))
  } else {
    write(value)
  }
}

function setClass(el: Element, v: unknown): void {
  const cls = v == null || v === false ? '' : String(v)
  if (cls === '') el.removeAttribute('class')
  else el.setAttribute('class', cls)
}

function applyClassList(el: Element, value: unknown): void {
  if (typeof value === 'function') {
    // A reactive object accessor: re-evaluate the whole map.
    let prev = new Set<string>()
    effect(() => {
      const map = (value as () => Record<string, unknown>)() || {}
      const next = new Set<string>()
      for (const name in map) {
        for (const cls of splitClasses(name)) {
          if (map[name]) {
            el.classList.add(cls)
            next.add(cls)
          } else {
            el.classList.remove(cls)
          }
        }
      }
      for (const cls of prev) if (!next.has(cls)) el.classList.remove(cls)
      prev = next
    })
    return
  }
  const map = (value as Record<string, unknown>) || {}
  for (const name in map) {
    const entry = map[name]
    for (const cls of splitClasses(name)) {
      if (typeof entry === 'function') {
        effect(() => el.classList.toggle(cls, !!(entry as () => unknown)()))
      } else {
        el.classList.toggle(cls, !!entry)
      }
    }
  }
}

function splitClasses(name: string): string[] {
  return name.split(/\s+/).filter(Boolean)
}

function applyStyle(el: Element, value: unknown): void {
  const style = (el as HTMLElement).style
  if (typeof value === 'string') {
    ;(el as HTMLElement).setAttribute('style', value)
    return
  }
  if (typeof value === 'function') {
    // Reactive whole-object: apply the new object AND clear keys that were set
    // on the previous run but are absent now (else stale properties linger).
    let prev: string[] = []
    effect(() => {
      const obj = (value as () => Record<string, unknown>)() || {}
      for (const p of prev) if (!(p in obj)) setStyleProp(style, p, null)
      const next: string[] = []
      for (const prop in obj) {
        setStyleProp(style, prop, obj[prop])
        next.push(prop)
      }
      prev = next
    })
    return
  }
  const obj = (value as Record<string, unknown>) || {}
  for (const prop in obj) {
    const v = obj[prop]
    if (typeof v === 'function') {
      effect(() => setStyleProp(style, prop, (v as () => unknown)()))
    } else {
      setStyleProp(style, prop, v)
    }
  }
}

function setStyleProp(style: CSSStyleDeclaration, prop: string, v: unknown): void {
  if (v == null || v === false) {
    style.removeProperty(hyphenate(prop))
  } else if (prop.startsWith('--')) {
    style.setProperty(prop, String(v))
  } else {
    // Support both camelCase ("backgroundColor") and kebab-case ("background-color").
    ;(style as unknown as Record<string, string>)[prop] = String(v)
    // Fall back to setProperty for kebab-cased keys that the indexed set ignores.
    if (prop.includes('-')) style.setProperty(prop, String(v))
  }
}

function hyphenate(s: string): string {
  return s.includes('-') ? s : s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
}

function applyRef(el: Element, value: unknown): void {
  if (typeof value === 'function') (value as (el: Element) => void)(el)
}

function addEventHandler(el: Element, key: string, value: unknown): void {
  if (typeof value !== 'function') return
  const event = key.slice(2).toLowerCase()
  el.addEventListener(event, value as EventListener)
}

function setDomProperty(el: Element, key: string, v: unknown): void {
  ;(el as unknown as Record<string, unknown>)[key] = v
}

function setAttr(el: Element, key: string, v: unknown): void {
  if (v == null || v === false) {
    el.removeAttribute(key)
  } else if (v === true) {
    el.setAttribute(key, '')
  } else if (isBooleanish(v)) {
    el.setAttribute(key, String(v))
  } else {
    el.setAttribute(key, String(v))
  }
}

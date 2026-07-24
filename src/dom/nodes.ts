// Low-level DOM node machinery: resolve a CoyoteNode value into real DOM,
// append/insert children, and reconcile a single reactive slot in place with a
// pair of comment anchors. No virtual DOM — everything here manipulates real
// `Node`s.
//
// A FUNCTION value is always a reactive slot with its OWN owned effect — never
// resolved inline inside a parent effect. This keeps reactive scopes separate:
// a nested accessor (e.g. a control-flow component returned at the top level, or
// a function nested inside an array child) reacts independently and does not
// re-run — or reconstruct — the parent slot.

import { effect } from '../reactivity'
import type { CoyoteNode } from './types'

/** True for values that render nothing (`null`/`undefined`/`true`/`false`). */
function isEmpty(v: unknown): v is null | undefined | boolean {
  return v == null || v === true || v === false
}

/**
 * Turn a NON-reactive `CoyoteNode` into a flat array of concrete DOM nodes.
 * Functions are NOT called here — a function is a reactive slot handled by
 * `insert`. Callers pass values that are already static (or arrays of static
 * values); a function encountered inside an array is materialized once as a
 * fallback, but the reactive path always routes functions through `insert`.
 */
export function resolveNode(value: CoyoteNode): Node[] {
  const out: Node[] = []
  appendResolved(out, value)
  return out
}

function appendResolved(out: Node[], value: CoyoteNode): void {
  if (isEmpty(value)) return
  if (typeof value === 'string' || typeof value === 'number') {
    out.push(document.createTextNode(String(value)))
    return
  }
  if (value instanceof Node) {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) appendResolved(out, child)
    return
  }
  if (typeof value === 'function') {
    // Static-resolution fallback: materialize once. The reactive path routes
    // functions through `insert` (own effect) and never reaches here.
    appendResolved(out, (value as () => CoyoteNode)())
    return
  }
  // Fallback: stringify anything else (e.g. a stray object).
  out.push(document.createTextNode(String(value)))
}

/**
 * Materialize `value` into a flat run of DOM nodes with reactive slots wired up
 * (functions become live `insert` slots owned by the current owner). Use this
 * instead of `resolveNode` whenever the value may contain nested accessors that
 * must stay reactive — e.g. control-flow branches/rows and context/boundary
 * children. Runs the build into a fragment so slot anchors travel with the
 * returned nodes when the caller inserts them.
 */
export function materialize(value: CoyoteNode): Node[] {
  if (!hasReactive(value)) return resolveNode(value)
  const frag = document.createDocumentFragment()
  appendChild(frag, value)
  return Array.from(frag.childNodes)
}

/** Does `value` contain any function anywhere it would be rendered? */
function hasReactive(value: CoyoteNode): boolean {
  if (typeof value === 'function') return true
  if (Array.isArray(value)) {
    for (const child of value) if (hasReactive(child)) return true
  }
  return false
}

/**
 * Insert `value` into `parent` before `marker`, giving each nested FUNCTION its
 * own reactive slot (own effect). Static values are inserted once. Arrays keep
 * their order: statics go in directly, functions get a bracketed live slot at
 * their position.
 */
export function appendChild(parent: Node, value: CoyoteNode, marker: Node | null = null): void {
  if (typeof value === 'function') {
    insert(parent, value as () => CoyoteNode, marker)
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) appendChild(parent, child, marker)
    return
  }
  const nodes = resolveNode(value)
  for (const n of nodes) parent.insertBefore(n, marker)
}

/**
 * Reactively insert `value` into `parent`. A function becomes a live slot: an
 * owned effect re-reads it on change and swaps the produced nodes in place,
 * bracketed by two comment anchors so the slot's extent is known even when it
 * renders nothing. If the accessor's RESULT itself contains functions (a nested
 * accessor, or an array of them), each gets its own child slot — the parent slot
 * only re-runs when the accessor's own tracked reads change. Non-function values
 * are inserted once. `marker` positions the slot before an existing node.
 */
export function insert(parent: Node, value: CoyoteNode, marker: Node | null = null): void {
  if (typeof value !== 'function') {
    appendChild(parent, value, marker)
    return
  }

  const accessor = value as () => CoyoteNode
  const start = document.createComment('')
  const end = document.createComment('')
  parent.insertBefore(start, marker)
  parent.insertBefore(end, marker)

  // Owned by the enclosing owner → disposes on unmount. Nested reactive children
  // get their own effects (owned by THIS effect); a re-run disposes them and we
  // clear all DOM between the anchors before re-inserting.
  effect(() => {
    const result = accessor()

    // Resolve the LIVE parent from the anchors each run: the slot may have been
    // built in a document fragment (via `materialize`) and later relocated into
    // the real DOM, so the `parent` captured at creation is stale.
    const liveParent = end.parentNode ?? parent

    // Clear everything currently between the anchors (static nodes AND any DOM
    // produced by the previous run's nested slots, whose effects were just
    // disposed by the reactivity core before this re-run).
    let node = start.nextSibling
    while (node && node !== end) {
      const nextNode = node.nextSibling
      liveParent.removeChild(node)
      node = nextNode
    }

    if (hasReactive(result)) {
      // Route nested functions through their own slots at their position.
      appendChild(liveParent, result, end)
    } else {
      const next = resolveNode(result)
      for (const n of next) liveParent.insertBefore(n, end)
    }
  })
}

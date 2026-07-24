// Control-flow components. Each returns a reactive ACCESSOR (a `CoyoteNodeFn`,
// which is a valid `CoyoteNode`); the enclosing `insert`/`appendChild` slot runs
// it inside an owned effect and swaps the produced nodes in place on change.
//
// Rows/branches each run under their OWN child scope (createScopeIn, parented at
// a STABLE owner captured at call time) so their cleanups fire exactly when that
// row/branch is removed — not when the enclosing slot effect re-runs, and not
// when a sibling changes. Reused rows keep their DOM nodes and scope across
// updates.

import { getOwner, onCleanup, signal, untrack } from '../reactivity'
import type { Accessor, Owner } from '../reactivity'
import type { Component, CoyoteNode } from './types'
import { h } from './h'
import { materialize } from './nodes'
import { createScopeIn } from './scope'

/** Read an `each` source that may be a plain array or an accessor. */
function readEach<T>(each: Accessor<readonly T[]> | readonly T[]): readonly T[] {
  return typeof each === 'function' ? (each as Accessor<readonly T[]>)() : each
}

/** A mounted control-flow branch: its DOM nodes plus a scope disposer. */
interface Branch {
  nodes: Node[]
  dispose: () => void
}

/**
 * Mount `make()` under a fresh child scope parented at the STABLE `owner`
 * captured at control-flow-call time (so a slot-effect re-run doesn't dispose
 * it). Returns the branch (nodes + disposer).
 *
 * IMPORTANT (re-entrancy): materializing the body creates the body's nested
 * reactive slots, each with its OWN effect that flushes SYNCHRONOUSLY at
 * creation. If a nested slot reads the same live source that drives this
 * control-flow's `when`/`each`, that flush can re-enter the enclosing
 * control-flow effect *before this function returns*. So the branch object is
 * created and published to the caller (via `assign`, run BEFORE materialize)
 * with an empty-but-stable `nodes` array; `materialize` fills that same array in
 * place. A re-entrant control-flow run therefore sees a non-null branch whose
 * `nodes` array is the very one being populated — never a null deref, and the
 * array it reads is the one that ends up in the DOM.
 */
function mountScopedIn(
  owner: Owner | null,
  make: () => CoyoteNode,
  assign: (branch: Branch) => void,
): Branch {
  const branch: Branch = { nodes: [], dispose: () => {} }
  createScopeIn(owner, (d) => {
    branch.dispose = d
    // Publish the branch BEFORE materialize so a re-entrant control-flow run
    // (triggered synchronously while the body's nested slots flush) observes a
    // fully-formed branch object rather than a transient null.
    assign(branch)
    const nodes = materialize(untrack(make))
    // Fill the SAME array the caller already holds a reference to.
    branch.nodes.push(...nodes)
    return d
  })
  return branch
}

/**
 * For — keyed by referential identity. Reuses the DOM + scope of unchanged
 * items; creates rows for new items, disposes rows for removed items, and
 * reorders by re-emitting in the new order.
 */
export function For<T>(props: {
  each: Accessor<readonly T[]> | readonly T[]
  fallback?: CoyoteNode
  children: (item: T, index: Accessor<number>) => CoyoteNode
}): CoyoteNode {
  interface Row {
    item: T
    nodes: Node[]
    dispose: () => void
    setIndex: (n: number) => void
  }
  let rows: Row[] = []
  const byItem = new Map<T, Row>()
  const owner = getOwner() // stable parent captured at call time

  const makeRow = (item: T, index: number): Row => {
    let setIndex!: (n: number) => void
    let nodes: Node[] = []
    const dispose = createScopeIn(owner, (disposeRow) => {
      const [idx, setIdx] = signal(index)
      setIndex = setIdx
      nodes = materialize(props.children(item, idx))
      return disposeRow
    })
    return { item, nodes, dispose, setIndex }
  }

  return () => {
    const list = readEach(props.each)
    if (list.length === 0) {
      for (const r of rows) r.dispose()
      rows = []
      byItem.clear()
      return props.fallback ?? null
    }

    const nextRows: Row[] = []
    const seen = new Set<T>()
    const out: Node[] = []

    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      let row = byItem.get(item)
      if (row && !seen.has(item)) {
        untrack(() => row!.setIndex(i)) // reused row may have moved
      } else {
        row = makeRow(item, i)
        byItem.set(item, row)
      }
      seen.add(item)
      nextRows.push(row)
      for (const n of row.nodes) out.push(n)
    }

    for (const r of rows) {
      if (!seen.has(r.item)) {
        r.dispose()
        byItem.delete(r.item)
      }
    }
    rows = nextRows
    return out as unknown as CoyoteNode
  }
}

/**
 * Index — keyed by position. The item is an `Accessor<T>`; when the value at a
 * position changes the same row is reused and its accessor updates. Rows are
 * created/removed only as the LENGTH changes.
 */
export function Index<T>(props: {
  each: Accessor<readonly T[]> | readonly T[]
  fallback?: CoyoteNode
  children: (item: Accessor<T>, index: number) => CoyoteNode
}): CoyoteNode {
  interface Row {
    setValue: (v: T) => void
    nodes: Node[]
    dispose: () => void
  }
  let rows: Row[] = []
  const owner = getOwner() // stable parent captured at call time

  const makeRow = (value: T, index: number): Row => {
    let setValue!: (v: T) => void
    let nodes: Node[] = []
    const dispose = createScopeIn(owner, (disposeRow) => {
      const [get, set] = signal(value)
      setValue = set
      nodes = materialize(props.children(get, index))
      return disposeRow
    })
    return { setValue, nodes, dispose }
  }

  return () => {
    const list = readEach(props.each)
    if (list.length === 0) {
      for (const r of rows) r.dispose()
      rows = []
      return props.fallback ?? null
    }

    const out: Node[] = []
    for (let i = 0; i < list.length; i++) {
      if (i < rows.length) {
        untrack(() => rows[i].setValue(list[i]))
      } else {
        rows[i] = makeRow(list[i], i)
      }
      for (const n of rows[i].nodes) out.push(n)
    }
    for (let i = list.length; i < rows.length; i++) rows[i].dispose()
    rows.length = list.length
    return out as unknown as CoyoteNode
  }
}

/**
 * Show — mount children on truthiness, unmount (disposing their scope) on
 * falsiness. `keyed` passes the truthy value to a children FUNCTION and re-mounts
 * when the keyed value changes.
 */
export function Show<T>(props: {
  when: Accessor<T | undefined | null | false> | T
  fallback?: CoyoteNode
  keyed?: boolean
  children: CoyoteNode | ((item: T) => CoyoteNode)
}): CoyoteNode {
  let branch: Branch | null = null
  let showing: 'when' | 'fallback' | null = null
  let keyedValue: T | undefined
  // Re-entrancy guard: `mountScopedIn` materializes the body, which flushes the
  // body's nested slots synchronously; if such a slot reads the same source that
  // drives `when`, that flush re-enters this effect while a mount is in flight.
  // A re-entrant run must NOT teardown/re-mount (that would dispose the scope
  // being built and re-run this executing effect node); it just returns the
  // in-progress branch's stable `nodes` array. The outer flush re-runs this
  // effect afterward if the source truly settled to a new value.
  let building = false
  const owner = getOwner()

  const readWhen = (): T | undefined | null | false =>
    typeof props.when === 'function'
      ? (props.when as Accessor<T | undefined | null | false>)()
      : props.when

  const teardown = () => {
    if (branch) {
      branch.dispose()
      branch = null
    }
  }

  const currentNodes = (): CoyoteNode =>
    (branch ? (branch.nodes as unknown as CoyoteNode) : null) ?? null

  // Mount a new branch under the re-entrancy guard: publish it eagerly (so a
  // re-entrant run sees a non-null branch) and hold `building` across the whole
  // materialize so the re-entrant run coalesces instead of re-mounting.
  const mountBranch = (make: () => CoyoteNode) => {
    building = true
    try {
      branch = mountScopedIn(owner, make, (b) => (branch = b))
    } finally {
      building = false
    }
  }

  return () => {
    // Read `when` unconditionally so this effect stays subscribed to its source
    // even on a re-entrant run (below). The reactivity core's `reexecute` unlinks
    // all sources before running the fn; a re-entrant reexecute nested inside the
    // outer one would otherwise leave this effect subscribed to nothing.
    const value = readWhen()

    // Coalesce a re-entrant run (a nested body slot flushed synchronously and
    // re-entered this effect mid-mount): do NOT teardown/re-mount — that would
    // dispose the scope being built. Return the in-flight branch's stable nodes;
    // the outer run finishes the mount and the flush loop settles the rest.
    if (building) return currentNodes()

    if (value) {
      if (showing !== 'when' || (props.keyed && !Object.is(keyedValue, value))) {
        teardown()
        keyedValue = value as T
        showing = 'when'
        mountBranch(() =>
          typeof props.children === 'function'
            ? (props.children as (item: T) => CoyoteNode)(value as T)
            : props.children,
        )
      }
      return branch!.nodes as unknown as CoyoteNode
    }

    if (showing !== 'fallback') {
      teardown()
      showing = 'fallback'
      keyedValue = undefined
      if (props.fallback == null) branch = null
      else mountBranch(() => props.fallback as CoyoteNode)
    }
    return currentNodes()
  }
}

interface MatchProps<T> {
  when: Accessor<T | undefined | null | false> | T
  children: CoyoteNode | ((item: T) => CoyoteNode)
}

const MATCH = Symbol('coyote-match')

/** Match — a branch of Switch. Carries its props for Switch to consume. */
export function Match<T>(props: MatchProps<T>): CoyoteNode {
  return { [MATCH]: props } as unknown as CoyoteNode
}

function asMatch<T>(v: unknown): MatchProps<T> | null {
  return typeof v === 'object' && v !== null && MATCH in v
    ? ((v as Record<symbol, MatchProps<T>>)[MATCH] as MatchProps<T>)
    : null
}

/** Switch — render the first Match child whose `when` is truthy, else fallback. */
export function Switch(props: { fallback?: CoyoteNode; children: CoyoteNode }): CoyoteNode {
  const kids = Array.isArray(props.children) ? props.children : [props.children]

  let branch: Branch | null = null
  let activeIndex = -2 // -2 = nothing yet, -1 = fallback
  // Re-entrancy guard — see Show for the full rationale: materializing the
  // active branch can synchronously re-enter this effect via a nested slot that
  // reads a `when` source; a re-entrant run coalesces to the in-flight nodes.
  let building = false
  const owner = getOwner()

  const teardown = () => {
    if (branch) {
      branch.dispose()
      branch = null
    }
  }

  const currentNodes = (): CoyoteNode =>
    (branch ? (branch.nodes as unknown as CoyoteNode) : null) ?? null

  // See Show: mount under the re-entrancy guard, publishing the branch eagerly.
  const mountBranch = (make: () => CoyoteNode) => {
    building = true
    try {
      branch = mountScopedIn(owner, make, (b) => (branch = b))
    } finally {
      building = false
    }
  }

  const readWhen = <T>(m: MatchProps<T>): T | undefined | null | false =>
    typeof m.when === 'function'
      ? (m.when as Accessor<T | undefined | null | false>)()
      : m.when

  return () => {
    // Scan matches (subscribing to each `when` up to the active one) BEFORE the
    // re-entrancy guard, so a re-entrant reexecute — which the core runs after
    // unlinking all sources — keeps this effect subscribed to those sources.
    let matchIndex = -1
    let matchProps: MatchProps<unknown> | null = null
    let matchValue: unknown
    for (let i = 0; i < kids.length; i++) {
      const m = asMatch(kids[i])
      if (!m) continue
      const value = readWhen(m)
      if (value) {
        matchIndex = i
        matchProps = m
        matchValue = value
        break
      }
    }

    // Coalesce a re-entrant run: return the in-flight branch's stable nodes
    // without tearing down / re-mounting the scope currently being built.
    if (building) return currentNodes()

    if (matchIndex === activeIndex && branch) {
      return branch.nodes as unknown as CoyoteNode
    }

    teardown()
    activeIndex = matchIndex

    if (matchIndex === -1) {
      if (props.fallback == null) branch = null
      else mountBranch(() => props.fallback as CoyoteNode)
    } else {
      const mp = matchProps!
      mountBranch(() =>
        typeof mp.children === 'function'
          ? (mp.children as (item: unknown) => CoyoteNode)(matchValue)
          : mp.children,
      )
    }
    return currentNodes()
  }
}

/**
 * Dynamic — render `component`, a tag string or a Component, with the remaining
 * props. Swapping is driven by the enclosing slot (re-invoking Dynamic with a
 * new `component`); each invocation renders under its own child scope.
 */
export function Dynamic<P extends Record<string, any>>(
  props: { component: Component<P> | string } & P,
): CoyoteNode {
  const { component, ...rest } = props as { component: Component<P> | string } & Record<
    string,
    unknown
  >
  if (typeof component === 'string') {
    return h(component, rest as Record<string, any>)
  }
  return (component as Component<P>)(rest as P)
}

/**
 * Portal — render children into `mount ?? document.body`, detached from the
 * component's position, cleaned up on unmount.
 */
export function Portal(props: { mount?: Element; children: CoyoteNode }): CoyoteNode {
  const target = props.mount ?? document.body
  const nodes = materialize(props.children)
  for (const n of nodes) target.appendChild(n)
  onCleanup(() => {
    for (const n of nodes) if (n.parentNode === target) target.removeChild(n)
  })
  return null // contributes nothing at its original position
}

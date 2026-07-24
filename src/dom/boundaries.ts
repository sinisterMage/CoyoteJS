// Error/async boundaries.
//
// ErrorBoundary catches SYNCHRONOUS render/effect errors from its subtree
// (children run under a child scope inside a try/catch; effects run
// synchronously at creation, so their initial-run throws surface here) and shows
// `fallback`, passing a `reset` that re-attempts the children.
//
// Suspense shows `fallback` until async resources inside settle. Coordination is
// a minimal counter carried on a context: pending async reads increment on start
// and decrement on settle; the router's createResource integrates with it later.

import { getOwner, signal, untrack } from '../reactivity'
import type { Accessor } from '../reactivity'
import type { CoyoteNode } from './types'
import { createContext, useContext } from './context'
import { materialize } from './nodes'
import { createChildScope, createScopeIn } from './scope'

/** Suspense coordination surface, read by async resources via useContext. */
export interface SuspenseContextValue {
  increment: () => void
  decrement: () => void
  count: Accessor<number>
}

export const SuspenseContext = createContext<SuspenseContextValue | null>(null)

/** Access the nearest Suspense boundary, if any (used by createResource). */
export function useSuspense(): SuspenseContextValue | null {
  return useContext(SuspenseContext)
}

export function ErrorBoundary(props: {
  fallback: CoyoteNode | ((err: unknown, reset: () => void) => CoyoteNode)
  children: CoyoteNode
}): CoyoteNode {
  // `attempt` re-runs the accessor on reset; `error` (undefined = healthy) drives
  // which branch shows. A stable owner (captured at call time) parents both
  // branch scopes so a slot-effect re-run doesn't dispose them.
  const [error, setError] = signal<unknown>(undefined)
  const [attempt, setAttempt] = signal(0)
  const owner = getOwner()

  const reset = () => {
    setError(undefined)
    setAttempt((n) => n + 1)
  }

  let branch: { dispose: () => void; nodes: Node[] } | null = null
  const teardown = () => {
    if (branch) {
      branch.dispose()
      branch = null
    }
  }

  const mountFallback = (err: unknown) => {
    let nodes: Node[] = []
    const dispose = createScopeIn(owner, (d) => {
      const fb =
        typeof props.fallback === 'function'
          ? (props.fallback as (e: unknown, r: () => void) => CoyoteNode)(err, reset)
          : props.fallback
      nodes = materialize(fb)
      return d
    })
    branch = { dispose, nodes }
    return nodes
  }

  return () => {
    attempt() // re-run on reset
    const err = error()
    teardown()

    if (err !== undefined) {
      return mountFallback(err) as unknown as CoyoteNode
    }

    // Try to render children; a synchronous throw switches to the fallback.
    try {
      let nodes: Node[] = []
      const dispose = createScopeIn(owner, (d) => {
        nodes = materialize(props.children)
        return d
      })
      branch = { dispose, nodes }
      return nodes as unknown as CoyoteNode
    } catch (e) {
      teardown()
      // Record the error (so a later reset() → attempt() path is consistent) and
      // show the fallback for this run. Setting the signal is untracked so it
      // doesn't feed back into this same accessor's dependency set mid-run.
      untrack(() => setError(e))
      return mountFallback(e) as unknown as CoyoteNode
    }
  }
}

export function Suspense(props: { fallback?: CoyoteNode; children: CoyoteNode }): CoyoteNode {
  const [count, setCount] = signal(0)
  const value: SuspenseContextValue = {
    increment: () => setCount((n) => n + 1),
    decrement: () => setCount((n) => Math.max(0, n - 1)),
    count,
  }

  // Render the children ONCE under the Suspense context; nested async resources
  // register their pending state on `value` at build time. The children are kept
  // ALIVE (their reactive scope never disposed) for the whole life of the
  // boundary, so their nested slots keep re-rendering as resources settle.
  //
  // While pending we must HIDE the children (a synchronous child must not paint
  // before the boundary resolves) WITHOUT orphaning those nested slots. A naive
  // toggle that let the enclosing `insert` slot remove the children from the DOM
  // was the router lazy-route regression: once detached, a child slot's comment
  // anchors had no live parent, so when its resource settled it re-inserted into
  // a stale detached parent and the content was lost forever.
  //
  // So we bracket the children with our OWN pair of comment anchors and, while
  // pending, park that whole range (anchors + everything the nested slots have
  // produced between them) in a persistent off-document holder. A resource that
  // settles mid-suspend still renders correctly because its slot's live parent
  // (the holder) never goes away; on resolve the range moves back into the live
  // tree with its fully-built content intact. No wrapper element is introduced,
  // so the children stay direct siblings of the boundary — structural CSS
  // selectors (`> *`, `:nth-child`) and the surrounding layout are unaffected.
  const childStart = document.createComment('suspense')
  const childEnd = document.createComment('/suspense')
  // An off-document parking spot for the child range while the fallback shows. It
  // starts as the range's parent so a resource that settles BEFORE first paint
  // still has a live parent to render into.
  const holder = document.createDocumentFragment()
  holder.appendChild(childStart)
  holder.appendChild(childEnd)

  createChildScope((d) => {
    const nodes = materialize(SuspenseContext.Provider({ value, children: props.children }))
    for (const n of nodes) holder.insertBefore(n, childEnd)
    return d
  })

  // Collect the current child range (childStart..childEnd inclusive, plus any
  // content the nested slots produced between them) as a live node list. We walk
  // the actual DOM siblings rather than a captured array, because async content
  // inserted after the first render sits between the original nodes in the DOM.
  const collectRange = (): Node[] => {
    const out: Node[] = []
    for (let n: Node | null = childStart; n; n = n.nextSibling) {
      out.push(n)
      if (n === childEnd) break
    }
    return out
  }

  // A single reactive slot. On each run the enclosing `insert` first clears its
  // own range, so we re-emit the CURRENT nodes: the fallback while pending, or the
  // parked child range once resolved. Handing the child nodes to the slot inserts
  // each into the live tree (an implicit DOM move out of the holder).
  return () => {
    if (value.count() > 0) {
      // Park the child range off-document so its nested slots keep a live parent
      // (the holder) while the fallback shows, then hand the fallback to the slot.
      const range = collectRange()
      for (const n of range) holder.appendChild(n)
      return (props.fallback ?? null) as CoyoteNode
    }
    return collectRange() as unknown as CoyoteNode
  }
}

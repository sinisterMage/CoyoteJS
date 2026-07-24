// Shared reactive node graph for coyote's fine-grained reactivity core.
//
// One `Node` structure backs all three node kinds:
//   - signal   : a source (`fn === null`), holds a value written imperatively.
//   - computed : a derived observer (`fn` set, `isEffect` false), lazily pulled.
//   - effect   : a side-effecting observer (`fn` set, `isEffect` true), pushed
//                onto the effect queue and run by the scheduler.
//
// The algorithm is push-based dependency tracking with pull-on-read and a
// microtask-batched effect flush (SolidJS family, hand-rolled, zero deps).

/** Node dirtiness state. */
export const CLEAN = 0
export const CHECK = 1 // "maybe dirty": a transitive source may have changed.
export const STALE = 2 // definitely dirty: must re-execute before its value is trusted.

export type NodeState = typeof CLEAN | typeof CHECK | typeof STALE

/** Disposal scope. Owns computeds/effects and cleanup callbacks. */
export interface OwnerNode {
  readonly __coyote: 'owner'
  /** Computed/effect nodes created while this owner was current. */
  owned: Node<unknown>[]
  /** Cleanup callbacks registered via onCleanup (run LIFO on dispose/re-run). */
  cleanups: (() => void)[]
  parent: OwnerNode | null
}

export interface Node<T> {
  value: T | undefined
  /** Observers that depend on this node (computeds/effects). */
  observers: Set<Node<unknown>>
  /** Sources this node currently reads from (in first-read order). */
  sources: Node<unknown>[]
  /**
   * For each entry in `sources`, the index of THIS node inside that source's
   * observer bookkeeping arrays (`observerNodes`/`observerSlots`) — enables an
   * O(1) swap-remove when unlinking on re-execution.
   */
  sourceSlots: number[]
  /**
   * Back-references paralleling `observers` for O(1) unlink: `observerNodes[i]`
   * is an observer node and `observerSlots[i]` is the index of THIS node inside
   * that observer's `sources`. Kept in sync with the `observers` Set.
   */
  observerNodes: Node<unknown>[]
  observerSlots: number[]
  state: NodeState
  /** Derivation fn for computed/effect; null for a plain signal source. */
  fn: ((prev: T | undefined) => T) | null
  /** Owner scope this node runs under (its own scope for computed/effect). */
  owner: OwnerNode | null
  /** Change test. Signals/computeds compare old vs next through this. */
  equals: (a: T, b: T) => boolean
  /** True for effects: the scheduler drives these; computeds are pulled lazily. */
  isEffect: boolean
  /** Whether this effect is currently in the effect queue (O(1) enqueue dedup). */
  queued: boolean
  /** Optional debug name (from options). */
  name?: string
}

// ---------------------------------------------------------------------------
// Reactive-system globals
// ---------------------------------------------------------------------------

/** The node currently executing, for dependency capture on reads. */
export let currentObserver: Node<unknown> | null = null
/** The owner scope currently in effect, for ownership registration. */
export let currentOwner: OwnerNode | null = null
/** batch() nesting depth; effects flush when this returns to 0. */
export let batchDepth = 0
/** Effects awaiting execution (deduped by membership checks at enqueue time). */
export const effectQueue: Node<unknown>[] = []
/** Whether a microtask flush is already scheduled. */
export let flushScheduled = false

/** Upper bound on flush iterations before we declare a reactive cycle. */
const MAX_FLUSH_ITERATIONS = 1e5

export function setCurrentObserver(n: Node<unknown> | null): Node<unknown> | null {
  const prev = currentObserver
  currentObserver = n
  return prev
}

export function setCurrentOwner(o: OwnerNode | null): OwnerNode | null {
  const prev = currentOwner
  currentOwner = o
  return prev
}

/** Enter a batch (increment nesting depth). */
export function enterBatch(): void {
  batchDepth++
}

/** Leave a batch; returns true when the outermost batch just closed. */
export function exitBatch(): boolean {
  batchDepth--
  return batchDepth === 0
}

/** Clear the scheduled-microtask flag (used by flushSync). */
export function clearScheduled(): void {
  flushScheduled = false
}

// ---------------------------------------------------------------------------
// Node construction
// ---------------------------------------------------------------------------

export const defaultEquals = <T>(a: T, b: T): boolean => Object.is(a, b)

export function createNode<T>(
  value: T | undefined,
  fn: ((prev: T | undefined) => T) | null,
  equals: (a: T, b: T) => boolean,
  isEffect: boolean,
  owner: OwnerNode | null,
  name?: string,
): Node<T> {
  return {
    value,
    observers: new Set(),
    sources: [],
    sourceSlots: [],
    observerNodes: [],
    observerSlots: [],
    state: CLEAN,
    fn,
    owner,
    equals,
    isEffect,
    queued: false,
    name,
  }
}

// ---------------------------------------------------------------------------
// Dependency edges
// ---------------------------------------------------------------------------

/**
 * Record a deduped bidirectional edge source→observer while `observer` runs.
 * Dedup keys off the source's `observers` Set (O(1)).
 */
export function track(source: Node<unknown>, observer: Node<unknown>): void {
  if (source.observers.has(observer)) return
  const sourceSlot = source.observerNodes.length
  const observerSlot = observer.sources.length

  source.observers.add(observer)
  source.observerNodes.push(observer)
  source.observerSlots.push(observerSlot)

  observer.sources.push(source)
  observer.sourceSlots.push(sourceSlot)
}

/**
 * Unlink every source of `node` (O(1) swap-remove out of each source's
 * observer bookkeeping) and clear the node's own source arrays. Called before a
 * re-execution and on disposal so stale deps never fire.
 */
export function unlinkSources(node: Node<unknown>): void {
  const { sources, sourceSlots } = node
  for (let i = sources.length - 1; i >= 0; i--) {
    const source = sources[i]
    const slot = sourceSlots[i]
    const obsNodes = source.observerNodes
    const obsSlots = source.observerSlots
    const last = obsNodes.length - 1

    if (slot !== last) {
      // Move the last observer entry into the vacated slot and fix up its
      // back-pointer (the moved observer's sourceSlots must point at `slot`).
      const movedObserver = obsNodes[last]
      const movedSlot = obsSlots[last]
      obsNodes[slot] = movedObserver
      obsSlots[slot] = movedSlot
      movedObserver.sourceSlots[movedSlot] = slot
    }
    obsNodes.pop()
    obsSlots.pop()
    source.observers.delete(node)
  }
  sources.length = 0
  sourceSlots.length = 0
}

// ---------------------------------------------------------------------------
// Propagation, pull, and re-execution
// ---------------------------------------------------------------------------

/**
 * Two-tier "mark dirty" propagation from a changed node. Direct observers go
 * STALE; their transitive observers go CHECK ("maybe dirty"), stopping at nodes
 * already at/above the level being set so the walk stays near-linear. No user
 * function runs here — this only marks and enqueues effects.
 */
export function markObservers(node: Node<unknown>, mark: NodeState): void {
  for (const observer of node.observers) {
    // Only escalate: never downgrade a node's dirtiness.
    if (observer.state >= mark) continue
    const wasClean = observer.state === CLEAN
    observer.state = mark
    if (observer.isEffect) {
      // Effects are driven by the scheduler; enqueue whenever they get dirtied.
      enqueueEffect(observer)
    } else if (wasClean) {
      // A computed leaving CLEAN for the first time marks its whole downstream
      // "maybe dirty" exactly once. If it was already CHECK its downstream is
      // already CHECK, so a later CLEAN→CHECK/STALE upgrade needs no re-walk —
      // this is what keeps propagation near-linear (avoids the O(n^2) re-walk).
      markObservers(observer, CHECK)
    }
  }
}

/** Enqueue an effect for the scheduler if not already queued (O(1) via flag). */
export function enqueueEffect(node: Node<unknown>): void {
  if (node.queued) return
  node.queued = true
  effectQueue.push(node)
}

/**
 * Ensure `node.value` is current before a read.
 *   CLEAN → nothing to do.
 *   CHECK → walk sources in order, pulling each; if any re-execution marked us
 *           STALE, re-execute. If still only CHECK afterwards, settle to CLEAN.
 *   STALE → re-execute.
 */
export function updateIfNecessary(node: Node<unknown>): void {
  if (node.state === CLEAN) return

  if (node.state === CHECK) {
    // A source (or transitive source) may have changed. Pull sources in order;
    // if one re-executes and its value changes it marks us STALE mid-loop.
    const sources = node.sources
    for (let i = 0; i < sources.length; i++) {
      updateIfNecessary(sources[i])
      // `node.state` is read fresh each iteration on purpose.
      if ((node.state as NodeState) === STALE) break
    }
  }

  if (node.state === STALE) {
    reexecute(node)
  } else {
    node.state = CLEAN
  }
}

/**
 * Re-run a computed/effect: LIFO cleanups, unlink sources, install as current
 * observer + owner, run `fn(prev)` capturing new deps, and for a computed
 * propagate STALE to its observers when the value actually changed.
 */
export function reexecute(node: Node<unknown>): void {
  // A disposed node is inert: never re-run it (its fn was nulled on dispose).
  if (node.fn === null) {
    node.state = CLEAN
    return
  }
  const owner = node.owner
  if (owner) runCleanups(owner)

  // Disposing owned children (created inside this derivation on the previous
  // run) before re-running, so nested reactions don't leak across executions.
  if (owner && owner.owned.length) disposeOwned(owner)

  unlinkSources(node)

  const prevObserver = setCurrentObserver(node)
  const prevOwner = setCurrentOwner(owner)
  let nextValue: unknown
  try {
    nextValue = node.fn!(node.value)
  } finally {
    setCurrentObserver(prevObserver)
    setCurrentOwner(prevOwner)
  }

  node.state = CLEAN

  if (!node.isEffect) {
    const changed = !node.equals(node.value as never, nextValue as never)
    node.value = nextValue
    if (changed) markObservers(node, STALE)
  } else {
    node.value = nextValue
  }
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Schedule a microtask flush once (no-op inside a batch or when already set). */
export function scheduleFlush(): void {
  if (flushScheduled || batchDepth > 0) return
  flushScheduled = true
  queueMicrotask(runScheduledFlush)
}

function runScheduledFlush(): void {
  flushScheduled = false
  flushEffects()
}

/**
 * Drain the effect queue, running STALE (or CHECK-that-settles-STALE) effects
 * through updateIfNecessary. Bounded to catch cycles (an effect that writes a
 * signal it reads re-enqueues itself forever otherwise).
 */
export function flushEffects(): void {
  if (batchDepth > 0) return
  let iterations = 0
  while (effectQueue.length) {
    if (++iterations > MAX_FLUSH_ITERATIONS) {
      for (const e of effectQueue) e.queued = false
      effectQueue.length = 0
      throw new Error(
        'coyote: reactive update did not settle after ' +
          MAX_FLUSH_ITERATIONS +
          ' iterations — likely a cyclic effect (an effect writing a signal it reads).',
      )
    }
    const effect = effectQueue.shift()!
    effect.queued = false
    // The effect may have been disposed (owner torn down) since enqueue: a
    // disposed effect has fn === null.
    if (effect.fn === null) continue
    updateIfNecessary(effect)
  }
}

// ---------------------------------------------------------------------------
// Ownership / disposal
// ---------------------------------------------------------------------------

export function createOwner(parent: OwnerNode | null): OwnerNode {
  return { __coyote: 'owner', owned: [], cleanups: [], parent }
}

/** Run an owner's cleanup callbacks LIFO, then clear them. */
export function runCleanups(owner: OwnerNode): void {
  const { cleanups } = owner
  for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]()
  cleanups.length = 0
}

/** Recursively dispose an owner's owned nodes (children first), unlinking deps. */
function disposeOwned(owner: OwnerNode): void {
  const { owned } = owner
  for (let i = owned.length - 1; i >= 0; i--) {
    disposeNode(owned[i])
  }
  owned.length = 0
}

/** Tear down a single computed/effect node: cleanups, children, deps, mark dead. */
export function disposeNode(node: Node<unknown>): void {
  const owner = node.owner
  if (owner) {
    runCleanups(owner)
    disposeOwned(owner)
  }
  // Unlink from our own sources (remove us from their observer bookkeeping).
  unlinkSources(node)
  node.state = CLEAN
  node.queued = false
  // A null fn marks the node DEAD: reexecute() and the computed accessor treat a
  // dead node as inert, and a queued flush skips it. We intentionally DO NOT
  // clear this node's own `observers`/`observerNodes` here: an observer that
  // still lists us as a source keeps a positional `sourceSlots` index into those
  // arrays and would corrupt on its next unlink if we truncated them. In a
  // well-formed owner tree observers are disposed alongside/before their sources,
  // so leaving these intact just lets any stray observer unlink cleanly later.
  node.fn = null
}

/**
 * Dispose an owner scope: run its cleanups LIFO, then recursively dispose its
 * owned nodes. Used by createRoot's dispose handle.
 */
export function disposeOwner(owner: OwnerNode): void {
  runCleanups(owner)
  disposeOwned(owner)
}

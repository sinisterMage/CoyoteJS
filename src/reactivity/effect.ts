import type { EffectOptions } from './types'
import {
  batchDepth,
  createNode,
  createOwner,
  currentOwner,
  enqueueEffect,
  flushEffects,
  scheduleFlush,
  STALE,
  type Node,
} from './core'

/**
 * Create a side-effecting reaction.
 *
 * By default the effect runs immediately once (capturing its dependencies), then
 * re-runs whenever a tracked source changes. With `defer: true` the first run is
 * skipped: the effect is subscribed on its next run, reacting only to subsequent
 * changes. `fn(prev)` receives the previous return value.
 *
 * A synchronous initial run happens right away (outside a batch); inside a batch
 * it runs when the batch closes. Change-driven re-runs are microtask-batched via
 * the scheduler (or flushed synchronously with `flushSync`).
 */
export function effect<T>(fn: (prev: T | undefined) => T, seed?: T, opts?: EffectOptions): void {
  // Effect owns a scope (onCleanup + nested reactions) parented at the creating
  // owner, so a parent dispose (e.g. createRoot) tears the effect down.
  const owner = createOwner(currentOwner)
  const node = createNode<T>(
    seed,
    fn,
    // Effects don't memoize a value for downstream comparison; equals is unused
    // on the effect side, but keep a sane default.
    Object.is,
    true, // scheduler-driven
    owner,
    opts?.name,
  )
  node.owner = owner

  if (currentOwner !== null) currentOwner.owned.push(node as unknown as Node<unknown>)

  node.state = STALE
  enqueueEffect(node as unknown as Node<unknown>)

  if (opts?.defer) {
    // Skip the IMMEDIATE (synchronous-at-creation) run: the first
    // dependency-capturing run is pushed to the microtask flush instead, so the
    // effect subscribes and reacts only from that point on. `flushSync()` (or a
    // microtask tick) triggers it.
    scheduleFlush()
    return
  }

  if (batchDepth > 0) {
    // Inside a batch, defer to batch close so all effects created/dirtied in the
    // batch run exactly once when it settles.
    scheduleFlush()
  } else {
    // Immediate first run.
    flushEffects()
  }
}

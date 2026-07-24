import type { Accessor, SignalOptions } from './types'
import {
  createNode,
  createOwner,
  currentObserver,
  currentOwner,
  defaultEquals,
  STALE,
  track,
  updateIfNecessary,
  type Node,
} from './core'

/**
 * Create a memoized derived value (a "memo").
 *
 * `fn(prev)` recomputes lazily: it does NOT run until the accessor is first read,
 * then re-runs only when read after one of its tracked sources changed. Results
 * are memoized via `equals` (default `Object.is`; `equals: false` disables it).
 * The computed subscribes its reader on read, and only propagates to its own
 * observers when its value actually changes (equals-gated) — this is what makes
 * diamonds recompute downstream nodes exactly once.
 */
export function computed<T>(
  fn: (prev: T | undefined) => T,
  seed?: T,
  opts?: SignalOptions<T>,
): Accessor<T> {
  const equals =
    opts?.equals === false ? () => false : (opts?.equals ?? defaultEquals)

  // A computed owns a scope (for its own onCleanup + nested reactions) whose
  // parent is the creating owner, so disposing the parent disposes this too.
  const owner = createOwner(currentOwner)
  const node = createNode<T>(
    seed,
    fn,
    equals as (a: T, b: T) => boolean,
    false, // not an effect: pulled lazily, never scheduler-driven
    owner,
    opts?.name,
  )
  node.owner = owner

  // Register with the creating owner so it is disposed with its parent.
  if (currentOwner !== null) currentOwner.owned.push(node as unknown as Node<unknown>)

  // Lazy: mark STALE but do not run until first read.
  node.state = STALE

  return () => {
    const n = node as unknown as Node<unknown>
    if (currentObserver !== null) track(n, currentObserver)
    updateIfNecessary(n)
    return node.value as T
  }
}

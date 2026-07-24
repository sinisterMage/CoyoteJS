import type { Owner } from './types'
import {
  createOwner,
  currentOwner,
  disposeOwner,
  setCurrentObserver,
  setCurrentOwner,
  type OwnerNode,
} from './core'

// The public `Owner` type is opaque (just `{ readonly __coyote: 'owner' }`), so
// the internal `OwnerNode` is a structural superset. We bridge with casts at the
// boundary; internally everything is `OwnerNode`.

/** The owner scope currently in effect, or null at the top level / detached. */
export function getOwner(): Owner | null {
  return (currentOwner as unknown as Owner) ?? null
}

/**
 * Create a DETACHED root scope. `fn(dispose)` runs with a fresh owner as the
 * current owner (and no current observer, so the root itself tracks nothing);
 * `dispose` tears the whole scope down (its cleanups + owned reactions). Returns
 * whatever `fn` returns. The root persists until `dispose()` is called.
 */
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const owner = createOwner(null) // detached: no parent, survives GC of callers
  const dispose = () => disposeOwner(owner)

  const prevOwner = setCurrentOwner(owner)
  const prevObserver = setCurrentObserver(null)
  try {
    return fn(dispose)
  } finally {
    setCurrentObserver(prevObserver)
    setCurrentOwner(prevOwner)
  }
}

/**
 * Re-enter a captured owner scope (from `getOwner`) to run `fn` — lets a
 * reaction created inside an async callback attach to the right scope. Tracking
 * is suppressed (no current observer) so `fn`'s reads don't subscribe anything.
 */
export function runWithOwner<T>(owner: Owner | null, fn: () => T): T {
  const prevOwner = setCurrentOwner((owner as unknown as OwnerNode) ?? null)
  const prevObserver = setCurrentObserver(null)
  try {
    return fn()
  } finally {
    setCurrentObserver(prevObserver)
    setCurrentOwner(prevOwner)
  }
}

/**
 * Register a cleanup to run (LIFO) the next time the owning reaction re-executes
 * or when its owner is disposed. Registers on the running node's owner scope;
 * a no-op if called with no owner in scope.
 */
export function onCleanup(fn: () => void): void {
  if (currentOwner !== null) {
    currentOwner.cleanups.push(fn)
  }
}

// Child-scope creation on top of the reactivity core.
//
// The reactivity core exposes `createRoot` (a DETACHED owner) and
// `runWithOwner`/`getOwner`. Control-flow rows, Provider scopes and boundaries
// each need a child owner that:
//   1. runs its own cleanups when disposed (independent of siblings), and
//   2. cascades disposal from a chosen parent owner (so unmount tears it down).
//
// `createRoot` gives us (1). For (2) we register a cleanup on the parent owner
// that disposes the child root. We also thread a real `.parent` pointer so
// `useContext` can walk the chain (see ./context). The reactivity core stores
// `parent` on the owner node but never reads it internally, so assigning it here
// is safe and only feeds our own context walk.
//
// IMPORTANT: control-flow reconciliation runs INSIDE the enclosing slot's effect,
// and the reactivity core disposes an effect's owned children before each
// re-run. Row/branch scopes must therefore be parented at a STABLE owner
// captured when the control-flow component was first invoked (via `getOwner()`),
// NOT at whatever owner is current during a slot-effect re-run. `createScopeIn`
// takes that stable parent explicitly.

import { createRoot, getOwner, onCleanup, runWithOwner } from '../reactivity'
import type { Owner } from '../reactivity'

/** Internal owner shape (structural superset of the opaque `Owner`). */
interface OwnerInternal {
  parent: OwnerInternal | null
}

/**
 * Create a child scope parented at `parent`: `fn(dispose)` runs with a fresh
 * owner as current owner. Returns `fn`'s result. The child owner's `.parent` is
 * set to `parent`, and disposing `parent` disposes this child too.
 */
export function createScopeIn<T>(parent: Owner | null, fn: (dispose: () => void) => T): T {
  return createRoot((dispose) => {
    const child = getOwner()
    if (child && parent) {
      ;(child as unknown as OwnerInternal).parent = parent as unknown as OwnerInternal
    }
    if (parent) runWithOwner(parent, () => onCleanup(dispose))
    return fn(dispose)
  })
}

/**
 * Create a child scope parented at the CURRENT owner. Convenience wrapper used
 * where the current owner is already the stable one (e.g. context Provider,
 * which runs at component-call time).
 */
export function createChildScope<T>(fn: (dispose: () => void) => T): T {
  return createScopeIn(getOwner(), fn)
}

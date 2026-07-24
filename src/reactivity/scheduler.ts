import {
  clearScheduled,
  enterBatch,
  exitBatch,
  flushEffects,
  setCurrentObserver,
} from './core'

/**
 * Run `fn` with writes coalesced: effects do not flush until the outermost
 * batch closes, so multiple sets trigger each dependent effect at most once.
 * Reads inside a batch still pull fresh values (via updateIfNecessary), so
 * same-tick readers observe current signal values — the batch only defers the
 * side-effecting effect flush, never staleness. Returns `fn`'s result.
 */
export function batch<T>(fn: () => T): T {
  enterBatch()
  try {
    return fn()
  } finally {
    if (exitBatch()) flushEffects()
  }
}

/**
 * Run `fn` without subscribing the current observer to any reads inside it.
 * Restores the previous observer afterwards. Returns `fn`'s result.
 */
export function untrack<T>(fn: () => T): T {
  const prev = setCurrentObserver(null)
  try {
    return fn()
  } finally {
    setCurrentObserver(prev)
  }
}

/**
 * Flush the pending effect queue synchronously now (for tests and initial
 * render). Also clears any scheduled microtask flag so a queued microtask
 * becomes a no-op.
 */
export function flushSync(): void {
  clearScheduled()
  flushEffects()
}

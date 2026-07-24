// createResource — reactive async data.
//
// Given a reactive `source` accessor and an async `fetcher(source, info)`, this
// produces a `Resource<T>`: an accessor for the latest value plus `loading`,
// `error`, `latest`, `mutate`, and `refetch`. It re-fetches whenever `source`
// changes (tracked via an effect), ignores stale in-flight responses (last write
// wins), and integrates with the nearest `<Suspense>` boundary by incrementing
// its pending count while a fetch is outstanding.
//
// The `source` accessor may yield `false`/`null` to signal "not ready" — the
// fetcher is skipped and the resource stays in its current state (Solid's
// convention). A plain (non-function) source is treated as a constant.

import { batch, effect, getOwner, onCleanup, runWithOwner, signal, untrack } from '../reactivity'
import type { Accessor } from '../reactivity'
import { useSuspense } from '../dom'
import type { Resource } from './types'

/** A source that yields `false`/`null` is treated as "not ready" (skip fetch). */
function readSource<S>(source: Accessor<S | false | null> | S): S | false | null {
  return typeof source === 'function' ? (source as Accessor<S | false | null>)() : source
}

export function createResource<T, S = true>(
  source: Accessor<S | false | null> | S,
  fetcher: (source: S, info: { value: T | undefined; refetching: boolean }) => Promise<T>,
): Resource<T> {
  const [value, setValue] = signal<T | undefined>(undefined)
  const [error, setError] = signal<unknown>(undefined)
  const [loading, setLoading] = signal(false)

  // Capture the owning scope + nearest Suspense boundary at creation time so
  // async continuations resolve the right context even after the fetch awaits.
  // `useSuspense()` returns null when there is no enclosing <Suspense>, in which
  // case the pending accounting below is a no-op (the resource still works).
  const owner = getOwner()
  const suspense = useSuspense()

  // A monotonically increasing token; only the newest fetch may commit results.
  let fetchToken = 0
  // How many Suspense increments THIS resource currently holds outstanding. Each
  // in-flight `load` owns exactly one; it releases that one on its own settle
  // (success, error, or supersession). `onCleanup` releases any that remain (e.g.
  // the resource is disposed while a fetch is still outstanding).
  let pending = 0

  const addPending = (): void => {
    if (!suspense) return
    pending++
    suspense.increment()
  }
  // Release exactly ONE outstanding increment (guarded so we never decrement
  // below what we added — a double-release, e.g. cleanup racing a settle, is a
  // no-op rather than driving the boundary's count negative).
  const releasePending = (): void => {
    if (!suspense || pending === 0) return
    pending--
    suspense.decrement()
  }
  // Release ALL outstanding increments (used on teardown / hard reset).
  const clearPending = (): void => {
    while (pending > 0) releasePending()
  }
  onCleanup(clearPending)

  /** Run the fetcher for `src`, wiring loading/error/value and Suspense. */
  const load = (src: S, refetching: boolean): Promise<T | undefined> => {
    const token = ++fetchToken
    setLoading(true)
    setError(undefined)
    addPending()
    // Ensure this load's single pending unit is released exactly once, no matter
    // which arm settles it (fresh commit, or a superseded early return).
    let released = false
    const settle = (): void => {
      if (released) return
      released = true
      releasePending()
    }

    const info = { value: untrack(value), refetching }
    let promise: Promise<T>
    try {
      promise = Promise.resolve(fetcher(src, info))
    } catch (err) {
      // A synchronous throw from the fetcher.
      promise = Promise.reject(err)
    }

    return promise.then(
      (result) => {
        if (token !== fetchToken) {
          settle() // superseded — drop our pending unit but don't commit.
          return untrack(value)
        }
        batch(() => {
          setValue(() => result)
          setLoading(false)
        })
        settle()
        return result
      },
      (err) => {
        if (token !== fetchToken) {
          settle()
          return untrack(value)
        }
        batch(() => {
          setError(err)
          setLoading(false)
        })
        settle()
        return untrack(value)
      },
    )
  }

  // Track `source`; re-fetch on change. A `false`/`null` source skips the fetch.
  effect(() => {
    const src = readSource(source)
    if (src === false || src === null || src === undefined) {
      // Not ready: leave prior value in place, but ensure we aren't "loading".
      untrack(() => {
        if (loading()) {
          fetchToken++ // invalidate any in-flight fetch
          setLoading(false)
          clearPending()
        }
      })
      return
    }
    void load(src as S, false)
  })

  const refetch = (): Promise<T | undefined> => {
    const src = untrack(() => readSource(source))
    if (src === false || src === null || src === undefined) {
      return Promise.resolve(untrack(value))
    }
    // Re-run under the captured owner so any reactions inside the fetcher attach
    // correctly even when refetch is called from an event handler.
    return runWithOwner(owner, () => load(src as S, true))
  }

  const mutate = (v: T): void => {
    batch(() => {
      fetchToken++ // any in-flight fetch is now stale
      setValue(() => v)
      setError(undefined)
      setLoading(false)
    })
    clearPending()
  }

  // The resource accessor: reading it subscribes to `value` (and re-throws a
  // stored error is intentionally NOT done here — `error()` exposes it).
  const read = (() => value()) as Resource<T>
  read.loading = loading
  read.error = error
  read.latest = value
  read.mutate = mutate
  read.refetch = refetch
  return read
}

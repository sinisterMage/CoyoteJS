// Browser-history layer: a single reactive signal holding the current location
// (pathname + search + hash) plus imperative push/replace helpers that keep it in
// sync with `window.history` and the `popstate` event.
//
// The router mounts a listener once (via `startHistory`) and every navigation —
// programmatic (`navigate`/`Link`) or user-driven (back/forward) — funnels
// through here so `useRoute()` stays authoritative. `navigate` itself lives in
// router.tsx because it must run guards; this module owns only the raw location.

import { signal } from '../reactivity'
import type { Accessor } from '../reactivity'

/** A raw browser location, independent of any route table. */
export interface Location {
  /** Path without search/hash, e.g. `/builder/42`. */
  pathname: string
  /** Full path including search + hash, e.g. `/builder/42?tab=code#top`. */
  fullPath: string
  /** Search string INCLUDING the leading `?` (or `''`). */
  search: string
  /** Hash string INCLUDING the leading `#` (or `''`). */
  hash: string
  /** The `state` passed to push/replaceState for this entry. */
  state: unknown
}

/** Read the browser's current location into a plain object. */
export function readLocation(): Location {
  const { pathname, search, hash } = window.location
  return {
    pathname,
    fullPath: pathname + search + hash,
    search,
    hash,
    state: window.history.state,
  }
}

const [location, setLocation] = signal<Location>(readLocation())

/** The reactive current browser location. */
export const currentLocation: Accessor<Location> = location

/** Recompute the location signal from `window.location` (after a history op). */
export function syncLocation(state?: unknown): void {
  const loc = readLocation()
  setLocation({ ...loc, state: state !== undefined ? state : loc.state })
}

let started = false
let onPop: (() => void) | null = null

/**
 * Begin listening for `popstate`. The listener is attached at most once (so
 * remounting a `<Router>` never stacks listeners), but every call re-syncs the
 * location signal from `window.location` — the module-level signal outlives any
 * single mount, so a fresh Router must adopt the current browser location.
 * Returns a stop function.
 */
export function startHistory(): () => void {
  // Always adopt the live browser location for this (re)mount.
  syncLocation()
  if (started) return stopHistory
  started = true
  onPop = () => syncLocation()
  window.addEventListener('popstate', onPop)
  return stopHistory
}

/** Stop listening for `popstate`. */
export function stopHistory(): void {
  if (onPop) window.removeEventListener('popstate', onPop)
  onPop = null
  started = false
}

/** `history.pushState` + resync the reactive location. */
export function pushLocation(to: string, state: unknown = null): void {
  window.history.pushState(state, '', to)
  syncLocation(state)
}

/** `history.replaceState` + resync the reactive location. */
export function replaceLocation(to: string, state: unknown = null): void {
  window.history.replaceState(state, '', to)
  syncLocation(state)
}

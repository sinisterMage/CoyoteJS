// The router core: the reactive `ResolvedRoute` context, the `<Router>`
// component that matches the current location against the route table and
// renders the matched component (eager or lazy), programmatic `navigate`, and
// the `useRoute`/`useParams`/`useSearchParams` hooks.
//
// A single module-level context carries the live route + the compiled table so
// hooks work from anywhere in the tree. `navigate` runs the router's guards,
// honoring string redirects, before committing to history. Lazy components
// (`() => import(...)`) are resolved through a per-route resource that integrates
// with `<Suspense>` so a pending import shows the fallback.

import { computed, untrack } from '../reactivity'
import type { Accessor } from '../reactivity'
import { Show, Suspense, createContext, useContext } from '../dom'
import type { Component, CoyoteNode } from '../dom'
import type {
  ResolvedRoute,
  RouteGuard,
  RouterProps,
} from './types'
import {
  compileRoutes,
  matchRoutes,
  parseQuery,
  stringifyQuery,
  type CompiledRoute,
  type RouteMatch,
} from './match'
import {
  currentLocation,
  pushLocation,
  replaceLocation,
  startHistory,
  type Location,
} from './history'
import { createResource } from './resource'

/** What the router context exposes to hooks + Link. */
interface RouterContextValue {
  route: Accessor<ResolvedRoute>
  compiled: CompiledRoute[]
  guards: RouteGuard[]
}

const RouterContext = createContext<RouterContextValue | null>(null)

/** The active router context, or throw a clear error if used outside a Router. */
function useRouter(): RouterContextValue {
  const ctx = useContext(RouterContext)
  if (!ctx) {
    throw new Error('coyote/router: hooks and <Link> must be used inside a <Router>.')
  }
  return ctx
}

/** Build a `ResolvedRoute` from a browser location + a (possibly-null) match. */
function resolveRoute(loc: Location, match: RouteMatch | null): ResolvedRoute {
  return {
    path: match ? match.route.path : loc.pathname,
    fullPath: loc.fullPath,
    params: match ? match.params : {},
    query: parseQuery(loc.search),
    meta: match ? match.meta : {},
    hash: loc.hash,
  }
}

// --- Module-level singletons for programmatic navigate() -------------------
//
// `navigate()` is a free function (contract), so it needs the active guards +
// compiled table without a component context. The mounted Router registers them
// here; only one Router is expected at a time in a CSR app.

let activeGuards: RouteGuard[] = []
let activeCompiled: CompiledRoute[] = []
let activeRoute: Accessor<ResolvedRoute> | null = null

/**
 * Run guards in order for a target location. Returns a redirect path string if a
 * guard asked to redirect, or `null` to allow. Stays SYNCHRONOUS when every guard
 * returns synchronously (so a plain `navigate()` commits before the next line);
 * only yields a Promise if some guard actually returns one — matching Solid
 * Router's "sync unless you opt into async" behavior.
 */
function runGuards(toLoc: Location): string | null | Promise<string | null> {
  if (activeGuards.length === 0) return null
  const to = resolveRoute(toLoc, matchRoutes(activeCompiled, toLoc.pathname))
  const from = activeRoute ? untrack(activeRoute) : null

  const step = (i: number): string | null | Promise<string | null> => {
    for (let j = i; j < activeGuards.length; j++) {
      const result = activeGuards[j](to, from)
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        // An async guard: continue the chain on its resolution.
        return (result as Promise<void | string>).then((r) =>
          typeof r === 'string' ? r : step(j + 1),
        )
      }
      if (typeof result === 'string') return result
    }
    return null
  }
  return step(0)
}

/** Locate the scroll target for a hash, or null. */
function hashTarget(hash: string): Element | null {
  if (!hash || hash === '#') return null
  const id = decodeURIComponent(hash.slice(1))
  try {
    return document.getElementById(id) ?? document.querySelector(hash)
  } catch {
    return document.getElementById(id)
  }
}

let scrollEnabled = true

/** Apply scroll behavior after a committed navigation. */
function applyScroll(hash: string): void {
  if (!scrollEnabled) return
  const target = hashTarget(hash)
  if (target) {
    target.scrollIntoView()
  } else if (typeof window.scrollTo === 'function') {
    // jsdom leaves scrollTo unimplemented (throws) — guard so tests/navigation
    // don't blow up in non-browser environments.
    try {
      window.scrollTo(0, 0)
    } catch {
      /* no-op: environment without a real scroll surface */
    }
  }
}

interface NavOpts {
  replace?: boolean
  state?: unknown
  scroll?: boolean
}

/** Commit a resolved target to history + scroll (guards already cleared). */
function commit(toLoc: Location, opts?: NavOpts): void {
  const target = toLoc.fullPath
  if (opts?.replace) replaceLocation(target, opts?.state ?? null)
  else pushLocation(target, opts?.state ?? null)
  if (opts?.scroll !== false) applyScroll(toLoc.hash)
}

function toLocation(to: string, state: unknown): Location {
  const url = new URL(to, window.location.origin)
  return {
    pathname: url.pathname,
    fullPath: url.pathname + url.search + url.hash,
    search: url.search,
    hash: url.hash,
    state: state ?? null,
  }
}

/** Cap on chained guard redirects, to break a cyclic-redirect loop (A→B→A…). */
const MAX_REDIRECTS = 20

/**
 * Programmatic navigation. Runs guards (a string result redirects there),
 * commits to history (push or replace), and applies scroll. Synchronous unless a
 * guard is async, in which case the commit happens once the guard chain settles.
 */
export function navigate(to: string, opts?: NavOpts): void {
  navigateWithDepth(to, opts, 0)
}

function navigateWithDepth(to: string, opts: NavOpts | undefined, depth: number): void {
  const toLoc = toLocation(to, opts?.state)
  const decision = runGuards(toLoc)

  const proceed = (redirect: string | null): void => {
    if (redirect != null && redirect !== to) {
      if (depth >= MAX_REDIRECTS) {
        // A cyclic or runaway guard redirect chain — stop rather than recurse
        // forever, and commit the last requested target so the app isn't wedged.
        console.error(
          `coyote/router: exceeded ${MAX_REDIRECTS} guard redirects navigating to "${to}"; aborting redirect chain.`,
        )
        commit(toLoc, opts)
        return
      }
      // Redirect always replaces so the blocked entry doesn't linger in history.
      navigateWithDepth(redirect, { replace: true, state: opts?.state }, depth + 1)
      return
    }
    commit(toLoc, opts)
  }

  if (decision && typeof (decision as Promise<unknown>).then === 'function') {
    void (decision as Promise<string | null>).then(proceed)
  } else {
    proceed(decision as string | null)
  }
}

// --- Component rendering (eager + lazy) ------------------------------------
//
// A route `component` is EITHER an eager `Component` (`(props) => node`) OR a
// lazy loader (`() => Promise<{ default: Component }>`). We can't tell them apart
// from the type alone, so we call the function ONCE with the route props and
// inspect the result: a thenable means it was a lazy loader (that call kicked off
// the import — we reuse that very promise); anything else is the eager render and
// is used directly. A single call, never a double-mount.
//
// Route props: the matched component is invoked with an empty prop bag. Params
// and query are read reactively via useParams/useSearchParams, so the component
// need not (and cannot, per the contract's `Component` shape) receive them as
// props — this keeps a param-only navigation from remounting the component.

/**
 * Await an already-started import through a resource so an outstanding load shows
 * the enclosing `<Suspense>` fallback, then render its `default` export.
 */
function LazyRoute(props: { started: Promise<{ default: Component }> }): CoyoteNode {
  const comp = createResource(
    () => true,
    () => props.started.then((m) => m.default),
  )
  return () => {
    const C = comp()
    return C ? C({}) : null
  }
}

/** Render a matched route's component, resolving a lazy loader through Suspense. */
function renderComponent(match: RouteMatch): CoyoteNode {
  const component = match.route.def.component
  const result = (component as (props: {}) => unknown)({})
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    // Lazy loader: the call above started the import; feed that promise to the
    // resource so we don't import twice.
    return LazyRoute({ started: result as Promise<{ default: Component }> })
  }
  // Eager component: `result` is its rendered node.
  return result as CoyoteNode
}

export function Router(props: RouterProps): CoyoteNode {
  const compiled = compileRoutes(props.routes)
  const guards = props.guards ?? []
  scrollEnabled = props.scrollRestoration !== false

  // The matched-route accessor, recomputed only when the location changes.
  const currentMatch = computed<RouteMatch | null>(() =>
    matchRoutes(compiled, currentLocation().pathname),
  )

  // Reactive resolved route derived from the location + the current match.
  const route = computed<ResolvedRoute>(() => resolveRoute(currentLocation(), currentMatch()))

  // Register singletons for the free `navigate()` + guard runner.
  activeGuards = guards
  activeCompiled = compiled
  activeRoute = route

  startHistory()

  const ctx: RouterContextValue = { route, compiled, guards }

  // `<Show keyed>` on the winning route's PATH means the page component remounts
  // only when the matched route changes — a param- or query-only navigation keeps
  // the same component instance, which re-reads its params/query reactively via
  // the hooks.
  const matchedPath = computed(() => currentMatch()?.route.path ?? null)

  const fallbackNode = (): CoyoteNode => (props.fallback ? props.fallback({}) : null)

  // Pass ACCESSORS (not evaluated values) so the control-flow components react.
  const outlet = (): CoyoteNode =>
    Show({
      when: matchedPath,
      fallback: fallbackNode,
      keyed: true,
      children: () => renderComponent(untrack(currentMatch)!),
    })

  // Suspense children run under its context so lazy routes' resources register
  // their pending state; the router context wraps everything so hooks resolve.
  const body = (): CoyoteNode =>
    RouterContext.Provider({
      value: ctx,
      children: () => Suspense({ fallback: null, children: outlet }),
    })

  if (props.root) {
    const Root = props.root
    return Root({ children: body })
  }
  return body()
}

// --- Hooks -----------------------------------------------------------------

export function useRoute(): Accessor<ResolvedRoute> {
  return useRouter().route
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): Accessor<T> {
  const route = useRouter().route
  return computed<T>(() => route().params as T)
}

export function useSearchParams(): [
  Accessor<Record<string, string>>,
  (next: Record<string, string | null>) => void,
] {
  const route = useRouter().route
  const query = computed(() => route().query)

  const setSearchParams = (next: Record<string, string | null>): void => {
    const current = { ...untrack(route).query }
    for (const k in next) {
      const v = next[k]
      if (v === null) delete current[k]
      else current[k] = v
    }
    const loc = untrack(currentLocation)
    const search = stringifyQuery(current)
    navigate(loc.pathname + search + loc.hash, { replace: true })
  }

  return [query, setSearchParams]
}

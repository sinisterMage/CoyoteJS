// Route-table flattening + path matching.
//
// A route table arrives either as a glob record (Vite's
// `import.meta.glob('/src/routes/*.route.ts', { eager: true })`) whose values are
// `{ default: RouteModule }`, or as a plain `RouteDef[]`. We flatten both to a
// single `RouteDef[]`, normalize each path's tokens (`[id]` → `:id`), compile a
// matcher, and rank candidates so the most specific static route wins.

import type { RouteDef, RouteMeta, RouterProps } from './types'

/** A route with a compiled matcher, ready to test against a pathname. */
export interface CompiledRoute {
  /** Normalized path pattern (`[id]` → `:id`), e.g. `/builder/:id`. */
  path: string
  def: RouteDef
  /** Ordered list of `:param` names in this pattern. */
  keys: string[]
  regex: RegExp
  /** Specificity score — higher wins ties (more static segments first). */
  score: number
}

/**
 * Normalize a route path:
 *   - `[id]` file-token → `:id`
 *   - collapse duplicate slashes
 *   - strip a trailing slash (except the root `/`)
 *   - ensure a leading slash
 */
export function normalizePath(path: string): string {
  let p = path.replace(/\[([^\]]+)\]/g, ':$1')
  if (!p.startsWith('/')) p = '/' + p
  p = p.replace(/\/{2,}/g, '/')
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

/** Is this value a `RouteDef` (has a `path` + `component`)? */
function isRouteDef(v: unknown): v is RouteDef {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as RouteDef).path === 'string' &&
    'component' in v
  )
}

/**
 * Flatten either input shape into a flat `RouteDef[]`. Glob values are
 * `{ default: RouteModule }` where the module is a `RouteDef` or `RouteDef[]`;
 * a direct array is passed through. Non-conforming entries are skipped.
 */
export function flattenRoutes(routes: RouterProps['routes']): RouteDef[] {
  const out: RouteDef[] = []
  const push = (mod: unknown): void => {
    if (Array.isArray(mod)) {
      for (const m of mod) if (isRouteDef(m)) out.push(m)
    } else if (isRouteDef(mod)) {
      out.push(mod)
    }
  }

  if (Array.isArray(routes)) {
    for (const def of routes) push(def)
  } else {
    for (const key in routes) {
      const entry = routes[key]
      push(entry && (entry as { default?: unknown }).default)
    }
  }
  return out
}

/** Compile a single route's normalized path into a matcher. */
export function compileRoute(def: RouteDef): CompiledRoute {
  const path = normalizePath(def.path)
  const keys: string[] = []
  let score = 0

  const segments = path === '/' ? [''] : path.split('/').slice(1)
  const parts = segments.map((seg) => {
    if (seg.startsWith(':')) {
      keys.push(seg.slice(1))
      return '([^/]+)'
    }
    if (seg === '*') {
      keys.push('wildcard')
      return '(.*)'
    }
    score += 10 // static segments make a route more specific
    return escapeRegex(seg)
  })

  const source = path === '/' ? '^/$' : '^/' + parts.join('/') + '/?$'
  return { path, def, keys, regex: new RegExp(source), score }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile + rank a route table. Most-specific (more static segments) first, so
 * `/builder/new` is preferred over `/builder/:id` when both could match.
 */
export function compileRoutes(routes: RouterProps['routes']): CompiledRoute[] {
  return flattenRoutes(routes)
    .map(compileRoute)
    .sort((a, b) => b.score - a.score)
}

/** A successful match: the winning route plus its extracted params. */
export interface RouteMatch {
  route: CompiledRoute
  params: Record<string, string>
  meta: RouteMeta
}

/** Test compiled routes against a pathname; return the first (highest-ranked) hit. */
export function matchRoutes(compiled: CompiledRoute[], pathname: string): RouteMatch | null {
  const decoded = safeDecode(pathname)
  for (const route of compiled) {
    const m = route.regex.exec(decoded)
    if (!m) continue
    const params: Record<string, string> = {}
    for (let i = 0; i < route.keys.length; i++) {
      params[route.keys[i]] = safeDecode(m[i + 1] ?? '')
    }
    return { route, params, meta: route.def.meta ?? {} }
  }
  return null
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Parse a search string (`?a=1&b=2`) into a flat record (last value wins). */
export function parseQuery(search: string): Record<string, string> {
  const query: Record<string, string> = {}
  const params = new URLSearchParams(search)
  for (const [k, v] of params) query[k] = v
  return query
}

/** Serialize a query record back into a search string with a leading `?` (or ''). */
export function stringifyQuery(query: Record<string, string>): string {
  const params = new URLSearchParams()
  for (const k in query) params.set(k, query[k])
  const s = params.toString()
  return s ? '?' + s : ''
}

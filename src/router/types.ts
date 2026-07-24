// Public type surface for coyote/router.
import type { Accessor } from '../reactivity'
import type { CoyoteNode, Component } from '../dom'

export interface RouteMeta {
  requiresAuth?: boolean
  layout?: string | false
  title?: string
  [k: string]: unknown
}
export interface RouteDef {
  /** '/builder/:id' — a page unit may author '[id]', normalized to ':id' by the router. */
  path: string
  component: (() => Promise<{ default: Component }>) | Component
  meta?: RouteMeta
}
export type RouteModule = RouteDef | RouteDef[]

export interface ResolvedRoute {
  path: string
  fullPath: string
  params: Record<string, string>
  query: Record<string, string>
  meta: RouteMeta
  hash: string
}
/** Return a path string to redirect; return void to allow. */
export interface RouteGuard {
  (to: ResolvedRoute, from: ResolvedRoute | null): void | string | Promise<void | string>
}

export interface RouterProps {
  /** Typically import.meta.glob('/src/routes/*.route.ts', { eager: true }). */
  routes: Record<string, { default: RouteModule }> | RouteDef[]
  guards?: RouteGuard[]
  fallback?: Component
  scrollRestoration?: boolean
  root?: Component<{ children: any }>
}

export interface Resource<T> extends Accessor<T | undefined> {
  loading: Accessor<boolean>
  error: Accessor<unknown>
  latest: Accessor<T | undefined>
  mutate: (v: T) => void
  refetch: () => Promise<T | undefined>
}

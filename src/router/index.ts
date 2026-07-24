// coyote/router — a client-side history router + createResource.
//
// This barrel re-exports the ENTIRE public surface of the module.

// Router component + navigation + hooks.
export { Router, navigate, useRoute, useParams, useSearchParams } from './router'

// Client-side anchor.
export { Link } from './link'

// Reactive async data.
export { createResource } from './resource'

// Public types.
export type {
  RouteMeta,
  RouteDef,
  RouteModule,
  ResolvedRoute,
  RouteGuard,
  RouterProps,
  Resource,
} from './types'

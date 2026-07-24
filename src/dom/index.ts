// coyote/dom — fine-grained reactive DOM renderer + JSX runtime (no VDOM).
//
// This barrel re-exports the ENTIRE public surface of the module.

// Hyperscript + fragment.
export { h, Fragment } from './h'

// Rendering + lifecycle.
export { render } from './render'
export { onMount, onCleanup } from './lifecycle'

// Control flow.
export { For, Index, Show, Switch, Match, Portal, Dynamic } from './control-flow'

// Boundaries.
// `useSuspense`/`SuspenseContext` let coyote/router's createResource drive the
// Suspense pending counter (a pending async read shows the boundary's fallback).
// Suspense keeps its children mounted in an off-document holder while pending, so
// a resource that settles mid-suspend renders correctly and lazy routes still
// resolve (the earlier regression).
export { ErrorBoundary, Suspense, useSuspense, SuspenseContext } from './boundaries'

// Context.
export { createContext, useContext } from './context'

// Public types.
export type {
  CoyoteNode,
  CoyoteNodeArray,
  CoyoteNodeFn,
  Component,
  Context,
} from './types'

// Suspense coordination surface (read by coyote/router's createResource).
export type { SuspenseContextValue } from './boundaries'

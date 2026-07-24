// Automatic JSX runtime target (jsxImportSource: "@sinistermage/coyote-js"). The compiler emits
// `jsx`/`jsxs`/`jsxDEV(type, props, key)` and imports `Fragment` from here.
// Children arrive on `props.children` (a single node or an array); we delegate
// straight to `h`.

import type { Component, CoyoteNode } from './types'
import { Fragment as FragmentImpl, h } from './h'

export { FragmentImpl as Fragment }

function jsxImpl(type: string | Component<any>, props: Record<string, any> | null): CoyoteNode {
  const p = props || {}
  const children = p.children
  if (children === undefined) {
    return h(type, p)
  }
  // `h` already folds a `children` prop into the element/component; pass through.
  if (Array.isArray(children)) {
    return h(type, p, ...children)
  }
  return h(type, p, children)
}

export function jsx(type: any, props: any, _key?: any): CoyoteNode {
  return jsxImpl(type, props)
}

export function jsxs(type: any, props: any, _key?: any): CoyoteNode {
  return jsxImpl(type, props)
}

export function jsxDEV(type: any, props: any, _key?: any): CoyoteNode {
  return jsxImpl(type, props)
}

// The JSX namespace TypeScript resolves via jsxImportSource="@sinistermage/coyote-js".
// IntrinsicElements is kept permissive (any tag/props) so app JSX typechecks;
// `ElementChildrenAttribute` tells TS the children prop key.
export namespace JSX {
  export type Element = CoyoteNode
  export interface ElementChildrenAttribute {
    children: {}
  }
  export interface IntrinsicElements {
    [elemName: string]: any
  }
}

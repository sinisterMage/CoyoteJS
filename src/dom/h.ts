// Hyperscript factory. `h(tag, props, ...children)`:
//   - string tag  → real element creation, apply props, append resolved
//     (and reactive) children, return the Element.
//   - Component    → call it with `{ ...props, children }` and return its node.
// No virtual DOM: the returned value is a real DOM node (or whatever the
// component returns).
//
// SVG namespacing: inline `<svg>` and its vector descendants (`path`, `rect`,
// `circle`, `g`, …) MUST be created in the SVG namespace via
// `document.createElementNS` — a plain `createElement('path')` yields an inert
// `HTMLUnknownElement` that never renders as vector graphics in a real browser
// (jsdom is lenient, so this bug is invisible in unit tests but broken in
// production). JSX/hyperscript evaluate children BEFORE the parent, so a
// top-down namespace flag can't reach an already-built child; instead we pick
// the namespace from a known-SVG-tag set. This covers every real case with no
// per-tree fix-up: an svg subtree is svg-named tags all the way down (each self-
// namespaces at its own `h` call), and a `<foreignObject>`'s HTML content is
// built from HTML tag names that self-namespace as XHTML — the SVG/HTML boundary
// falls out of the tag set for free.

import type { Component, CoyoteNode } from './types'
import { applyProps } from './bindings'
import { appendChild } from './nodes'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Tags that live in the SVG namespace. An SVG tree is svg-named tags the whole
 * way down, so matching the tag name is enough to namespace it correctly even
 * though children are built before their parent. `foreignObject` is included
 * (it IS an SVG element); its HTML content self-namespaces as XHTML because
 * those children carry HTML tag names, which are absent from this set.
 */
const SVG_TAGS = new Set([
  'svg',
  'animate',
  'animateMotion',
  'animateTransform',
  'circle',
  'clipPath',
  'defs',
  'desc',
  'ellipse',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feDistantLight',
  'feDropShadow',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feImage',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'fePointLight',
  'feSpecularLighting',
  'feSpotLight',
  'feTile',
  'feTurbulence',
  'filter',
  'foreignObject',
  'g',
  'image',
  'line',
  'linearGradient',
  'marker',
  'mask',
  'metadata',
  'mpath',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'radialGradient',
  'rect',
  'stop',
  'switch',
  'symbol',
  'text',
  'textPath',
  'tspan',
  'use',
  'view',
])

/** True when `tag` names an SVG element. */
export function isSvgTag(tag: string): boolean {
  return SVG_TAGS.has(tag)
}

export function h(
  tag: string | Component<any>,
  props: Record<string, any> | null,
  ...children: CoyoteNode[]
): CoyoteNode {
  if (typeof tag === 'function') {
    // Component: fold children into props (single child stays single; many → array).
    const merged: Record<string, any> = { ...(props || {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    else if (props && 'children' in props) merged.children = props.children
    return tag(merged as any)
  }

  const svg = isSvgTag(tag)
  const el = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag)
  applyProps(el, props)

  // Prefer explicit variadic children; fall back to a `children` prop (JSX
  // runtime path passes children through props).
  const kids =
    children.length > 0 ? children : props && 'children' in props ? [props.children] : []
  for (const child of kids) appendChild(el, child)

  return el
}

/** Fragment: renders its children with no wrapper element. */
export function Fragment(props: { children?: CoyoteNode }): CoyoteNode {
  return props.children as CoyoteNode
}

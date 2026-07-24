// Public node/value types for coyote/dom.

/**
 * Anything that can be rendered as a child or assigned to a reactive slot.
 * The two recursive arms go through interfaces so the union never
 * self-references at the top level (TS2456).
 */
export type CoyoteNode =
  | Node
  | string
  | number
  | boolean
  | null
  | undefined
  | CoyoteNodeArray
  | CoyoteNodeFn

/** Behaves like `CoyoteNode[]`. */
export interface CoyoteNodeArray extends Array<CoyoteNode> {}

/** Structurally an `Accessor<CoyoteNode>` (`() => CoyoteNode`). */
export interface CoyoteNodeFn {
  (): CoyoteNode
}

/** A coyote component: a plain function from props to a node. */
export type Component<P = {}> = (props: P) => CoyoteNode

/** A context handle created by `createContext`. */
export interface Context<T> {
  id: symbol
  defaultValue: T
  Provider: Component<{ value: T; children: CoyoteNode }>
}

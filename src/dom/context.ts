// Owner-scoped context. `createContext` mints an id; `Provider` renders its
// children under a child scope carrying the provided value; `useContext` walks
// the owner parent chain looking for the nearest provider, falling back to the
// context default.
//
// Values are keyed by owner in a WeakMap<Owner, Map<symbol, unknown>> so no
// value leaks between sibling scopes and everything is GC'd with its owner. The
// walk follows the real `.parent` pointer that both the reactivity core (for
// effects/computeds) and our own `createChildScope` maintain, so a consumer
// nested arbitrarily deep — through effects, control-flow rows, etc. — still
// finds the provider above it.

import { getOwner } from '../reactivity'
import type { Owner } from '../reactivity'
import type { Component, Context, CoyoteNode } from './types'
import { materialize } from './nodes'
import { createChildScope } from './scope'

interface OwnerInternal {
  parent: OwnerInternal | null
}

/** Per-owner context value maps. */
const contextValues = new WeakMap<object, Map<symbol, unknown>>()

/** Attach a context value to an owner scope. */
function provideValue(owner: Owner, id: symbol, value: unknown): void {
  let map = contextValues.get(owner as object)
  if (!map) {
    map = new Map()
    contextValues.set(owner as object, map)
  }
  map.set(id, value)
}

/** Look up a context value by walking the owner parent chain. */
function lookup(id: symbol): { found: boolean; value: unknown } {
  let owner = getOwner() as unknown as OwnerInternal | null
  while (owner) {
    const map = contextValues.get(owner as unknown as object)
    if (map && map.has(id)) return { found: true, value: map.get(id) }
    owner = owner.parent
  }
  return { found: false, value: undefined }
}

export function createContext<T>(defaultValue: T): Context<T> {
  const id = Symbol('coyote-context')

  const Provider: Component<{ value: T; children: CoyoteNode }> = (props) => {
    // Render children under a child scope tagged with this context value. The
    // children are RESOLVED inside the scope so any consumer that reads the
    // context (via a thunk child) sees the provided value — the scope must be
    // the current owner while the children evaluate.
    let nodes: Node[] = []
    createChildScope(() => {
      const owner = getOwner()
      if (owner) provideValue(owner, id, props.value)
      nodes = materialize(props.children)
    })
    return nodes as unknown as CoyoteNode
  }

  return { id, defaultValue, Provider }
}

export function useContext<T>(ctx: Context<T>): T {
  const { found, value } = lookup(ctx.id)
  return found ? (value as T) : ctx.defaultValue
}

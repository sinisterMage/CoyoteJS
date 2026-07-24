// coyote/store — a fine-grained, signal-backed store primitive (a SolidJS-style
// `createStore` on top of coyote/reactivity).
//
// A store is a deep reactive Proxy over a plain object. Reading a property
// subscribes the current observer to a per-property signal created lazily on
// first access, so an effect that reads `state.a.b` re-runs when `a.b` changes
// but NOT when a sibling `a.c` changes. Writes go through the path-based setter
// returned alongside the proxy, which notifies only the touched signals.
//
// This is the Pinia replacement's engine: `defineStore` wraps it into a memoized
// singleton exposing `{ state, actions }`.
//
// Implementation note: each tracking Proxy is created OVER THE RAW OBJECT (the
// proxy target IS the raw object), so all the Proxy invariants — array `length`
// non-configurability, own-property descriptors, prototype — hold automatically.
// Per-object bookkeeping (the lazily-created signals) lives in a side WeakMap
// keyed by the raw object, never on the object itself, so it stays invisible to
// Object.keys / JSON / consumers.

import { batch, signal, untrack, type Accessor, type Setter } from '../reactivity'
import type { SetStoreFunction, Store, StoreApi } from './types'

type Sig = [Accessor<unknown>, Setter<unknown>]

// Per-object bookkeeping. `signals` maps a property key to its [get, set] pair;
// `keys` is a single signal bumped on any structural add/delete so enumeration
// readers (Object.keys, spreads, For loops) re-run. Child proxies are memoized
// in the shared `rawToProxy` map keyed by the child's raw identity, so reading
// `state.a` twice yields the same proxy.
interface StoreNode {
  raw: Record<PropertyKey, unknown>
  signals: Map<PropertyKey, Sig>
  keys: Sig | null
}

// Marker prop: reading it off a store proxy returns the raw object (used by
// `unwrap`), without polluting real property access.
const RAW = Symbol('coyote.store.raw')

const rawToNode = new WeakMap<object, StoreNode>()
const rawToProxy = new WeakMap<object, unknown>()

// A value we wrap in a nested proxy: a plain object or array, but not null,
// functions, or class instances (Date, Map, Set, DOM nodes, ...). Those are
// treated as opaque leaf values, replaced wholesale rather than tracked deeply.
function isWrappable(v: unknown): v is Record<PropertyKey, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === Array.prototype || proto === null
}

// Normalize a property key to the form the Proxy get-trap sees. Object property
// access coerces every non-symbol key to a string ('1', not 1), but the setter's
// path form can carry numeric array indices — so a write to index `1` and a read
// of `list[1]` must resolve to the SAME signal. Coerce numbers to strings;
// leave symbols and strings as-is.
function normKey(key: PropertyKey): PropertyKey {
  return typeof key === 'number' ? String(key) : key
}

/** Get (or lazily create) the signal backing `key` on `node`. */
function nodeSignal(node: StoreNode, key: PropertyKey): Sig {
  const k = normKey(key)
  let sig = node.signals.get(k)
  if (sig === undefined) {
    sig = signal<unknown>(node.raw[k])
    node.signals.set(k, sig)
  }
  return sig
}

const proxyHandler: ProxyHandler<Record<PropertyKey, unknown>> = {
  get(raw, key, receiver) {
    if (key === RAW) return raw
    const node = rawToNode.get(raw)!

    // Non-own or non-data-property reads (prototype methods like
    // Array.prototype.map, Symbol.iterator) pass through untracked, with the
    // receiver rebound so array methods read elements through this proxy.
    const desc = Object.getOwnPropertyDescriptor(raw, key)
    if (desc === undefined || 'get' in desc) {
      return Reflect.get(raw, key, receiver)
    }

    // Subscribe to this property's signal, then return the current value.
    // Reading `.length` on an array subscribes to the same signal we bump on a
    // structural change (see setKey), so length reads stay reactive.
    const value = nodeSignal(node, key)[0]()
    return isWrappable(value) ? wrap(value) : value
  },

  ownKeys(raw) {
    // Subscribe key-enumeration to the node's `keys` signal so a structural
    // add/delete re-runs iterators (For over Object.keys, spreads, etc.).
    const node = rawToNode.get(raw)!
    if (node.keys === null) node.keys = signal<unknown>(undefined, { equals: false })
    node.keys[0]()
    return Reflect.ownKeys(raw)
  },

  // The proxy is read-only through property access; all writes go through the
  // path-based setter. A direct `state.x = 1` is a programming error.
  set() {
    throw new Error(
      'coyote/store: a store is read-only through property access; use the setter ' +
        '(the second element of createStore) — set("x", value) or set({ x: value }).',
    )
  },
  deleteProperty() {
    throw new Error(
      'coyote/store: cannot delete a property through the proxy; use the setter with ' +
        'an `undefined` value or reconcile().',
    )
  },
}

/** Wrap a raw object in a tracking proxy, memoized by object identity. */
function wrap<T extends object>(raw: T): Store<T> {
  const existing = rawToProxy.get(raw)
  if (existing !== undefined) return existing as Store<T>

  rawToNode.set(raw, {
    raw: raw as Record<PropertyKey, unknown>,
    signals: new Map(),
    keys: null,
  })
  const proxy = new Proxy(raw as Record<PropertyKey, unknown>, proxyHandler) as Store<T>
  rawToProxy.set(raw, proxy)
  return proxy
}

/** Extract the raw object behind a store proxy (identity for object diffing). */
function unwrap<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const raw = (value as Record<PropertyKey, unknown>)[RAW]
    if (raw !== undefined) return raw as T
  }
  return value
}

/** The internal StoreNode for a raw object, creating its proxy lazily. */
function nodeFor(raw: object): StoreNode {
  wrap(raw)
  return rawToNode.get(raw)!
}

// Assign `value` at `key` on `node`, updating the raw object and notifying the
// property's signal (and, on structural add/delete, the enumeration signal).
function setKey(node: StoreNode, key: PropertyKey, value: unknown): void {
  const raw = unwrap(value)
  const had = Object.prototype.hasOwnProperty.call(node.raw, key)
  const prev = node.raw[key]
  if (had && Object.is(prev, raw)) return // no-op: identical value

  const lengthBefore = Array.isArray(node.raw) ? node.raw.length : -1

  if (raw === undefined && had) {
    delete node.raw[key]
  } else {
    node.raw[key] = raw
  }

  // Notify the leaf signal (creating it if a reader subscribed before any write).
  nodeSignal(node, key)[1](raw)

  // Structural change (add/delete, or array length shift) re-runs enumeration
  // and any `.length` reader.
  const isAdd = !had
  const isDelete = raw === undefined && had
  if (isAdd || isDelete) {
    if (node.keys !== null) node.keys[1](undefined)
  }
  if (lengthBefore !== -1 && node.raw.length !== lengthBefore) {
    nodeSignal(node, 'length')[1](node.raw.length)
    if (node.keys !== null) node.keys[1](undefined)
  }
}

// ── setter transformers (produce / reconcile) ────────────────────────────────

const TRANSFORMER = Symbol('coyote.store.transformer')

// A transformer is a function branded with a node-aware applier. When the setter
// sees one at a path, it hands the applier the target StoreNode + key so the
// mutation fans out into per-leaf signal notifications, rather than being applied
// as an opaque value replacement.
interface Transformer {
  [TRANSFORMER]: (node: StoreNode, key: PropertyKey | null) => void
}

function isTransformer(v: unknown): v is Transformer {
  return typeof v === 'function' && TRANSFORMER in (v as object)
}

function makeTransformer(
  apply: (node: StoreNode, key: PropertyKey | null) => void,
): (state: never) => never {
  const fn = (() => {
    throw new Error('coyote/store: a produce/reconcile transformer must be passed to the setter.')
  }) as unknown as Transformer & ((state: never) => never)
  fn[TRANSFORMER] = apply
  return fn
}

// Resolve the raw value a transformer targets: either a keyed property of a
// parent node, or the node's own raw object (root form).
function targetRaw(node: StoreNode, key: PropertyKey | null): unknown {
  return key === null ? node.raw : node.raw[key]
}

// Walk `path` from the store root, applying the final segment(s) as a write.
// Mirrors Solid's setter overloads:
//   set(value)                  — replace/merge at the root, or apply a transformer
//   set('a', value)             — set a leaf/subtree, or apply a transformer at 'a'
//   set('a', 'b', value)        — nested set / transformer
//   set('a', updaterFn)         — functional update of the current value
function setPath(root: StoreNode, args: unknown[]): void {
  if (args.length === 0) return

  // Zero-path form: a transformer applies at the root; otherwise merge a partial
  // (or apply a functional update returning a partial to merge).
  if (args.length === 1) {
    const [only] = args
    if (isTransformer(only)) {
      only[TRANSFORMER](root, null)
      return
    }
    const next = typeof only === 'function' ? (only as (s: unknown) => unknown)(root.raw) : only
    mergeInto(root, next)
    return
  }

  const value = args[args.length - 1]
  const path = args.slice(0, -1)

  // Descend to the parent node of the final key.
  let node = root
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as PropertyKey
    const childRaw = node.raw[key]
    if (!isWrappable(childRaw)) {
      throw new Error(
        `coyote/store: setter path segment ${String(key)} is not an object; ` +
          'cannot descend into a leaf value.',
      )
    }
    node = nodeFor(childRaw)
  }

  const lastKey = path[path.length - 1] as PropertyKey

  // A transformer at the final key applies against the parent node + key.
  if (isTransformer(value)) {
    value[TRANSFORMER](node, lastKey)
    return
  }

  const current = node.raw[lastKey]
  const resolved =
    typeof value === 'function' ? (value as (s: unknown) => unknown)(current) : value
  setKey(node, lastKey, resolved)
}

// Merge a partial object into a node (root-level `set(partial)`), setting each
// provided key through setKey so every touched property notifies individually.
function mergeInto(node: StoreNode, next: unknown): void {
  if (!isWrappable(next)) {
    throw new Error(
      'coyote/store: set(partial) expects an object to merge; got ' + typeof next + '.',
    )
  }
  for (const key of Object.keys(next)) {
    setKey(node, key, (next as Record<PropertyKey, unknown>)[key])
  }
}

/**
 * Create a fine-grained reactive store.
 *
 * Returns `[state, set]`: `state` is a deep read-tracked proxy over `init`, and
 * `set` is a path-based, fine-grained setter. Writes are batched so a multi-key
 * update re-runs each dependent effect at most once.
 */
export function createStore<T extends object>(init: T): [get: Store<T>, set: SetStoreFunction<T>] {
  const proxy = wrap(init)
  const rootNode = nodeFor(init)

  const set = ((...args: unknown[]) => {
    batch(() => setPath(rootNode, args))
  }) as SetStoreFunction<T>

  return [proxy, set]
}

/**
 * Build a state transformer from an in-place mutator. Pass its result to the
 * setter: `set(produce(s => { s.count++ }))` or `set('sub', produce(...))`.
 *
 * The mutator runs (untracked — a producer must not subscribe the calling
 * effect) against a plain mutable draft that IS the raw target. Its resulting
 * shape is then diffed back key-by-key so only the touched top-level keys of the
 * target notify. Reads/writes go through the raw object, so nested mutations
 * (`s.items.push(x)`) are visible; the enclosing key's readers re-run.
 */
export function produce<T>(mutator: (draft: T) => void): (state: T) => T {
  return makeTransformer((node, key) => {
    const before = targetRaw(node, key)
    if (!isWrappable(before)) {
      throw new Error('coyote/store: produce() targets an object; the current value is a leaf.')
    }
    const lengthBefore = Array.isArray(before) ? before.length : -1
    // Snapshot top-level keys/values so we can detect what the mutator changed.
    const snapshot = new Map<PropertyKey, unknown>()
    for (const k of Object.keys(before)) snapshot.set(k, before[k])

    untrack(() => mutator(before as unknown as T))

    const targetNode = key === null ? node : nodeFor(before)
    // Keys the mutator added or changed (bump enumeration on an add).
    for (const k of Object.keys(before)) {
      if (!snapshot.has(k)) {
        nodeSignal(targetNode, k)[1](before[k])
        if (targetNode.keys !== null) targetNode.keys[1](undefined)
      } else if (!Object.is(snapshot.get(k), before[k])) {
        nodeSignal(targetNode, k)[1](before[k])
      }
    }
    // Keys the mutator removed.
    for (const k of snapshot.keys()) {
      if (!Object.prototype.hasOwnProperty.call(before, k)) {
        nodeSignal(targetNode, k)[1](undefined)
        if (targetNode.keys !== null) targetNode.keys[1](undefined)
      }
    }
    // Array length may have shifted (push/pop/splice).
    if (lengthBefore !== -1 && before.length !== lengthBefore) {
      nodeSignal(targetNode, 'length')[1](before.length)
      if (targetNode.keys !== null) targetNode.keys[1](undefined)
    }
  }) as unknown as (state: T) => T
}

/**
 * Build a state transformer that reconciles `next` into the current value,
 * preserving referential identity where the `key` field matches so downstream
 * fine-grained readers only see the fields that actually changed.
 *
 * Diffs object/array values recursively; array elements are matched by
 * `options.key` (default `'id'`) so a reordered/replaced list keeps unchanged
 * elements stable. Only the leaves that truly changed notify.
 */
export function reconcile<T>(next: T, options?: { key?: string }): (state: T) => T {
  const key = options?.key ?? 'id'
  return makeTransformer((node, targetKey) => {
    const prev = targetRaw(node, targetKey)
    const rawNext = unwrap(next)
    if (!isWrappable(prev) || !isWrappable(rawNext)) {
      // Leaf or type change: replace wholesale through the normal setter path.
      if (targetKey === null) {
        throw new Error('coyote/store: reconcile at the root requires an object value.')
      }
      setKey(node, targetKey, rawNext)
      return
    }
    const targetNode = targetKey === null ? node : nodeFor(prev)
    reconcileNode(targetNode, rawNext, key)
  }) as unknown as (state: T) => T
}

// Reconcile `next` into `node.raw` in place, firing a leaf signal only where a
// value actually changed. Recurses into wrappable children.
function reconcileNode(node: StoreNode, next: Record<PropertyKey, unknown>, key: string): void {
  const prev = node.raw

  if (Array.isArray(prev) && Array.isArray(next)) {
    reconcileArray(node, prev, next, key)
    return
  }

  // Delete keys absent from `next`.
  for (const k of Object.keys(prev)) {
    if (!(k in next)) {
      delete prev[k]
      nodeSignal(node, k)[1](undefined)
      if (node.keys !== null) node.keys[1](undefined)
    }
  }
  // Add/update keys from `next`.
  for (const k of Object.keys(next)) {
    const had = Object.prototype.hasOwnProperty.call(prev, k)
    const pv = prev[k]
    const nv = next[k]
    if (isWrappable(pv) && isWrappable(nv)) {
      // Recurse to preserve identity of unchanged descendants.
      reconcileNode(nodeFor(pv), nv, key)
      continue
    }
    if (!had || !Object.is(pv, nv)) {
      prev[k] = nv
      nodeSignal(node, k)[1](nv)
      if (!had && node.keys !== null) node.keys[1](undefined)
    }
  }
}

// Reconcile arrays element-wise, matching object elements by `key` to preserve
// identity across reorders/insertions.
function reconcileArray(
  node: StoreNode,
  prev: unknown[],
  next: unknown[],
  key: string,
): void {
  const prevByKey = new Map<unknown, unknown>()
  for (const item of prev) {
    if (isWrappable(item) && key in item) prevByKey.set(item[key], item)
  }

  const lengthBefore = prev.length
  for (let i = 0; i < next.length; i++) {
    const nv = next[i]
    const match =
      isWrappable(nv) && key in nv ? (prevByKey.get(nv[key]) ?? prev[i]) : prev[i]
    if (isWrappable(match) && isWrappable(nv)) {
      // Same identity slot: reconcile into it, keeping unchanged fields stable.
      if (!Object.is(prev[i], match)) {
        prev[i] = match
        nodeSignal(node, i)[1](match)
      }
      reconcileNode(nodeFor(match), nv, key)
    } else if (!Object.is(prev[i], nv)) {
      prev[i] = nv
      nodeSignal(node, i)[1](nv)
    }
  }
  // Trim any trailing elements the new array dropped.
  if (next.length < lengthBefore) {
    for (let i = next.length; i < lengthBefore; i++) {
      nodeSignal(node, i)[1](undefined)
    }
    prev.length = next.length
  }
  if (prev.length !== lengthBefore) {
    nodeSignal(node, 'length')[1](prev.length)
    if (node.keys !== null) node.keys[1](undefined)
  }
}

// ── defineStore / useStore ────────────────────────────────────────────────────

// Module-level singleton cache, keyed by `id`. A store defined with a given id
// is created once and shared across every call site for the life of the module
// (the Pinia-style app-wide singleton).
const storeRegistry = new Map<string, unknown>()

/**
 * Define a memoized singleton store (the Pinia replacement).
 *
 * `setup()` runs at most once — the first time the returned accessor is called —
 * and must return `{ state, actions }`. Every subsequent call returns the same
 * `StoreApi` instance. `state` is typically a store proxy (from `createStore`)
 * or any reactive object; `actions` are the methods that mutate it.
 */
export function defineStore<S extends object, A extends Record<string, (...a: any[]) => any>>(
  id: string,
  setup: () => { state: S; actions: A },
): () => StoreApi<S, A> {
  return () => {
    let api = storeRegistry.get(id) as StoreApi<S, A> | undefined
    if (api === undefined) {
      const { state, actions } = setup()
      api = { state, actions }
      storeRegistry.set(id, api)
    }
    return api
  }
}

// Anonymous-factory memoization: each distinct factory function is invoked once
// and its result cached against the function identity.
const factoryRegistry = new WeakMap<() => unknown, unknown>()

/**
 * Memoize a singleton produced by `factory`. Unlike `defineStore` this is keyed
 * by the factory function's identity, so a module-level factory yields one shared
 * instance across all callers.
 */
export function useStore<T>(factory: () => T): T {
  if (factoryRegistry.has(factory)) {
    return factoryRegistry.get(factory) as T
  }
  const value = factory()
  factoryRegistry.set(factory, value)
  return value
}

/**
 * Test-only: clear the `defineStore` id registry so each test starts with fresh
 * singletons. Not part of the public contract.
 */
export function __resetStoresForTests(): void {
  storeRegistry.clear()
}

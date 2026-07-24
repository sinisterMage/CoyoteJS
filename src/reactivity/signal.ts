import type { Accessor, Setter, Signal, SignalOptions } from './types'
import {
  createNode,
  currentObserver,
  defaultEquals,
  markObservers,
  scheduleFlush,
  STALE,
  track,
  type Node,
} from './core'

/**
 * Create a reactive signal — a `[get, set]` tuple.
 *
 * Reads inside a tracking scope (effect/computed) subscribe the reader. Writes
 * are equality-gated (default `Object.is`; `equals: false` always notifies;
 * a custom `equals` can suppress notification) and schedule an effect flush.
 */
export function signal<T>(value: T, opts?: SignalOptions<T>): Signal<T>
export function signal<T>(): Signal<T | undefined>
export function signal<T>(value?: T, opts?: SignalOptions<T>): Signal<T | undefined> {
  const equals =
    opts?.equals === false
      ? () => false // never equal ⇒ every write notifies
      : (opts?.equals ?? defaultEquals)

  const node = createNode<T | undefined>(
    value,
    null, // no derivation fn: this is a source
    equals as (a: T | undefined, b: T | undefined) => boolean,
    false,
    null, // signals aren't owned; they live as long as their references
    opts?.name,
  )

  const get: Accessor<T | undefined> = () => readSignal(node)
  const set = ((next) => writeSignal(node, next)) as Setter<T | undefined>

  return [get, set]
}

/** Read a signal/source node, subscribing the current observer if any. */
export function readSignal<T>(node: Node<T>): T {
  if (currentObserver !== null) {
    track(node as unknown as Node<unknown>, currentObserver)
  }
  return node.value as T
}

/**
 * Write a source node. Accepts a value or an updater `(prev) => next`. Returns
 * the stored value. A no-op (equal) write neither stores nor notifies.
 */
export function writeSignal<T>(node: Node<T>, next: T | ((prev: T) => T)): T {
  const value =
    typeof next === 'function' ? (next as (prev: T) => T)(node.value as T) : (next as T)

  if (node.equals(node.value as T, value)) {
    return node.value as T
  }

  node.value = value
  markObservers(node as unknown as Node<unknown>, STALE)
  scheduleFlush()
  return value
}

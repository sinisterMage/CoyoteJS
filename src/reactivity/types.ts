// Public type surface for coyote/reactivity. These are the canonical public
// types of the reactive core; the implementation files and the barrel import
// from here.

/** A reactive read accessor: calling it in a tracking scope subscribes. */
export type Accessor<T> = () => T
/** A signal write: a value or an updater `(prev) => next`. Returns the stored value. */
export type Setter<T> = (v: T | ((prev: T) => T)) => T
/** The `[get, set]` tuple returned by `signal`. */
export type Signal<T> = [get: Accessor<T>, set: Setter<T>]

export interface SignalOptions<T> {
  /** Custom change test; default Object.is. `false` disables equality (always notify). */
  equals?: false | ((a: T, b: T) => boolean)
  name?: string
}
export interface EffectOptions {
  name?: string
  /** Skip the immediate first run; only react to subsequent changes. */
  defer?: boolean
}

/** Opaque disposal scope. */
export interface Owner {
  readonly __coyote: 'owner'
}

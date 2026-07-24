// Public type surface for coyote/worker.

export type StreamYield<T> = AsyncIterable<T>

/** Every method becomes a Promise; async-generator methods stream (async-iterable + Promise). */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => AsyncGenerator<infer Y, infer R, any>
    ? (...a: A) => AsyncIterable<Y> & Promise<R>
    : T[K] extends (...a: infer A) => infer R
      ? (...a: A) => Promise<Awaited<R>>
      : never
}

export interface SpawnOptions {
  name?: string
  type?: 'module'
  credentials?: RequestCredentials
}

export interface PoolOptions extends SpawnOptions {
  size?: number
}

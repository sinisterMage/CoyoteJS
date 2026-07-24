// coyote/worker — main-thread RPC client over a single Worker (or Worker-like).
//
// `WorkerClient` owns one Worker, a monotonic id counter, and one table of
// in-flight invocations keyed by that id. `spawn` wraps it in a typed Proxy;
// `pool` fans several clients out round-robin.
//
// Every method call goes through `invoke(method, args)`, which returns a single
// handle that is BOTH a Promise and an async-iterable. Whether the remote
// method is a normal function or an async generator is not known on the main
// thread — the handle simply adapts to whichever frames come back for its id:
//
//   normal method:   {id, ok, result}                   → await resolves result;
//                                                          iterating yields none.
//   async generator: {id, chunk}… then {id, done, result}→ await resolves the
//                                                          return value; iterating
//                                                          yields each chunk.
//   error (either):  {id, ok:false, error} | {id, error} → await rejects; an
//                                                          active iterator throws.
//
// This keeps the typed proxy uniform: it never has to guess a method's shape,
// and the frozen `Remote<T>` types stay accurate for both call styles.

import {
  isRpcChunk,
  isRpcResult,
  isRpcStreamDone,
  isRpcStreamError,
  type RpcRequest,
} from './rpc'
import { collectTransferables } from './transfer'

// The Worker surface we actually use — lets tests substitute a MessageChannel
// bridge that is not a real Worker (jsdom has no Worker).
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((ev: MessageEvent) => void) | null
  onmessageerror?: ((ev: MessageEvent) => void) | null
}

// The value a method call returns: awaitable (return value) AND iterable (chunks).
export type InvokeHandle = AsyncIterable<unknown> & Promise<unknown>

// Per-invocation state: routes incoming frames to a chunk buffer / waiters and
// settles the Promise face on done/error.
interface Invocation {
  push(chunk: unknown): void
  finish(result: unknown): void
  fail(reason: unknown): void
}

// Revive a wire error payload (from ./defineWorker toWireError) into an Error so
// the caller sees a real throwable with a stack; pass other payloads through.
// Only the {name, message, stack} triple produced by toWireError is treated as
// a serialized Error — any other object (including a caller's plain rejection
// value) passes through verbatim so no data is lost.
function fromWireError(payload: unknown): unknown {
  if (
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    'name' in payload &&
    'stack' in payload
  ) {
    const p = payload as { name?: unknown; message?: unknown; stack?: unknown }
    const err = new Error(typeof p.message === 'string' ? p.message : String(p.message))
    if (typeof p.name === 'string') err.name = p.name
    if (typeof p.stack === 'string') err.stack = p.stack
    return err
  }
  return payload
}

export class WorkerClient {
  private readonly worker: WorkerLike
  private nextId = 1
  private readonly invocations = new Map<number, Invocation>()
  private terminated = false

  /** Number of in-flight invocations (drives pool backpressure). */
  get inflight(): number {
    return this.invocations.size
  }

  constructor(worker: WorkerLike) {
    this.worker = worker
    worker.onmessage = (ev: MessageEvent) => this.onMessage(ev.data)
  }

  private onMessage(data: unknown): void {
    // Route by the most specific frame shape first (the ./rpc guards are
    // mutually exclusive: chunk / stream-done / stream-error / result).
    if (isRpcChunk(data)) {
      this.invocations.get(data.id)?.push(data.chunk)
      return
    }
    if (isRpcStreamDone(data)) {
      const inv = this.invocations.get(data.id)
      this.invocations.delete(data.id)
      inv?.finish(data.result)
      return
    }
    if (isRpcStreamError(data)) {
      const inv = this.invocations.get(data.id)
      this.invocations.delete(data.id)
      inv?.fail(fromWireError(data.error))
      return
    }
    if (isRpcResult(data)) {
      const inv = this.invocations.get(data.id)
      this.invocations.delete(data.id)
      if (data.ok) inv?.finish(data.result)
      else inv?.fail(fromWireError(data.error))
      return
    }
    // Unknown frame shape: ignore (forward-compatible with new response types).
  }

  private send(id: number, method: string, args: unknown[]): void {
    const req: RpcRequest = { id, method, args }
    // Transferables are auto-detected from the top-level args (+ explicit
    // transfer() marks) exactly like the worker side does for results/chunks.
    const transferables = collectTransferables(args)
    this.worker.postMessage(req, transferables.length ? transferables : undefined)
  }

  /**
   * Invoke a remote method. Returns a thenable async-iterable handle:
   *   - `await remote.m(...)`            resolves the return value, or
   *   - `for await (const c of remote.m(...))` yields streamed chunks.
   *
   * The request is posted eagerly, at call time — calling a remote method
   * dispatches the work (and counts toward `inflight`/pool load) whether or not
   * the returned handle is ever awaited. Replies buffer until consumed.
   */
  invoke(method: string, args: unknown[]): InvokeHandle {
    const id = this.nextId++
    return this.makeHandle(id, () => this.send(id, method, args))
  }

  private makeHandle(id: number, start: () => void): InvokeHandle {
    // Buffered chunks awaiting a consumer, and consumers awaiting a chunk. At
    // most one of the two is non-empty at a time.
    const chunkQueue: unknown[] = []
    const waiters: Array<{
      resolve(r: IteratorResult<unknown>): void
      reject(e: unknown): void
    }> = []
    let done = false
    let returnValue: unknown
    let failure: { error: unknown } | undefined

    // Promise face: resolves to the return value / rejects on error.
    let resolveReturn!: (v: unknown) => void
    let rejectReturn!: (e: unknown) => void
    const returnPromise = new Promise<unknown>((res, rej) => {
      resolveReturn = res
      rejectReturn = rej
    })
    // Never surface an unhandled rejection if the caller only iterates.
    returnPromise.catch(() => {})

    const drainWaiters = () => {
      while (waiters.length) {
        const w = waiters[0]
        if (chunkQueue.length) {
          waiters.shift()
          w.resolve({ value: chunkQueue.shift(), done: false })
        } else if (failure) {
          waiters.shift()
          w.reject(failure.error)
        } else if (done) {
          waiters.shift()
          w.resolve({ value: returnValue, done: true })
        } else {
          break // no data yet — leave the waiter queued
        }
      }
    }

    const inv: Invocation = {
      push: (chunk) => {
        chunkQueue.push(chunk)
        drainWaiters()
      },
      finish: (result) => {
        done = true
        returnValue = result
        resolveReturn(result)
        drainWaiters()
      },
      fail: (reason) => {
        failure = { error: reason }
        rejectReturn(reason)
        drainWaiters()
      },
    }

    // Dispatch eagerly: register the routing entry (so a reply can never race
    // ahead of it) and post the request now. If already terminated, fail fast.
    if (this.terminated) {
      inv.fail(new Error('coyote/worker: client terminated'))
    } else {
      this.invocations.set(id, inv)
      start()
    }

    const iterator: AsyncIterator<unknown> = {
      next: () => {
        return new Promise<IteratorResult<unknown>>((resolve, reject) => {
          if (chunkQueue.length) {
            resolve({ value: chunkQueue.shift(), done: false })
          } else if (failure) {
            reject(failure.error)
          } else if (done) {
            resolve({ value: returnValue, done: true })
          } else {
            waiters.push({ resolve, reject })
          }
        })
      },
      // Consumer abandoned the loop (`break`/`return`): stop delivering. The
      // in-flight request still settles the Promise face for anyone awaiting it.
      return: (value?: unknown) =>
        Promise.resolve({ value, done: true } as IteratorResult<unknown>),
    }

    const handle = {
      [Symbol.asyncIterator]: () => iterator,
      then: (
        onFulfilled?: ((v: unknown) => unknown) | null,
        onRejected?: ((e: unknown) => unknown) | null,
      ) => returnPromise.then(onFulfilled, onRejected),
      catch: (onRejected?: ((e: unknown) => unknown) | null) =>
        returnPromise.catch(onRejected),
      finally: (onFinally?: (() => void) | null) => returnPromise.finally(onFinally),
    }

    return handle as InvokeHandle
  }

  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    const err = new Error('coyote/worker: client terminated')
    for (const [id, inv] of this.invocations) {
      this.invocations.delete(id)
      inv.fail(err)
    }
    this.invocations.clear()
    this.worker.onmessage = null
    this.worker.terminate()
  }
}

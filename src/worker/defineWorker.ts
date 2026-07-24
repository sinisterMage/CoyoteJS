// coyote/worker — worker-side dispatcher.
//
// Call `defineWorker(api)` as the *only* top-level statement of a `*.worker.ts`
// entry. It wires `self.onmessage` to route each {id, method, args} request to
// `api[method]`, then replies on the wire protocol in ./rpc.ts:
//
//   - a normal return         → {id, ok:true, result}
//   - a thrown/rejected error  → {id, error}            (serialized message)
//   - an async-generator       → {id, chunk} per yield, then {id, done, result}
//                                 or {id, error} if it throws mid-stream
//
// The main-side idiom that pairs with this file:
//   () => new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })
// (emit ES module workers — e.g. Vite `worker: { format: 'es' }` — so imports work).

import {
  isAsyncGenerator,
  isRpcRequest,
  type RpcChunk,
  type RpcRequest,
  type RpcResultErr,
  type RpcResultOk,
  type RpcStreamDone,
  type RpcStreamError,
} from './rpc'
import { collectTransferables } from './transfer'

/** The subset of the worker global scope we depend on (kept DI-friendly for tests). */
export interface WorkerScope {
  onmessage: ((this: unknown, ev: MessageEvent) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

type AnyApi = Record<string, (...args: any[]) => any>

// Errors don't survive `structuredClone` as Error instances in a useful shape,
// so we normalize to a plain, cloneable payload. A real Error keeps its
// name/message/stack; anything else is passed through (it may itself be a
// cloneable value the caller wants verbatim).
function toWireError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return err
}

function post(scope: WorkerScope, message: unknown, values: readonly unknown[]): void {
  const transferables = collectTransferables(values)
  scope.postMessage(message, transferables.length ? transferables : undefined)
}

async function handleRequest(scope: WorkerScope, api: AnyApi, req: RpcRequest): Promise<void> {
  const { id, method, args } = req

  const fn = api[method]
  if (typeof fn !== 'function') {
    const reply: RpcResultErr = {
      id,
      ok: false,
      error: toWireError(new TypeError(`coyote/worker: no such method "${method}"`)),
    }
    post(scope, reply, [])
    return
  }

  let returned: unknown
  try {
    returned = fn(...args)
  } catch (err) {
    post(scope, { id, ok: false, error: toWireError(err) } satisfies RpcResultErr, [])
    return
  }

  // A synchronously-returned async iterator streams; everything else (including
  // Promises of iterators are NOT auto-detected — a method that *returns* a
  // promise resolving to an iterator settles as a plain value) is awaited.
  if (isAsyncGenerator(returned)) {
    await streamGenerator(scope, id, returned)
    return
  }

  try {
    const result = await returned
    post(scope, { id, ok: true, result } satisfies RpcResultOk, [result])
  } catch (err) {
    post(scope, { id, ok: false, error: toWireError(err) } satisfies RpcResultErr, [])
  }
}

async function streamGenerator(
  scope: WorkerScope,
  id: number,
  gen: AsyncGenerator<unknown, unknown, unknown>,
): Promise<void> {
  try {
    let step = await gen.next()
    while (!step.done) {
      post(scope, { id, chunk: step.value } satisfies RpcChunk, [step.value])
      step = await gen.next()
    }
    post(scope, { id, done: true, result: step.value } satisfies RpcStreamDone, [step.value])
  } catch (err) {
    post(scope, { id, error: toWireError(err) } satisfies RpcStreamError, [])
  }
}

/**
 * Worker-side: expose `api` over the coyote RPC protocol. Installs a single
 * `onmessage` handler; safe to call exactly once per worker entry.
 *
 * `scope` defaults to the worker global (`self`); tests inject a fake scope
 * (e.g. a `MessagePort`-backed shim) to exercise dispatch without a real Worker.
 */
export function defineWorker<T extends AnyApi>(api: T, scope: WorkerScope = self as unknown as WorkerScope): void {
  scope.onmessage = (ev: MessageEvent) => {
    const data = ev.data
    if (!isRpcRequest(data)) return
    // Fire-and-forget: each request settles independently (errors are reported
    // on the wire, never as unhandled rejections).
    void handleRequest(scope, api, data)
  }
}

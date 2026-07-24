// coyote/worker — the wire protocol shared by the main-thread proxy (spawn/pool)
// and the worker-side dispatcher (defineWorker).
//
// Every call carries a monotonic `id` that correlates request → response(s). A
// call is one of two shapes on the wire:
//
//   normal method    request {id, method, args}
//                     reply   {id, ok:true, result} | {id, ok:false, error}
//
//   async generator   request {id, method, args}
//                     frames  {id, chunk} …           (one per `yield`)
//                     end     {id, done:true, result} (generator return value)
//                             {id, error}             (threw mid-stream)
//
// The two response families are distinguished structurally so a single
// `onmessage` on each side can route them. There is no ambiguity: a request has
// `method`, a normal reply has `ok`, a stream chunk has `chunk`, a stream end
// has `done`, and a stream error has `error` without `ok`.

/** Main → worker: invoke `api[method](...args)` under correlation `id`. */
export interface RpcRequest {
  id: number
  method: string
  args: unknown[]
}

/** Worker → main: a normal (non-generator) method settled. */
export interface RpcResultOk {
  id: number
  ok: true
  result: unknown
}
export interface RpcResultErr {
  id: number
  ok: false
  error: unknown
}
export type RpcResult = RpcResultOk | RpcResultErr

/** Worker → main: one value yielded by an async-generator method. */
export interface RpcChunk {
  id: number
  chunk: unknown
}

/** Worker → main: an async-generator method returned (stream complete). */
export interface RpcStreamDone {
  id: number
  done: true
  result: unknown
}

/** Worker → main: an async-generator method threw mid-stream. */
export interface RpcStreamError {
  id: number
  error: unknown
}

export type RpcResponse = RpcResult | RpcChunk | RpcStreamDone | RpcStreamError

// ---- structural guards (used by both sides) --------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function isRpcRequest(v: unknown): v is RpcRequest {
  return isObj(v) && typeof v.id === 'number' && typeof v.method === 'string' && Array.isArray(v.args)
}

export function isRpcResult(v: unknown): v is RpcResult {
  return isObj(v) && typeof v.id === 'number' && typeof v.ok === 'boolean'
}

export function isRpcChunk(v: unknown): v is RpcChunk {
  return isObj(v) && typeof v.id === 'number' && 'chunk' in v && !('ok' in v)
}

export function isRpcStreamDone(v: unknown): v is RpcStreamDone {
  return isObj(v) && typeof v.id === 'number' && v.done === true
}

export function isRpcStreamError(v: unknown): v is RpcStreamError {
  return isObj(v) && typeof v.id === 'number' && 'error' in v && !('ok' in v) && v.done !== true
}

// An async function tagged by JS as `AsyncGeneratorFunction`. Method calls
// whose *return* is an async iterator are also treated as streaming (covers
// both `async function*` and hand-rolled async-iterable returns).
export function isAsyncGenerator(v: unknown): v is AsyncGenerator<unknown, unknown, unknown> {
  return (
    isObj(v) &&
    typeof (v as { next?: unknown }).next === 'function' &&
    typeof (v as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function'
  )
}

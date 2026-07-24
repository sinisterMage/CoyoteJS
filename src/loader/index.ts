// coyote-js/loader — a small, generic, worker-first WASM loader.
//
//   const { handle, done } = loadWasm({ wasmUrl: '/app.wasm', dataUrl: '/data.bin' })
//   effect(() => setProgress(handle.progress.percent()))   // reactive UI
//   const { module, data } = await done                    // compiled + bytes
//
// Given a `wasmUrl` and/or a `dataUrl`, it fires both network requests AT ONCE,
// compiles the WASM *while it streams* (WebAssembly.compileStreaming), and reads
// the data URL into a Uint8Array in parallel. Callers read reactive `progress`
// signals immediately and await ONE `done` promise — no nested `.then` chains.
//
// Zero coupling: no framework/app/format knowledge, only `../reactivity` for the
// progress signals. `loadGame` is a thin alias for callers who prefer that name.

import { batch, signal, type Accessor } from '../reactivity'

export type LoadPhase = 'idle' | 'fetching' | 'compiling' | 'ready' | 'error'

export interface LoadProgress {
  phase: Accessor<LoadPhase>
  percent: Accessor<number>
  error: Accessor<unknown>
}

export interface LoadWasmOptions {
  /** URL of the `.wasm` module to fetch + compile. */
  wasmUrl?: string
  /** URL of an optional companion data blob, read into a `Uint8Array`. */
  dataUrl?: string
  /** Abort both in-flight requests. */
  signal?: AbortSignal
}

export interface WasmHandle {
  module?: WebAssembly.Module
  data?: Uint8Array
  progress: LoadProgress
}

/** An abort raised through the caller's `AbortSignal`. */
class LoadAbortError extends Error {
  override name = 'LoadAbortError'
  constructor() {
    super('loadWasm aborted')
  }
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  return reason instanceof Error ? reason : new LoadAbortError()
}

/** Fetch a URL, throwing a descriptive error on a non-ok status. */
async function fetchOk(url: string, kind: string, signal?: AbortSignal): Promise<Response> {
  const resp = await fetch(url, { signal, cache: 'no-cache' })
  if (!resp.ok) throw new Error(`Failed to load ${kind} (${resp.status}) from ${url}`)
  return resp
}

/** Compile the wasm module from a fetched response (streaming when the type allows). */
async function compileWasm(resp: Response): Promise<WebAssembly.Module> {
  // compileStreaming needs an `application/wasm` content-type; when a dev server
  // (or a mocked fetch) omits it, buffer once and compile. Call through the
  // `WebAssembly` namespace so the impl keeps its `this` binding.
  const contentType = resp.headers?.get?.('content-type') ?? ''
  if (WebAssembly.compileStreaming && contentType.includes('application/wasm')) {
    return WebAssembly.compileStreaming(resp)
  }
  return WebAssembly.compile(await resp.arrayBuffer())
}

/**
 * Load a WASM module and/or a companion data blob in parallel.
 *
 * @returns `{ handle, done }` — `handle.progress` exposes reactive phase/percent
 *   signals immediately; `done` resolves with the populated handle once ready,
 *   or rejects on any fetch/compile failure or abort.
 */
export function loadWasm(opts: LoadWasmOptions): { handle: WasmHandle; done: Promise<WasmHandle> } {
  const { wasmUrl, dataUrl, signal: abortSignal } = opts

  const [phase, setPhase] = signal<LoadPhase>('idle')
  const [percent, setPercent] = signal(0, { equals: false })
  const [error, setError] = signal<unknown>(undefined)

  const progress: LoadProgress = { phase, percent, error }
  const handle: WasmHandle = { progress }

  const set = (p: LoadPhase, pct: number) =>
    batch(() => {
      setPhase(p)
      setPercent(pct)
    })

  const fail = (err: unknown): never => {
    batch(() => {
      setError(err)
      setPhase('error')
    })
    throw err
  }

  async function run(): Promise<WasmHandle> {
    if (abortSignal?.aborted) return fail(abortError(abortSignal))
    set('fetching', 5)

    // Fire both network requests at once; each resolves independently.
    const wasmResp = wasmUrl
      ? fetchOk(wasmUrl, 'wasm', abortSignal)
      : Promise.resolve<Response | undefined>(undefined)
    const dataResp = dataUrl
      ? fetchOk(dataUrl, 'data', abortSignal)
      : Promise.resolve<Response | undefined>(undefined)

    // If one request fails first, `Promise.all` rejects immediately; attach a
    // no-op catch to each so the loser's later rejection can't surface as an
    // unhandled promise rejection.
    void wasmResp.catch(() => {})
    void dataResp.catch(() => {})

    // Await the responses, then compile the wasm while reading the data bytes —
    // both in parallel again. `Promise.all` rejects on the first failure.
    let module: WebAssembly.Module | undefined
    let data: Uint8Array | undefined
    try {
      const [wasm, blob] = await Promise.all([wasmResp, dataResp])
      set('compiling', 50)
      ;[module, data] = await Promise.all([
        wasm ? compileWasm(wasm) : undefined,
        blob ? blob.arrayBuffer().then((b) => new Uint8Array(b)) : undefined,
      ])
    } catch (err) {
      return fail(err)
    }
    if (abortSignal?.aborted) return fail(abortError(abortSignal))

    handle.module = module
    handle.data = data
    set('ready', 100)
    return handle
  }

  return { handle, done: run() }
}

/** Alias for callers who prefer the `loadGame` name. */
export const loadGame = loadWasm

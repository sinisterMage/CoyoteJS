import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadWasm, loadGame } from './index'

// --- test doubles ------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>
// A sentinel value the mocked WebAssembly.compile* returns as the "module".
const FAKE_MODULE = { __fake: 'module' } as unknown as WebAssembly.Module

/** A minimal Response-like: controllable ok/status/content-type + bytes. */
function bytesResponse(
  bytes: ArrayBuffer,
  init: { ok?: boolean; status?: number; contentType?: string } = {},
): Response {
  const status = init.status ?? 200
  const headers = new Headers()
  if (init.contentType) headers.set('content-type', init.contentType)
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    headers,
    arrayBuffer: () => Promise.resolve(bytes),
  } as unknown as Response
}

function ab(...vals: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(vals.length)
  new Uint8Array(buf).set(vals)
  return buf
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  // Stub the WebAssembly compile surface so no real module is needed.
  vi.spyOn(WebAssembly, 'compile').mockResolvedValue(FAKE_MODULE)
  vi.spyOn(WebAssembly, 'compileStreaming').mockResolvedValue(FAKE_MODULE)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// --- tests -------------------------------------------------------------------

describe('loadWasm — compile + data', () => {
  it('compiles the wasm module and returns it on the handle', async () => {
    fetchMock.mockResolvedValue(bytesResponse(ab(0, 97, 115, 109), { contentType: 'application/wasm' }))
    const { handle, done } = loadWasm({ wasmUrl: '/app.wasm' })
    const resolved = await done
    expect(resolved.module).toBe(FAKE_MODULE)
    expect(handle.module).toBe(FAKE_MODULE)
    expect(handle.data).toBeUndefined()
  })

  it('reads the data URL into a Uint8Array', async () => {
    fetchMock.mockResolvedValue(bytesResponse(ab(1, 2, 3)))
    const { done } = loadWasm({ dataUrl: '/data.bin' })
    const { data, module } = await done
    expect(module).toBeUndefined()
    expect(data).toBeInstanceOf(Uint8Array)
    expect(Array.from(data!)).toEqual([1, 2, 3])
  })

  it('fetches wasm and data IN PARALLEL when both URLs are given', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/app.wasm'
          ? bytesResponse(ab(0), { contentType: 'application/wasm' })
          : bytesResponse(ab(9, 8, 7)),
      ),
    )
    const { done } = loadWasm({ wasmUrl: '/app.wasm', dataUrl: '/data.bin' })
    const { module, data } = await done
    expect(module).toBe(FAKE_MODULE)
    expect(Array.from(data!)).toEqual([9, 8, 7])
    // Both requests were dispatched before either resolved (fired synchronously).
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/app.wasm', '/data.bin'])
  })

  it('resolves with an empty handle when neither URL is given', async () => {
    const { done } = loadWasm({})
    const { module, data } = await done
    expect(module).toBeUndefined()
    expect(data).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('loadWasm — streaming vs buffered compile', () => {
  it('uses compileStreaming when content-type is application/wasm', async () => {
    fetchMock.mockResolvedValue(bytesResponse(ab(0), { contentType: 'application/wasm' }))
    await loadWasm({ wasmUrl: '/app.wasm' }).done
    expect(WebAssembly.compileStreaming).toHaveBeenCalledTimes(1)
    expect(WebAssembly.compile).not.toHaveBeenCalled()
  })

  it('falls back to buffered compile when content-type is missing', async () => {
    fetchMock.mockResolvedValue(bytesResponse(ab(0, 1, 2)))
    await loadWasm({ wasmUrl: '/app.wasm' }).done
    expect(WebAssembly.compile).toHaveBeenCalledTimes(1)
    expect(WebAssembly.compileStreaming).not.toHaveBeenCalled()
  })
})

describe('loadWasm — reactive progress', () => {
  it('exposes progress signals synchronously and drives phase to ready', async () => {
    fetchMock.mockResolvedValue(bytesResponse(ab(0), { contentType: 'application/wasm' }))
    const { handle, done } = loadWasm({ wasmUrl: '/app.wasm' })
    // Synchronous, pre-resolution: the loader has started fetching.
    expect(handle.progress.phase()).toBe('fetching')
    expect(handle.progress.percent()).toBeGreaterThan(0)
    await done
    expect(handle.progress.phase()).toBe('ready')
    expect(handle.progress.percent()).toBe(100)
    expect(handle.progress.error()).toBeUndefined()
  })
})

describe('loadWasm — errors', () => {
  it('rejects and sets phase=error / error signal on a non-ok wasm response', async () => {
    fetchMock.mockResolvedValue(bytesResponse(ab(0), { ok: false, status: 404 }))
    const { handle, done } = loadWasm({ wasmUrl: '/missing.wasm' })
    await expect(done).rejects.toThrow(/404/)
    expect(handle.progress.phase()).toBe('error')
    expect(handle.progress.error()).toBeInstanceOf(Error)
  })

  it('rejects when the data fetch fails, even if wasm would succeed', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/app.wasm'
          ? bytesResponse(ab(0), { contentType: 'application/wasm' })
          : bytesResponse(ab(0), { ok: false, status: 500 }),
      ),
    )
    const { handle, done } = loadWasm({ wasmUrl: '/app.wasm', dataUrl: '/data.bin' })
    await expect(done).rejects.toThrow(/500/)
    expect(handle.progress.phase()).toBe('error')
  })

  it('does not leak an unhandled rejection when one request fails while the other is pending', async () => {
    // wasm fails fast; data settles (rejecting) a tick later. Both promises must
    // be caught internally so the loser's late rejection is swallowed.
    fetchMock.mockImplementation((url: string) =>
      url === '/app.wasm'
        ? Promise.resolve(bytesResponse(ab(0), { ok: false, status: 404 }))
        : new Promise((_, reject) => setTimeout(() => reject(new Error('data network down')), 0)),
    )
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      const { done } = loadWasm({ wasmUrl: '/app.wasm', dataUrl: '/data.bin' })
      await expect(done).rejects.toThrow(/404/)
      // Let the still-pending data request reject on the next macrotask.
      await new Promise((r) => setTimeout(r, 5))
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('loadWasm — abort', () => {
  it('fails immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { handle, done } = loadWasm({ wasmUrl: '/app.wasm', signal: controller.signal })
    await expect(done).rejects.toBeInstanceOf(Error)
    expect(handle.progress.phase()).toBe('error')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('propagates the signal to fetch so an in-flight request can be aborted', async () => {
    fetchMock.mockResolvedValue(bytesResponse(ab(0), { contentType: 'application/wasm' }))
    const controller = new AbortController()
    await loadWasm({ wasmUrl: '/app.wasm', signal: controller.signal }).done
    expect(fetchMock).toHaveBeenCalledWith('/app.wasm', expect.objectContaining({ signal: controller.signal }))
  })
})

describe('loadGame alias', () => {
  it('is the same function as loadWasm', () => {
    expect(loadGame).toBe(loadWasm)
  })
})

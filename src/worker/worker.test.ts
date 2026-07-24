import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerClient, type WorkerLike } from './client'
import { defineWorker, type WorkerScope } from './defineWorker'
import { makeRemoteProxy, spawn } from './spawn'
import { pool } from './pool'
import { transfer, collectTransferables, consumeTransfer } from './transfer'
import type { Remote } from './types'

// ---------------------------------------------------------------------------
// Fake Worker: jsdom has MessageChannel but NO real Worker. This class bridges
// two MessagePorts — the "main" face implements WorkerLike (postMessage /
// onmessage / terminate), and the "worker" face is a WorkerScope that
// defineWorker binds to. Messages posted on one side arrive on the other,
// exactly like a real Worker boundary (async, structured-clone-ish via jsdom).
// ---------------------------------------------------------------------------
class FakeWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null
  onmessageerror: ((ev: MessageEvent) => void) | null = null
  private readonly mainPort: MessagePort
  private readonly workerPort: MessagePort
  private terminated = false

  /** The scope defineWorker(api, scope) binds to inside the "worker". */
  readonly scope: WorkerScope

  constructor() {
    const { port1, port2 } = new MessageChannel()
    this.mainPort = port1
    this.workerPort = port2

    // Main side: deliver worker→main frames to this.onmessage.
    this.mainPort.onmessage = (ev) => {
      if (this.terminated) return
      this.onmessage?.(ev as MessageEvent)
    }

    const workerPort = this.workerPort
    this.scope = {
      set onmessage(handler: ((ev: MessageEvent) => void) | null) {
        workerPort.onmessage = handler as ((ev: MessageEvent) => void) | null
      },
      get onmessage() {
        return workerPort.onmessage as ((ev: MessageEvent) => void) | null
      },
      postMessage(message: unknown, transferList?: Transferable[]) {
        workerPort.postMessage(message, transferList ?? [])
      },
    }

    this.mainPort.start()
    this.workerPort.start()
  }

  postMessage(message: unknown, transferList?: Transferable[]): void {
    if (this.terminated) return
    this.mainPort.postMessage(message, transferList ?? [])
  }

  terminate(): void {
    this.terminated = true
    this.mainPort.close()
    this.workerPort.close()
  }
}

// Build a client + a worker running `api`, wired through a FakeWorker.
function wire<T extends Record<string, (...a: any[]) => any>>(
  api: T,
): { remote: Remote<T> & { terminate(): void }; fake: FakeWorker } {
  const fake = new FakeWorker()
  defineWorker(api, fake.scope)
  const client = new WorkerClient(fake)
  const remote = makeRemoteProxy<T>(() => client, {
    terminate: () => client.terminate(),
  }) as Remote<T> & { terminate(): void }
  return { remote, fake }
}

// A pool needs several FakeWorkers; capture each one the factory creates.
function wirePool<T extends Record<string, (...a: any[]) => any>>(api: T, size: number) {
  const fakes: FakeWorker[] = []
  const p = pool<T>(
    () => {
      const fake = new FakeWorker()
      defineWorker(api, fake.scope)
      fakes.push(fake)
      return fake as unknown as Worker
    },
    { size },
  )
  return { p, fakes }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

// A representative API exercised across the suite.
const api = {
  add(a: number, b: number) {
    return a + b
  },
  async slowEcho(x: string) {
    await Promise.resolve()
    return `echo:${x}`
  },
  boom(): never {
    throw new Error('kaboom')
  },
  async rejects(): Promise<never> {
    return Promise.reject(new TypeError('nope'))
  },
  async rejectsValue(): Promise<never> {
    // A non-Error rejection value carrying extra data — must survive verbatim.
    return Promise.reject({ code: 418, message: 'teapot', detail: { a: 1 } })
  },
  async *count(n: number): AsyncGenerator<number, string, void> {
    for (let i = 0; i < n; i++) yield i
    return `done:${n}`
  },
  async *failStream(): AsyncGenerator<number, void, void> {
    yield 1
    yield 2
    throw new Error('mid-stream')
  },
  doubleBuffer(buf: ArrayBuffer): ArrayBuffer {
    const view = new Uint8Array(buf)
    for (let i = 0; i < view.length; i++) view[i] = view[i] * 2
    return buf
  },
}

describe('worker RPC — normal methods', () => {
  it('resolves a synchronous return', async () => {
    const { remote, fake } = wire(api)
    await expect(remote.add(2, 3)).resolves.toBe(5)
    fake.terminate()
  })

  it('resolves an async return', async () => {
    const { remote, fake } = wire(api)
    await expect(remote.slowEcho('hi')).resolves.toBe('echo:hi')
    fake.terminate()
  })

  it('correlates concurrent calls by id (out-of-order safe)', async () => {
    const { remote, fake } = wire(api)
    const results = await Promise.all([
      remote.add(1, 1),
      remote.slowEcho('a'),
      remote.add(10, 20),
      remote.slowEcho('b'),
    ])
    expect(results).toEqual([2, 'echo:a', 30, 'echo:b'])
    fake.terminate()
  })

  it('propagates a thrown error as a rejection with name+message', async () => {
    const { remote, fake } = wire(api)
    await expect(remote.boom()).rejects.toMatchObject({ message: 'kaboom' })
    fake.terminate()
  })

  it('propagates a rejected promise, preserving the error name', async () => {
    const { remote, fake } = wire(api)
    await expect(remote.rejects()).rejects.toMatchObject({
      name: 'TypeError',
      message: 'nope',
    })
    fake.terminate()
  })

  it('passes a non-Error rejection value through verbatim (no data loss)', async () => {
    const { remote, fake } = wire(api)
    await expect(remote.rejectsValue()).rejects.toEqual({
      code: 418,
      message: 'teapot',
      detail: { a: 1 },
    })
    fake.terminate()
  })

  it('rejects a call to an unknown method', async () => {
    const { remote, fake } = wire(api)
    // @ts-expect-error — method not on the API surface.
    await expect(remote.nope()).rejects.toThrow(/no such method/)
    fake.terminate()
  })
})

describe('worker RPC — async generators', () => {
  it('yields each chunk via for-await', async () => {
    const { remote, fake } = wire(api)
    const seen: number[] = []
    for await (const c of remote.count(3)) seen.push(c)
    expect(seen).toEqual([0, 1, 2])
    fake.terminate()
  })

  it('the handle is ALSO a Promise resolving to the generator return', async () => {
    const { remote, fake } = wire(api)
    const ret = await remote.count(4)
    expect(ret).toBe('done:4')
    fake.terminate()
  })

  it('can both iterate chunks and await the return on the same handle', async () => {
    const { remote, fake } = wire(api)
    const handle = remote.count(2)
    const seen: number[] = []
    for await (const c of handle) seen.push(c)
    const ret = await handle
    expect(seen).toEqual([0, 1])
    expect(ret).toBe('done:2')
    fake.terminate()
  })

  it('propagates a mid-stream throw to the iterator', async () => {
    const { remote, fake } = wire(api)
    const seen: number[] = []
    await expect(
      (async () => {
        for await (const c of remote.failStream()) seen.push(c)
      })(),
    ).rejects.toThrow('mid-stream')
    expect(seen).toEqual([1, 2])
    fake.terminate()
  })

  it('propagates a mid-stream throw to the Promise face', async () => {
    const { remote, fake } = wire(api)
    await expect(remote.failStream()).rejects.toThrow('mid-stream')
    fake.terminate()
  })
})

describe('transfer marking', () => {
  it('records transferables in a side-channel and returns the value unchanged', () => {
    const buf = new ArrayBuffer(8)
    const marked = transfer(buf, [buf])
    expect(marked).toBe(buf)
    expect(consumeTransfer(buf)).toEqual([buf])
    // consumed once
    expect(consumeTransfer(buf)).toBeUndefined()
  })

  it('is a no-op for primitives', () => {
    expect(transfer(42, [])).toBe(42)
    expect(consumeTransfer(42)).toBeUndefined()
  })

  it('auto-detects top-level ArrayBuffer args', () => {
    const buf = new ArrayBuffer(8)
    expect(collectTransferables([buf, 'x'])).toEqual([buf])
  })

  it('auto-detects the backing buffer of a typed-array arg', () => {
    const arr = new Uint8Array(8)
    expect(collectTransferables([arr])).toEqual([arr.buffer])
  })

  it('merges explicit marks with auto-detection and de-dupes', () => {
    const a = new ArrayBuffer(8)
    const b = new ArrayBuffer(8)
    const payload = transfer({ a, b }, [a, b])
    // `a` is also passed at top level → still appears once.
    const list = collectTransferables([payload, a])
    expect(list).toHaveLength(2)
    expect(list).toEqual(expect.arrayContaining([a, b]))
  })

  it('passes an auto-detected ArrayBuffer to the worker end-to-end', async () => {
    const { remote, fake } = wire(api)
    const buf = new Uint8Array([1, 2, 3]).buffer
    const out = await remote.doubleBuffer(buf)
    expect(Array.from(new Uint8Array(out))).toEqual([2, 4, 6])
    fake.terminate()
  })
})

describe('spawn', () => {
  it('returns a proxy whose terminate() rejects in-flight calls', async () => {
    const fake = new FakeWorker()
    // Never wire defineWorker → call will hang until terminate rejects it.
    const remote = spawn<typeof api>(() => fake as unknown as Worker)
    const p = remote.add(1, 2)
    remote.terminate()
    await expect(p).rejects.toThrow(/terminated/)
  })

  it('terminate() is not proxied as a remote method', () => {
    const fake = new FakeWorker()
    const terminate = vi.fn()
    const remote = makeRemoteProxy<typeof api>(
      () => new WorkerClient(fake),
      { terminate },
    ) as Remote<typeof api> & { terminate(): void }
    remote.terminate()
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('the proxy is not itself thenable (no accidental await deadlock)', async () => {
    const { remote, fake } = wire(api)
    const asAny = remote as unknown as { then?: unknown }
    expect(asAny.then).toBeUndefined()
    await expect(Promise.resolve(remote as any)).resolves.toBe(remote)
    fake.terminate()
  })

  it('returns a stable function reference per method name', () => {
    const { remote, fake } = wire(api)
    expect(remote.add).toBe(remote.add)
    fake.terminate()
  })
})

describe('pool', () => {
  it('spins up `size` workers and answers calls', async () => {
    const { p, fakes } = wirePool(api, 3)
    expect(fakes).toHaveLength(3)
    const out = await Promise.all([remoteCall(p, 1), remoteCall(p, 2), remoteCall(p, 3)])
    expect(out).toEqual([2, 4, 6])
    p.terminate()
  })

  it('reports `busy` while calls are in flight and 0 when idle', async () => {
    const { p } = wirePool(api, 2)
    expect(p.busy).toBe(0)
    const calls = [p.slowEcho('a'), p.slowEcho('b')]
    // Both dispatched synchronously → both workers busy.
    expect(p.busy).toBe(2)
    await Promise.all(calls)
    await flush()
    expect(p.busy).toBe(0)
    p.terminate()
  })

  it('load-balances to the least-busy worker', async () => {
    // size 2: two slow calls should land on distinct workers (busy === 2).
    const { p } = wirePool(api, 2)
    const c1 = p.slowEcho('x')
    const c2 = p.slowEcho('y')
    expect(p.busy).toBe(2)
    await Promise.all([c1, c2])
    p.terminate()
  })

  it('terminate() tears down every worker (in-flight calls reject)', async () => {
    const { p, fakes } = wirePool(api, 2)
    const spies = fakes.map((f) => vi.spyOn(f, 'terminate'))
    const stuck = p.slowEcho('z')
    p.terminate()
    await expect(stuck).rejects.toThrow(/terminated/)
    for (const s of spies) expect(s).toHaveBeenCalled()
  })

  it('streams through the pool too', async () => {
    const { p } = wirePool(api, 2)
    const seen: number[] = []
    for await (const c of p.count(3)) seen.push(c)
    expect(seen).toEqual([0, 1, 2])
    p.terminate()
  })
})

// Helper: pool proxy typed loosely for the numeric add call.
function remoteCall(p: Remote<typeof api>, n: number): Promise<number> {
  return p.add(n, n)
}

describe('defineWorker dispatch (direct scope)', () => {
  it('ignores non-RPC messages without throwing', async () => {
    const fake = new FakeWorker()
    defineWorker(api, fake.scope)
    const posted: unknown[] = []
    fake.onmessage = (ev) => posted.push(ev.data)
    // A frame missing `method` is not an RpcRequest → no reply.
    fake.postMessage({ id: 99, foo: 'bar' })
    await flush()
    expect(posted).toEqual([])
    fake.terminate()
  })

  it('does not leak an unhandled rejection for a thrown method', async () => {
    const rejections: unknown[] = []
    const onRej = (e: PromiseRejectionEvent) => rejections.push(e.reason)
    // jsdom surfaces unhandledrejection on window.
    window.addEventListener('unhandledrejection', onRej)
    const { remote, fake } = wire(api)
    await remote.boom().catch(() => {})
    await flush()
    window.removeEventListener('unhandledrejection', onRej)
    expect(rejections).toEqual([])
    fake.terminate()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

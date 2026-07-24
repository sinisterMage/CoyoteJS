import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHttp, isSignedOutError } from './index'
import type { HttpError } from './index'

// A single mockable fetch installed on the global. Each test sets the response.
let fetchMock: ReturnType<typeof vi.fn>

// Build a Response-like object with json/text/headers/ok — enough for the
// client's parseBody + status handling, without depending on a real Response.
function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string; contentType?: string } = {},
): Response {
  const status = init.status ?? 200
  const text = body === undefined ? '' : JSON.stringify(body)
  const headers = new Headers()
  if (init.contentType !== null) {
    headers.set('content-type', init.contentType ?? 'application/json')
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? '',
    headers,
    text: () => Promise.resolve(text),
  } as unknown as Response
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Convenience: the URL and RequestInit the client passed to fetch.
function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1)
  if (!call) throw new Error('fetch was not called')
  return call as [string, RequestInit]
}
function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name)
}

describe('createHttp — URL + baseURL', () => {
  it('prefixes baseURL onto a relative path', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))
    const api = createHttp({ baseURL: 'https://api.test' })
    await api('/users/1')
    expect(lastCall()[0]).toBe('https://api.test/users/1')
  })

  it('does not duplicate a slash at the base/path boundary', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test/' })
    await api('/users/1')
    expect(lastCall()[0]).toBe('https://api.test/users/1')
  })

  it('adds a boundary slash when the path has none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test' })
    await api('users/1')
    expect(lastCall()[0]).toBe('https://api.test/users/1')
  })

  it('lets an absolute URL path override the baseURL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test' })
    await api('https://other.test/thing')
    expect(lastCall()[0]).toBe('https://other.test/thing')
  })

  it('honors a per-request baseURL override', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test' })
    await api('/x', { baseURL: 'https://override.test' })
    expect(lastCall()[0]).toBe('https://override.test/x')
  })
})

describe('createHttp — query serialization', () => {
  it('serializes a query object onto the URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test' })
    await api('/search', { query: { q: 'widget', limit: 5 } })
    expect(lastCall()[0]).toBe('https://api.test/search?q=widget&limit=5')
  })

  it('repeats a key for array query values and drops null/undefined', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test' })
    await api('/search', { query: { tag: ['a', 'b'], skip: null, gone: undefined } })
    expect(lastCall()[0]).toBe('https://api.test/search?tag=a&tag=b')
  })

  it('appends to an existing query string with &', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test' })
    await api('/search?fixed=1', { query: { q: 'x' } })
    expect(lastCall()[0]).toBe('https://api.test/search?fixed=1&q=x')
  })
})

describe('createHttp — JSON body', () => {
  it('JSON-encodes an object body and sets Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test' })
    await api('/projects', { method: 'POST', body: { name: 'x', kind: 'demo' } })
    const [, init] = lastCall()
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ name: 'x', kind: 'demo' }))
    expect(headerOf(init, 'Content-Type')).toBe('application/json')
  })

  it('JSON-encodes an array body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test' })
    await api('/bulk', { method: 'POST', body: [1, 2, 3] })
    expect(lastCall()[1].body).toBe('[1,2,3]')
  })

  it('does not override a caller-supplied Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test' })
    await api('/x', {
      method: 'POST',
      body: { a: 1 },
      headers: { 'Content-Type': 'application/vnd.api+json' },
    })
    expect(headerOf(lastCall()[1], 'Content-Type')).toBe('application/vnd.api+json')
  })

  it('passes a string body through without a forced Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test' })
    await api('/raw', { method: 'POST', body: 'plain-text' })
    const [, init] = lastCall()
    expect(init.body).toBe('plain-text')
    expect(headerOf(init, 'Content-Type')).toBeNull()
  })

  it('passes FormData through untouched', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test' })
    const fd = new FormData()
    fd.append('file', 'data')
    await api('/upload', { method: 'POST', body: fd })
    const [, init] = lastCall()
    expect(init.body).toBe(fd)
    expect(headerOf(init, 'Content-Type')).toBeNull()
  })
})

describe('createHttp — bearer token injection', () => {
  it('injects Authorization: Bearer <token> from getToken per request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const getToken = vi.fn(() => Promise.resolve('abc123'))
    const api = createHttp({ baseURL: 'https://api.test', getToken })
    await api('/users/1')
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(headerOf(lastCall()[1], 'Authorization')).toBe('Bearer abc123')
  })

  it('calls getToken again on a second request (per-request tokens)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const getToken = vi.fn(() => Promise.resolve('t'))
    const api = createHttp({ baseURL: 'https://api.test', getToken })
    await api('/one')
    await api('/two')
    expect(getToken).toHaveBeenCalledTimes(2)
  })

  it('omits the Authorization header when getToken returns null (signed out)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const getToken = vi.fn(() => Promise.resolve(null))
    const api = createHttp({ baseURL: 'https://api.test', getToken })
    await api('/users/1')
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(headerOf(lastCall()[1], 'Authorization')).toBeNull()
  })

  it('omits the Authorization header when no getToken is configured', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const api = createHttp({ baseURL: 'https://api.test' })
    await api('/users/1')
    expect(headerOf(lastCall()[1], 'Authorization')).toBeNull()
  })
})

describe('createHttp — response parsing', () => {
  it('parses a JSON response body and returns it typed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: { id: 7 } }))
    const api = createHttp({ baseURL: 'https://api.test' })
    const res = await api<{ user: { id: number } }>('/users/1')
    expect(res).toEqual({ user: { id: 7 } })
  })

  it('returns undefined for an empty body (e.g. 204)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(undefined, { status: 204 }))
    const api = createHttp({ baseURL: 'https://api.test' })
    const res = await api('/delete')
    expect(res).toBeUndefined()
  })

  it('returns raw text for a non-JSON body that is not valid JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: '',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: () => Promise.resolve('hello world'),
    } as unknown as Response)
    const api = createHttp({ baseURL: 'https://api.test' })
    const res = await api('/text')
    expect(res).toBe('hello world')
  })
})

describe('createHttp — responseType', () => {
  // A Response-like whose blob()/arrayBuffer()/text() are all backed by the same
  // bytes, so we can assert the client hands back the right representation. The
  // ArrayBuffer is built with the test realm's own constructor (not via a
  // TextEncoder view, whose Node-realm buffer fails jsdom's `instanceof`).
  function bytesResponse(
    text: string,
    init: { status?: number; statusText?: string } = {},
  ): Response {
    const status = init.status ?? 200
    const buffer = new ArrayBuffer(text.length)
    const view = new Uint8Array(buffer)
    for (let i = 0; i < text.length; i++) view[i] = text.charCodeAt(i)
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: init.statusText ?? '',
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      text: () => Promise.resolve(text),
      blob: () => Promise.resolve(new Blob([buffer], { type: 'application/octet-stream' })),
      arrayBuffer: () => Promise.resolve(buffer),
    } as unknown as Response
  }

  it("responseType: 'blob' returns the raw response as a Blob", async () => {
    fetchMock.mockResolvedValue(bytesResponse('{"a":1}'))
    const api = createHttp({ baseURL: 'https://api.test' })
    const res = await api<Blob>('/export', { responseType: 'blob' })
    expect(res).toBeInstanceOf(Blob)
    expect(res.size).toBe(7)
    expect(res.type).toBe('application/octet-stream')
  })

  it("responseType: 'arrayBuffer' returns the raw response as an ArrayBuffer", async () => {
    fetchMock.mockResolvedValue(bytesResponse('binary'))
    const api = createHttp({ baseURL: 'https://api.test' })
    const res = await api<ArrayBuffer>('/blob', { responseType: 'arrayBuffer' })
    expect(res).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(new Uint8Array(res))).toBe('binary')
  })

  it("responseType: 'text' returns the raw string without JSON parsing", async () => {
    fetchMock.mockResolvedValue(bytesResponse('{"a":1}'))
    const api = createHttp({ baseURL: 'https://api.test' })
    const res = await api<string>('/text', { responseType: 'text' })
    expect(res).toBe('{"a":1}')
  })

  it('defaults to JSON parsing when responseType is unset', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: { id: 7 } }))
    const api = createHttp({ baseURL: 'https://api.test' })
    const res = await api<{ user: { id: number } }>('/users/1')
    expect(res).toEqual({ user: { id: 7 } })
  })

  it('still throws an HttpError on a non-2xx blob request', async () => {
    fetchMock.mockResolvedValue(
      bytesResponse('{"error":"boom"}', { status: 500, statusText: 'Internal Server Error' }),
    )
    const api = createHttp({ baseURL: 'https://api.test' })
    let caught: HttpError | undefined
    try {
      await api('/export', { responseType: 'blob' })
    } catch (e) {
      caught = e as HttpError
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.statusCode).toBe(500)
    expect(caught?.response?.status).toBe(500)
    // The error body is auto-parsed even for a blob request, so `data` stays useful.
    expect(caught?.data).toEqual({ error: 'boom' })
  })
})

describe('createHttp — HttpError on non-2xx', () => {
  it('throws an HttpError carrying statusCode, response.status, and data on 500', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'boom' }, { status: 500, statusText: 'Internal Server Error' }),
    )
    const api = createHttp({ baseURL: 'https://api.test' })
    let caught: HttpError | undefined
    try {
      await api('/fail')
    } catch (e) {
      caught = e as HttpError
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.statusCode).toBe(500)
    expect(caught?.response?.status).toBe(500)
    expect(caught?.data).toEqual({ error: 'boom' })
  })

  it('throws on 404 and does not return the parsed body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'nope' }, { status: 404 }))
    const api = createHttp({ baseURL: 'https://api.test' })
    await expect(api('/missing')).rejects.toMatchObject({
      statusCode: 404,
      data: { detail: 'nope' },
    })
  })

  it('rejects (does not swallow) on 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }))
    const api = createHttp({ baseURL: 'https://api.test' })
    await expect(api('/me')).rejects.toBeInstanceOf(Error)
  })
})

describe('isSignedOutError', () => {
  it('is true for a 401 (statusCode shape)', () => {
    expect(isSignedOutError({ statusCode: 401 })).toBe(true)
  })

  it('is true for a 403 (statusCode shape)', () => {
    expect(isSignedOutError({ statusCode: 403 })).toBe(true)
  })

  it('is true for the older response.status shape', () => {
    expect(isSignedOutError({ response: { status: 401 } })).toBe(true)
    expect(isSignedOutError({ response: { status: 403 } })).toBe(true)
  })

  it('is true for a real HttpError thrown by the client', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 403 }))
    const api = createHttp({ baseURL: 'https://api.test' })
    const err = await api('/x').catch((e) => e)
    expect(isSignedOutError(err)).toBe(true)
  })

  it('is false for 500', () => {
    expect(isSignedOutError({ statusCode: 500 })).toBe(false)
  })

  it('is false for 404', () => {
    expect(isSignedOutError({ statusCode: 404 })).toBe(false)
  })

  it('is false for a transport error with no status', () => {
    expect(isSignedOutError(new Error('network down'))).toBe(false)
  })

  it('is false for null/undefined', () => {
    expect(isSignedOutError(null)).toBe(false)
    expect(isSignedOutError(undefined)).toBe(false)
  })
})

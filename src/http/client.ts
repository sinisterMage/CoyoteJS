// coyote-js/http — a small, dependency-free fetch-based JSON client.
//
// createHttp({ baseURL, getToken }) returns a callable HttpClient:
//
//   const api = createHttp({ baseURL: '/api', getToken })
//   const me = await api<{ user: User }>('/me')
//
// Per request it:
//   - prefixes `baseURL` (a relative path stays relative to it),
//   - serialises `query` onto the URL,
//   - JSON-encodes a plain-object/array `body` and sets `Content-Type`,
//   - injects `Authorization: Bearer <token>` from `getToken()` when a token
//     is present (a null token → no header, i.e. a signed-out request),
//   - parses a JSON response body (empty/non-JSON → the raw text, or undefined),
//     or returns it as a Blob/ArrayBuffer/text when `responseType` asks,
//   - and on a non-2xx status throws an `HttpError` carrying `statusCode`,
//     `response.status`, and the parsed `data`.
//
// This mirrors the ofetch/$fetch surface closely enough that callers ported
// from it — and the `statusOf`/signed-out logic that reads its errors — keep
// working.

import type { HttpClient, HttpError, HttpRequestOptions } from './types'

export interface CreateHttpOptions {
  baseURL?: string
  getToken?: () => Promise<string | null>
}

// Concrete Error subclass behind the `HttpError` interface. Instances still
// satisfy `err instanceof Error`, and `isSignedOutError` reads the same
// `statusCode` / `response.status` fields the interface exposes.
export class HttpErrorImpl extends Error implements HttpError {
  statusCode: number
  response: { status: number }
  data: unknown

  constructor(status: number, statusText: string, data: unknown, url: string) {
    super(`[${status}] ${statusText || 'Request failed'} (${url})`)
    this.name = 'HttpError'
    this.statusCode = status
    this.response = { status }
    this.data = data
  }
}

// Only serialise structured bodies to JSON. Anything the platform can already
// send as-is (string, FormData, Blob, URLSearchParams, ArrayBuffer/typed
// arrays, ReadableStream) is passed straight through with no forced header, so
// the caller stays in control of the Content-Type.
function isJsonBody(body: unknown): boolean {
  if (body === null || body === undefined) return false
  if (typeof body !== 'object') return false
  if (
    typeof FormData !== 'undefined' && body instanceof FormData ||
    typeof Blob !== 'undefined' && body instanceof Blob ||
    typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams ||
    typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer ||
    typeof ReadableStream !== 'undefined' && body instanceof ReadableStream ||
    ArrayBuffer.isView(body)
  ) {
    return false
  }
  return true
}

// Append `query` entries to a URLSearchParams. Arrays repeat the key
// (`?tag=a&tag=b`); null/undefined values are dropped; everything else is
// stringified. Mirrors ofetch's query handling closely enough for our API.
function appendQuery(params: URLSearchParams, query: Record<string, unknown>): void {
  for (const key of Object.keys(query)) {
    const value = query[key]
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === null || item === undefined) continue
        params.append(key, String(item))
      }
    } else {
      params.append(key, String(value))
    }
  }
}

// Join a base and a path without collapsing or duplicating the boundary slash.
// A path that is already absolute (has a scheme) ignores the base.
function joinUrl(baseURL: string, path: string): string {
  if (!baseURL) return path
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path
  if (!path) return baseURL
  const trimmedBase = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL
  const trimmedPath = path.startsWith('/') ? path : `/${path}`
  return trimmedBase + trimmedPath
}

// Parse the response body: undefined for an empty body, the JSON value when it
// parses, else the raw text. Never throws — a non-JSON body (or malformed JSON)
// falls back to text so error `data` is still useful. We parse opportunistically
// rather than gating on Content-Type because some backend error responses send
// JSON without the header, and the fallback makes a wrong guess harmless.
async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function createHttp(opts: CreateHttpOptions = {}): HttpClient {
  const baseURL = opts.baseURL ?? ''
  const getToken = opts.getToken

  const client = async <T>(path: string, options: HttpRequestOptions = {}): Promise<T> => {
    const { baseURL: reqBaseURL, query, body, headers, responseType, ...rest } = options

    const url = joinUrl(reqBaseURL ?? baseURL, path)
    const params = new URLSearchParams()
    if (query) appendQuery(params, query)
    const qs = params.toString()
    const fullUrl = qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url

    // Normalize the caller's headers into a Headers instance so we can
    // conditionally add Content-Type / Authorization without clobbering them.
    const finalHeaders = new Headers(headers as HeadersInit | undefined)

    let finalBody: BodyInit | null | undefined
    if (body !== undefined && body !== null) {
      if (isJsonBody(body)) {
        finalBody = JSON.stringify(body)
        if (!finalHeaders.has('Content-Type')) {
          finalHeaders.set('Content-Type', 'application/json')
        }
      } else {
        finalBody = body as BodyInit
      }
    }

    if (getToken) {
      const token = await getToken()
      if (token) finalHeaders.set('Authorization', `Bearer ${token}`)
    }

    const res = await fetch(fullUrl, {
      ...rest,
      headers: finalHeaders,
      body: finalBody,
    })

    // On a non-2xx status we always throw, regardless of `responseType`. The
    // error body is auto-parsed (JSON → text) so `HttpError.data` stays useful
    // even for blob/arrayBuffer requests, whose error bodies are still text.
    if (!res.ok) {
      const data = await parseBody(res)
      throw new HttpErrorImpl(res.status, res.statusText, data, fullUrl)
    }

    // On success, read the body per the requested `responseType`. `text` returns
    // the raw string (no JSON parse); `json`/unset uses the auto JSON/text
    // parsing that mirrors ofetch/$fetch.
    switch (responseType) {
      case 'blob':
        return (await res.blob()) as T
      case 'arrayBuffer':
        return (await res.arrayBuffer()) as T
      case 'text':
        return (await res.text()) as T
      default:
        return (await parseBody(res)) as T
    }
  }

  return client
}

// coyote-js/http — public type surface for the fetch-based JSON client.
//
// Kept dependency-free: these interfaces describe the request/response shape of
// `createHttp` and the errors it throws. They intentionally mirror the
// ofetch/$fetch surface closely enough that callers ported from it keep working.

/**
 * The error thrown by an {@link HttpClient} on a non-2xx response. Instances are
 * real `Error`s that also carry the HTTP status (as both `statusCode` and the
 * older ofetch `response.status` shape) and the parsed error body in `data`.
 */
export interface HttpError extends Error {
  statusCode?: number
  response?: { status?: number }
  // `any` (not `unknown`): callers read the parsed error body directly, e.g.
  // `(err as HttpError).data?.error` — a backend-specific shape, not worth a cast
  // at every call site.
  data?: any
}

export interface HttpRequestOptions extends Omit<RequestInit, 'body'> {
  baseURL?: string
  // `any`: query/body values are whatever the caller passes (serialized by the
  // client); constraining them to `unknown` would force casts at every call.
  query?: Record<string, any>
  body?: any
  /**
   * How to read the response body. Defaults to auto JSON/text parsing
   * (`'json'`): the body is parsed as JSON, falling back to raw text, or
   * `undefined` for an empty body. `'blob'`/`'arrayBuffer'`/`'text'` return the
   * raw response as that type instead (for downloads, binary, etc.).
   */
  responseType?: 'json' | 'text' | 'blob' | 'arrayBuffer'
}

export interface HttpClient {
  <T>(path: string, opts?: HttpRequestOptions): Promise<T>
}

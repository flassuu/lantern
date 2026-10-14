const TOKEN_KEY = 'auth.token'

const NETWORK_ERROR_CODE = 'NETWORK'

/**
 * API base for the desktop app. The built webview runs on the Tauri origin
 * (`tauri://localhost`), so API calls must target the local server explicitly; in
 * dev Vite would otherwise proxy `/api` for us.
 *
 * It is a variable, not a constant: the app hosts that server itself and the port
 * is a setting, so a build-time constant would mean moving to another port needs
 * a rebuild - exactly what a teacher in a computer room cannot do.
 */
const BUILD_TIME_API_BASE = import.meta.env.VITE_API_TARGET ?? 'http://localhost:3300'
let apiBase = BUILD_TIME_API_BASE

/** Points the app at another port, e.g. after the host settings changed. */
export function setApiBase(base: string): void {
  const trimmed = base.trim().replace(/\/+$/, '')
  apiBase = trimmed === '' ? BUILD_TIME_API_BASE : trimmed
}

export function getApiBase(): string {
  return apiBase
}

export function apiUrl(path: string): string {
  return `${apiBase}${path}`
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }

  get isNetwork(): boolean {
    return this.code === NETWORK_ERROR_CODE
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

/** Lightweight reachability probe for the offline banner / health polling. */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(apiUrl('/api/health'), { cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

/**
 * What the server says about itself, when it says anything.
 *
 * A heartbeat only needs a yes or a no; the server panel needs the version, so
 * that a run started outside the app can be named rather than merely counted.
 */
export async function fetchHealth(): Promise<{ version: string } | null> {
  try {
    const res = await fetch(apiUrl('/api/health'), { cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === 'string' ? { version: body.version } : null
  } catch {
    return null
  }
}

export interface ErrorEnvelope {
  error?: { code?: string; message?: string }
}

/**
 * One authenticated round trip: attaches the bearer token and turns a failure
 * into an ApiError, so callers only deal with a parsed body or an exception.
 */
async function request(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  // Only claim a JSON body when there is one: a bodyless POST with
  // `content-type: application/json` is rejected by Fastify as an empty body,
  // which broke every mutation that carries no payload (delete, duplicate,
  // pause/resume/finish, approve, block).
  const hasBody = init.body !== undefined && init.body !== null && init.body !== ''
  if (init.method && init.method !== 'GET' && hasBody && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const token = getToken()
  if (token && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`)
  }

  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers })
  } catch {
    throw new ApiError(0, NETWORK_ERROR_CODE, 'server unreachable')
  }

  if (!res.ok) {
    let code = 'ERROR'
    let message = res.statusText
    try {
      const body = (await res.json()) as ErrorEnvelope
      code = body.error?.code ?? code
      message = body.error?.message ?? message
    } catch {
      // Non-JSON error body; keep defaults.
    }
    throw new ApiError(res.status, code, message)
  }
  return res
}

/**
 * Thin fetch wrapper: parses the server's uniform error envelope into a typed
 * body. Failures arrive as an ApiError so the UI can tell "server is offline"
 * from a real API error.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await request(path, init)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * Fetches a file with the bearer token and offers it to the browser as a
 * download. A plain link cannot work here: the API authenticates with an
 * Authorization header rather than a cookie, so an <a href> would be rejected.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await request(path, {})
  const objectUrl = URL.createObjectURL(await res.blob())
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = filename
  link.click()
  // Revoking right after the click can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}

/**
 * Fetches a path as a blob, for an export that is written to a file the teacher
 * picked in a save dialog rather than handed to the browser as a download.
 */
export async function fetchBlob(path: string): Promise<Blob> {
  const res = await request(path, {})
  return res.blob()
}

import { onBeforeUnmount, ref, type Ref } from 'vue'
import { getToken, socketBase } from '../api/client'
import { listLogs } from '../api/logs'
import type { LogEntry } from '../api/types'

/** What a browser tab keeps: a lesson's worth, not a day. */
const MAX_LINES = 500
const MAX_BACKOFF_MS = 10_000
/** Long enough that a dropped message is the only reason to ask again. */
const SAFETY_POLL_MS = 30_000

export interface LogStream {
  entries: Ref<LogEntry[]>
  connected: Ref<boolean>
  /** The newest sequence number held, or 0 when nothing has arrived yet. */
  lastSeq: Ref<number>
  connect: () => void
  disconnect: () => void
  clear: () => void
}

function socketUrl(since: number): string | null {
  const token = getToken()
  if (!token) return null
  const query = `token=${encodeURIComponent(token)}&since=${since}`
  return `${socketBase()}/ws/server?${query}`
}

/**
 * The server's live log tail for the admin's Server tab.
 *
 * One socket carries both halves: the backlog the client missed on `connect`,
 * then each new line as it happens. If the socket cannot be opened — a proxy
 * without upgrade, which is exactly what sits between a school server and a
 * browser on the same LAN — the stream falls back to polling `GET /api/logs?since=`
 * and keeps working, with the same sequence numbers either way.
 */
export function useLogStream(): LogStream {
  const entries = ref<LogEntry[]>([])
  const connected = ref(false)
  const lastSeq = ref(0)

  let socket: WebSocket | null = null
  let retryDelay = 1000
  let retryTimer: number | undefined
  let fallbackTimer: number | undefined
  let safetyTimer: number | undefined
  let disposed = false

  function clearTimers(): void {
    if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    if (fallbackTimer !== undefined) window.clearInterval(fallbackTimer)
    if (safetyTimer !== undefined) window.clearInterval(safetyTimer)
    retryTimer = undefined
    fallbackTimer = undefined
    safetyTimer = undefined
  }

  function append(incoming: LogEntry[]): void {
    if (incoming.length === 0) return
    for (const entry of incoming) {
      // A reconnect replays lines the tab may already hold; sequence numbers are
      // the deduplication key, and monotonic output is worth more than a dupe.
      if (entry.seq <= lastSeq.value) continue
      entries.value = [...entries.value, entry]
      lastSeq.value = entry.seq
    }
    if (entries.value.length > MAX_LINES) {
      entries.value = entries.value.slice(entries.value.length - MAX_LINES)
    }
  }

  async function poll(): Promise<void> {
    try {
      append(await listLogs(lastSeq.value))
    } catch {
      // Keep the lines already on screen; the next tick tries again.
    }
  }

  function startFallback(): void {
    if (fallbackTimer !== undefined) return
    fallbackTimer = window.setInterval(() => void poll(), 4000)
  }

  function stopFallback(): void {
    if (fallbackTimer !== undefined) {
      window.clearInterval(fallbackTimer)
      fallbackTimer = undefined
    }
  }

  function open(): void {
    if (disposed) return
    const url = socketUrl(lastSeq.value)
    if (!url) return

    let socketRef: WebSocket
    try {
      socketRef = new WebSocket(url)
    } catch {
      startFallback()
      scheduleRetry()
      return
    }
    socket = socketRef

    socketRef.onopen = () => {
      connected.value = true
      retryDelay = 1000
      stopFallback()
    }
    socketRef.onmessage = (event: MessageEvent<string>) => {
      let message: unknown
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (typeof message !== 'object' || message === null) return
      const payload = message as { type?: string; entries?: LogEntry[]; entry?: LogEntry }
      if (payload.type === 'backlog' && Array.isArray(payload.entries)) {
        append(payload.entries)
      } else if (payload.type === 'entry' && payload.entry) {
        append([payload.entry])
      }
    }
    socketRef.onclose = () => {
      connected.value = false
      if (socketRef !== socket) return
      socket = null
      startFallback()
      scheduleRetry()
    }
    socketRef.onerror = () => {
      connected.value = false
    }
  }

  function scheduleRetry(): void {
    if (disposed) return
    if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined
      open()
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, MAX_BACKOFF_MS)
  }

  function connect(): void {
    disconnect()
    disposed = false
    // The backlog is fetched over HTTP first, so the tab shows something before
    // the socket is even open — and so a blocked WebSocket still shows a log.
    void poll()
    open()
    if (safetyTimer !== undefined) window.clearInterval(safetyTimer)
    safetyTimer = window.setInterval(() => void poll(), SAFETY_POLL_MS)
  }

  function disconnect(): void {
    disposed = true
    connected.value = false
    clearTimers()
    if (socket) {
      const current = socket
      socket = null
      current.onclose = null
      current.onerror = null
      current.close()
    }
  }

  /** Clears the view. The server's buffer is untouched — this is a local wipe. */
  function clear(): void {
    entries.value = []
  }

  onBeforeUnmount(disconnect)

  return { entries, connected, lastSeq, connect, disconnect, clear }
}
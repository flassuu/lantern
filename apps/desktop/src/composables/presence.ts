import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { getToken } from '../api/client'
import type { LiveSessionStatus } from '../api/sessions'

/**
 * What a student tells the room about themselves.
 *
 * Two things travel over this socket and nothing else: whether the window is on
 * screen, and how far through the paper they are. The same socket carries back
 * the status the server pushes, which is how a lobby learns that the run has
 * started - the teacher pressing Start reaches every phone at once.
 *
 * One socket lives for the whole run, lobby and paper alike, so the board never
 * sees a gap where a student reloaded. The alternative - a socket per screen -
 * would make every student blink offline exactly when they were most likely to
 * be watched.
 *
 * Leaving the window is recorded, not punished: it is reported, the teacher can
 * see it, and nothing is blocked, auto-submitted or scolded.
 */
export function usePresence(sessionId: Ref<string | null>) {
  const status = ref<LiveSessionStatus | null>(null)
  const visible = ref(true)
  /** Set once the student has looked away, so the paper can say so afterwards. */
  const leftOnce = ref(false)

  let socket: WebSocket | null = null

  function send(type: string, payload: Record<string, unknown> = {}): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type, ...payload }))
  }

  function reportVisibility(): void {
    const hidden = document.hidden
    if (hidden) leftOnce.value = true
    visible.value = !hidden
    send('presence', { visible: !hidden })
  }

  /** How far the student is: the question they are on and how many they answered. */
  function reportProgress(questionIndex: number, answered: number): void {
    send('progress', { questionIndex, answered })
  }

  function close(): void {
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    socket.close()
    socket = null
  }

  function open(session: string): void {
    close()
    const token = getToken()
    if (!token) return
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    try {
      socket = new WebSocket(
        `${protocol}://${window.location.host}/ws/sessions/${session}?token=${encodeURIComponent(token)}`,
      )
    } catch {
      return
    }
    socket.onopen = () => {
      // A fresh socket is a fresh look at the screen: the previous "left" is
      // reported once and then stops being the current state.
      leftOnce.value = false
      reportVisibility()
    }
    socket.onmessage = (event: MessageEvent<string>) => {
      try {
        const message = JSON.parse(event.data) as { type?: string; status?: LiveSessionStatus }
        if (message.type === 'status' && message.status) status.value = message.status
      } catch {
        // A malformed frame is not worth a broken screen.
      }
    }
  }

  watch(
    sessionId,
    (id) => {
      status.value = null
      if (id) open(id)
      else close()
    },
    { immediate: true },
  )

  document.addEventListener('visibilitychange', reportVisibility)

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', reportVisibility)
    close()
  })

  return { status, visible, leftOnce, reportProgress }
}

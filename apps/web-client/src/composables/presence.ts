import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { getToken, socketBase } from '../api/client'
import type { LiveSessionStatus } from '../api/sessions'

/**
 * The run's clock, as the server last reported it.
 *
 * A student's own copy of the session is frozen at the moment they joined it,
 * and a pause, a resume and "+15s" all happen afterwards, while they are
 * answering. The socket is how they hear about it: the status frame carries the
 * start mark, the pause mark and the limit, so the student's clock is the
 * server's clock rather than a tally of its own that drifts from it.
 */
export interface SessionClock {
  /** Always present: a frame without it is not a clock and is ignored. */
  serverNow: string
  startedAt: string | null
  pausedAt: string | null
  timeLimitSec: number | null
}

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
  /**
   * What the server last said the clock reads, or null when it has not said yet.
   *
   * Replaced whole on every frame rather than merged field by field: a field set
   * to null by a frame ("no limit on this run") has to be told apart from a
   * field that has simply never arrived, and only a whole replacement tells the
   * two apart without a second flag.
   */
  const clock = ref<SessionClock | null>(null)

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
    try {
      socket = new WebSocket(
        `${socketBase()}/ws/sessions/${session}?token=${encodeURIComponent(token)}`,
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
        const message = JSON.parse(event.data) as {
          type?: string
          status?: LiveSessionStatus
        } & Partial<SessionClock>
        if (message.type !== 'status' || !message.status) return
        status.value = message.status
        // The clock comes with the status. A frame that carries none of the four
        // leaves the student's own numbers alone rather than blanking them, so a
        // server too old to send a clock cannot empty a clock that is working.
        if (message.serverNow === undefined) return
        clock.value = {
          serverNow: message.serverNow,
          startedAt: message.startedAt ?? null,
          pausedAt: message.pausedAt ?? null,
          timeLimitSec: message.timeLimitSec ?? null,
        }
      } catch {
        // A malformed frame is not worth a broken screen.
      }
    }
  }

  watch(
    sessionId,
    (id) => {
      status.value = null
      clock.value = null
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

  return { status, visible, leftOnce, clock, reportProgress }
}

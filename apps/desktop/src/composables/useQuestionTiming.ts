import { ref, watch } from 'vue'

/**
 * How long the student sat on each question, and how often they changed their mind.
 *
 * Both numbers are the client's word, and both are worth keeping: a question a
 * class took ninety seconds on is a question worth looking at again, and an
 * answer rewritten four times is not the confident answer it appears to be.
 *
 * Time is measured on the question the student is looking at, which is why the
 * runner sets `current`, and why a paper shown all at once reports no time: there
 * was no single question on screen to time. Sending nothing is the honest answer
 * there, and the detail view shows a dash rather than a zero.
 */
export interface QuestionTimings {
  [questionId: string]: { timeMs: number; changed: number }
}

export interface QuestionTiming {
  /** The question on screen right now; null when the whole paper is visible. */
  readonly current: string | null
  /** Says which question is on screen, or null when the whole paper is. */
  setCurrent: (questionId: string | null) => void
  /** Records a write to an answer. The first write is answering, not changing. */
  noteChange: (questionId: string) => void
  /** What to send with the paper. */
  snapshot: () => QuestionTimings
}

export function useQuestionTiming(): QuestionTiming {
  const current = ref<string | null>(null)
  const spent = new Map<string, number>()
  const changed = new Map<string, number>()
  const written = new Set<string>()
  let since: number | null = null

  // Moving on is what stops the clock on the old question, so the accumulation
  // lives with the change rather than with whoever remembers to stop it.
  // Synchronous, because a question visited for a moment must not lose that
  // moment waiting for the scheduler.
  watch(
    current,
    (next, previous) => {
      if (previous !== null && since !== null) {
        spent.set(previous, (spent.get(previous) ?? 0) + (Date.now() - since))
      }
      since = next === null ? null : Date.now()
    },
    { flush: 'sync' },
  )

  function noteChange(questionId: string): void {
    if (!written.has(questionId)) {
      written.add(questionId)
      return
    }
    changed.set(questionId, (changed.get(questionId) ?? 0) + 1)
  }

  function snapshot(): QuestionTimings {
    const result: QuestionTimings = {}
    for (const questionId of new Set([...spent.keys(), ...changed.keys()])) {
      result[questionId] = {
        timeMs: spent.get(questionId) ?? 0,
        changed: changed.get(questionId) ?? 0,
      }
    }
    // The question still on screen has spent time too: nobody moved off it.
    const live = current.value
    if (live !== null && since !== null) {
      const already = result[live]
      result[live] = {
        timeMs: (already?.timeMs ?? 0) + (Date.now() - since),
        changed: already?.changed ?? 0,
      }
    }
    // Neither time nor changes says nothing, and the detail view shows a dash.
    for (const [questionId, entry] of Object.entries(result)) {
      if (entry.timeMs <= 0 && entry.changed <= 0) delete result[questionId]
    }
    return result
  }

  return {
    get current() {
      return current.value
    },
    setCurrent: (questionId: string | null) => {
      current.value = questionId
    },
    noteChange,
    snapshot,
  }
}
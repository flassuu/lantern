import type { QuestionResponse, Responses } from '../student/sessionLogic'
import type { QuestionTimings } from './useQuestionTiming'

/**
 * The paper a student was filling in, kept on the device.
 *
 * A phone that reloads mid-test - a battery saver killing the tab, a thumb on
 * the wrong button - used to hand back an empty paper. The answers live in
 * localStorage under the run and the student, so a phone passed around a
 * classroom cannot show one student's answers to the next.
 *
 * The clock is not kept here, because it is not the client's: the run's deadline
 * is the server's. A restored paper has less time left than it had before the
 * reload, and that is the truth rather than a penalty.
 */

const VERSION = 1
const PREFIX = 'sessionDraft'
/** A day is longer than any class: an older entry belongs to a run that is over. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface SessionDraft {
  version: typeof VERSION
  /** ISO timestamp of the last write, for expiry and for nothing else. */
  savedAt: string
  /** The paged runner's index; a whole-paper run ignores it. */
  page: number
  responses: Responses
  timing: QuestionTimings
}

/** What the runner hands over; the version and the timestamp are not its business. */
export interface DraftInput {
  page: number
  responses: Responses
  timing: QuestionTimings
}

/** The slice of the Storage API this module needs, so tests can pass a fake. */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** Every key in the store; a sign-out drops one student's drafts with it. */
  keys(): string[]
}

function browserStorage(): DraftStorage {
  return {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
    keys: () => {
      const keys: string[] = []
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index)
        if (key !== null) keys.push(key)
      }
      return keys
    },
  }
}

export function draftKey(sessionId: string, userId: string): string {
  return `${PREFIX}:${sessionId}:${userId}`
}

export function readDraft(
  sessionId: string,
  userId: string,
  storage: DraftStorage = browserStorage(),
): SessionDraft | null {
  const key = draftKey(sessionId, userId)
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return null
  }
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    storage.removeItem(key)
    return null
  }
  // A draft of another version, or one from a run that is over, is not restored:
  // it is removed, so a stale answer cannot surface in a later lesson.
  if (!isDraft(parsed) || isStale(parsed.savedAt)) {
    storage.removeItem(key)
    return null
  }
  return parsed
}

export function writeDraft(
  sessionId: string,
  userId: string,
  input: DraftInput,
  storage: DraftStorage = browserStorage(),
): void {
  const draft: SessionDraft = {
    version: VERSION,
    savedAt: new Date().toISOString(),
    page: input.page,
    responses: input.responses,
    timing: input.timing,
  }
  try {
    storage.setItem(draftKey(sessionId, userId), JSON.stringify(draft))
  } catch {
    // No quota, or storage disabled: the student simply has no draft to restore.
  }
}

export function clearDraft(
  sessionId: string,
  userId: string,
  storage: DraftStorage = browserStorage(),
): void {
  try {
    storage.removeItem(draftKey(sessionId, userId))
  } catch {
    // Nothing to do: a draft that cannot be removed is replaced on the next run.
  }
}

/** Drops every draft the student left behind, on the way out of the account. */
export function clearDraftsForUser(userId: string, storage: DraftStorage = browserStorage()): void {
  const suffix = `:${userId}`
  try {
    for (const key of storage.keys()) {
      if (key.startsWith(`${PREFIX}:`) && key.endsWith(suffix)) storage.removeItem(key)
    }
  } catch {
    // A store that cannot be read is a store with nothing worth keeping.
  }
}

function isStale(savedAt: string): boolean {
  const at = Date.parse(savedAt)
  return Number.isNaN(at) || Date.now() - at > MAX_AGE_MS
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isResponse(value: unknown): value is QuestionResponse {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.keys) || !value.keys.every((key) => typeof key === 'string')) return false
  if (typeof value.text !== 'string') return false
  if (value.boolean !== undefined && typeof value.boolean !== 'boolean') return false
  if (value.pairs !== undefined) {
    if (!Array.isArray(value.pairs)) return false
    const pairs = value.pairs
    if (
      !pairs.every(
        (pair) =>
          isRecord(pair) && typeof pair.left === 'string' && typeof pair.right === 'string',
      )
    ) {
      return false
    }
  }
  return true
}

function isTiming(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isNumber(value.timeMs) && isNumber(value.changed)
}

function isNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isDraft(value: unknown): value is SessionDraft {
  if (!isRecord(value)) return false
  if (value.version !== VERSION) return false
  if (typeof value.savedAt !== 'string') return false
  if (!Number.isInteger(value.page) || (value.page as number) < 0) return false
  if (!isRecord(value.responses)) return false
  if (!Object.values(value.responses).every(isResponse)) return false
  if (!isRecord(value.timing)) return false
  return Object.values(value.timing).every(isTiming)
}

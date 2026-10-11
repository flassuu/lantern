import type { AnswerInput, StudentQuestion } from '../api/sessions'

/** Mutable student state for one question while the paper is open. */
export interface QuestionResponse {
  keys: string[]
  boolean?: boolean
  text: string
  pairs?: Array<{ left: string; right: string }>
}

export type Responses = Record<string, QuestionResponse>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pairsOf(payload: Record<string, unknown>): Array<{ left: string; right: string }> {
  const pairs = Array.isArray(payload.pairs) ? payload.pairs : []
  return pairs.flatMap((pair) =>
    isRecord(pair) && typeof pair.left === 'string' && typeof pair.right === 'string'
      ? [{ left: pair.left, right: pair.right }]
      : [],
  )
}

/** Right-hand options offered for each left side of a matching question. */
export function matchingChoices(question: StudentQuestion): string[] {
  return pairsOf(question.payload)
    .map((pair) => pair.right)
    .filter((right, index, all) => all.indexOf(right) === index)
}

export function emptyResponse(question: StudentQuestion): QuestionResponse {
  switch (question.type) {
    case 'single_choice':
    case 'multiple_choice':
    case 'true_false':
    case 'short_answer':
      return { keys: [], text: '' }
    case 'matching':
      return { keys: [], text: '', pairs: pairsOf(question.payload).map((pair) => ({ ...pair, right: '' })) }
    default:
      return { keys: [], text: '' }
  }
}

export function emptyResponses(questions: StudentQuestion[]): Responses {
  const responses: Responses = {}
  for (const question of questions) responses[question.id] = emptyResponse(question)
  return responses
}

/** True when the student has put something down that is worth sending. */
export function isAnswered(question: StudentQuestion, response: QuestionResponse | undefined): boolean {
  if (!response) return false
  switch (question.type) {
    case 'single_choice':
      return response.keys.length === 1
    case 'multiple_choice':
      return response.keys.length > 0
    case 'true_false':
      return typeof response.boolean === 'boolean'
    case 'short_answer':
      return response.text.trim().length > 0
    case 'matching':
      return (
        (response.pairs?.length ?? 0) > 0 &&
        (response.pairs ?? []).every((pair) => pair.right.trim().length > 0)
      )
    default:
      return false
  }
}

export function answeredCount(questions: StudentQuestion[], responses: Responses): number {
  return questions.filter((question) => isAnswered(question, responses[question.id])).length
}

/** Strips empty answers so the payload stays small and the server grades the rest as zero. */
export function buildAnswers(questions: StudentQuestion[], responses: Responses): Record<string, AnswerInput> {
  const answers: Record<string, AnswerInput> = {}
  for (const question of questions) {
    const response = responses[question.id]
    if (!response || !isAnswered(question, response)) continue
    switch (question.type) {
      case 'single_choice':
        answers[question.id] = { key: response.keys[0] as string }
        break
      case 'multiple_choice':
        answers[question.id] = { keys: [...response.keys] }
        break
      case 'true_false':
        answers[question.id] = { boolean: response.boolean }
        break
      case 'short_answer':
        answers[question.id] = { text: response.text }
        break
      case 'matching':
        answers[question.id] = {
          pairs: (response.pairs ?? []).map((pair) => ({ left: pair.left, right: pair.right })),
        }
        break
    }
  }
  return answers
}

/**
 * Milliseconds left on the session clock, corrected for the round trip to the
 * server, or null when the test has no limit. Never negative.
 */
export function remainingMs(
  startedAt: string,
  timeLimitSec: number | null,
  serverNow: string,
  clientNow: number = Date.now(),
  pausedAt: string | null = null,
): number | null {
  if (timeLimitSec === null) return null
  const clockSkewMs = Date.parse(serverNow) - clientNow
  const deadline = Date.parse(startedAt) + timeLimitSec * 1000
  // While the run is on hold the remaining time stops shrinking: it is read as
  // of the moment the hold began rather than as of now. `pausedAt` is already
  // server time, which is the frame `deadline` is in, so it needs no skew.
  const serverMs = pausedAt !== null ? Date.parse(pausedAt) : clientNow + clockSkewMs
  return Math.max(0, deadline - serverMs)
}

/** `mm:ss`, or `h:mm:ss` once the clock passes an hour. */
export function formatClock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

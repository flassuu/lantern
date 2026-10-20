import { apiFetch, fetchBlob } from './client'
import { normalizeSession } from './normalize'
import type { Tag, TestSettings } from './types'

export type LiveSessionStatus = 'lobby' | 'active' | 'paused' | 'finished'
export type ParticipationStatus = 'joined' | 'submitted' | 'auto_submitted'

/** Flat answer payload; one shape per question type, mirroring the question payload. */
export interface AnswerInput {
  key?: string
  keys?: string[]
  boolean?: boolean
  text?: string
  pairs?: Array<{ left: string; right: string }>
}

export interface StudentQuestion {
  id: string
  type: string
  body: string
  points: number
  position: number
  payload: Record<string, unknown>
}

export interface GradedQuestion extends StudentQuestion {
  isCorrect: boolean
  pointsAwarded: number
}

export interface Participation {
  id: string
  sessionId: string
  status: ParticipationStatus
  questionOrder: string[]
  score: number | null
  maxScore: number | null
  percent: number | null
  passed: boolean | null
  joinedAt: string
  submittedAt: string | null
}

export interface LiveSession {
  id: string
  testId: string
  ownerId: string
  joinCode: string
  status: LiveSessionStatus
  timeLimitSec: number | null
  passingPercent: number | null
  /** The run's options, snapshotted from the test when it was created. */
  settings: TestSettings
  /** What the teacher called this run; null falls back to the test's title. */
  name: string | null
  /** The group this run is for; it defaults to the test's own room. */
  roomId: string | null
  /** While set, nobody new may join; the students already in are untouched. */
  entryLocked: boolean
  /** True once held results have been let out. */
  resultsReleased: boolean
  /** Null until the teacher starts the run; the lobby has no clock. */
  startedAt: string | null
  finishedAt: string | null
  /** Set while the run is on hold; the clock stops at this mark. */
  pausedAt: string | null
  test: { id: string; title: string; questionCount: number }
}

export interface SessionState {
  participation: Participation
  session: {
    id: string
    status: LiveSessionStatus
    timeLimitSec: number | null
    passingPercent: number | null
    /** The run's options: one page or many, and whether back is allowed. */
    settings: TestSettings
    /** Null while the run is still a lobby. */
    startedAt: string | null
    /** Set while the run is on hold; the runner's clock stops here. */
    pausedAt: string | null
    serverNow: string
  }
  questions: StudentQuestion[]
}

export interface SubmitResult {
  participation: Participation
  /** Null when the teacher holds the results: graded, but not shown yet. */
  result: { score: number; maxScore: number; percent: number; passed: boolean | null } | null
  released: boolean
}

export interface SessionResultBody {
  participation: Participation
  session: { id: string; status: LiveSessionStatus }
  test: { id: string; title: string; passingPercent: number | null } | null
  questions: GradedQuestion[]
}

export interface ParticipantEntry {
  userId: string
  username: string
  fullName: string
  status: ParticipationStatus
  score: number | null
  percent: number | null
  passed: boolean | null
  joinedAt: string
  submittedAt: string | null
  /** The live half, sent only on the board: socket open, window on screen, how far. */
  online?: boolean
  active?: boolean | null
  questionIndex?: number | null
  answered?: number | null
}

/** A session with the counts the board needs. */
export interface SessionSummary extends LiveSession {
  title: string
  joinedCount: number
  submittedCount: number
  tags: Tag[]
}

/** The columns a session list can be ordered by; `created` unless asked. */
export type SessionSort = 'created' | 'name' | 'status' | 'submitted'

/** What a session list can be narrowed by; every field is optional. */
export interface SessionFilter {
  roomId?: string | null
  testId?: string | null
  status?: LiveSessionStatus | null
  /** ISO date; sessions created on or after it. */
  from?: string | null
  to?: string | null
  /** Matched against the session name and the test title. */
  query?: string | null
  tagId?: string | null
  sort?: SessionSort
  dir?: 'asc' | 'desc'
  /** Rows to skip, for paging; the pair with `limit` makes a page. */
  offset?: number
  limit?: number
}

function filterQuery(filter: SessionFilter): string {
  const parts: string[] = []
  const add = (key: string, value: string | number | null | undefined): void => {
    if (value === null || value === undefined || value === '') return
    parts.push(`${key}=${encodeURIComponent(String(value))}`)
  }
  add('room', filter.roomId)
  add('test', filter.testId)
  add('status', filter.status)
  add('from', filter.from)
  add('to', filter.to)
  add('q', filter.query)
  add('tag', filter.tagId)
  add('sort', filter.sort)
  add('dir', filter.dir)
  add('limit', filter.limit)
  add('offset', filter.offset)
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

/** A page of sessions and the size of the whole filtered set. */
export interface SessionPage {
  sessions: SessionSummary[]
  total: number
}

/**
 * One page of the list, with the total it was cut from.
 *
 * The total is what a library counts pages against, and an older server that
 * does not send one falls back to the page length: a wrong total is a smaller
 * problem than a screen that will not render.
 */
export async function listSessionPage(filter: SessionFilter = {}): Promise<SessionPage> {
  const result = await apiFetch<{ sessions: SessionSummary[]; total?: number }>(
    `/api/sessions${filterQuery(filter)}`,
  )
  const sessions = result.sessions.map(normalizeSession)
  return { sessions, total: result.total ?? sessions.length }
}

/** Teacher only: their own sessions (an admin sees every teacher's). */
export async function listSessions(filter: SessionFilter = {}): Promise<SessionSummary[]> {
  return (await listSessionPage(filter)).sessions
}

/** One session by id, for a screen that did not arrive by way of the list. */
export async function getSession(id: string): Promise<SessionSummary> {
  const result = await apiFetch<{ session: SessionSummary }>(
    `/api/sessions/${encodeURIComponent(id)}`,
  )
  return normalizeSession(result.session)
}

/** Teacher only: starts a run of one of their tests. */
export async function startSession(
  testId: string,
  input: {
    name?: string | null
    roomId?: string | null
    tags?: string[]
    settings?: Partial<TestSettings>
  } = {},
): Promise<LiveSession> {
  const result = await apiFetch<{ session: LiveSession }>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ testId, ...input }),
  })
  return normalizeSession(result.session)
}

/** Teacher only. */
export async function getParticipants(sessionId: string): Promise<{
  session: LiveSession
  participants: ParticipantEntry[]
}> {
  const result = await apiFetch<{ session: LiveSession; participants: ParticipantEntry[] }>(
    `/api/sessions/${sessionId}/participants`,
  )
  return { session: normalizeSession(result.session), participants: result.participants }
}

/**
 * Opens the doors: leaves the lobby and starts the clock.
 *
 * Named `beginSession` rather than `startSession` because that name is already
 * taken by the call that *creates* a run - and the two are different acts now.
 */
export async function beginSession(sessionId: string): Promise<LiveSession> {
  const result = await apiFetch<{ session: LiveSession }>(
    `/api/sessions/${sessionId}/start`,
    { method: 'POST' },
  )
  return normalizeSession(result.session)
}

/** Changes the run's options; the server only accepts this in the lobby. */
export async function setSessionSettings(
  sessionId: string,
  settings: Partial<TestSettings>,
): Promise<LiveSession> {
  const result = await apiFetch<{ session: LiveSession }>(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ settings }),
  })
  return normalizeSession(result.session)
}

/** The formats a session's results can be written as. */
export type SessionExportFormat = 'csv' | 'txt'

/** One session's results, in the format the save dialog asked for. */
export async function sessionResultsBlob(
  sessionId: string,
  format: SessionExportFormat,
): Promise<Blob> {
  return fetchBlob(`/api/sessions/${encodeURIComponent(sessionId)}/results?format=${format}`)
}

/** Gives the run more time. Only a run with a clock has one to give. */
export async function extendSession(sessionId: string, seconds: number): Promise<LiveSession> {
  const result = await apiFetch<{ session: LiveSession }>(`/api/sessions/${sessionId}/extend`, {
    method: 'POST',
    body: JSON.stringify({ seconds }),
  })
  return normalizeSession(result.session)
}

/** Lets held results out, so students can see how they did. */
export async function releaseSessionResults(sessionId: string): Promise<LiveSession> {
  const result = await apiFetch<{ session: LiveSession }>(
    `/api/sessions/${sessionId}/release`,
    { method: 'POST' },
  )
  return normalizeSession(result.session)
}

/** Closes or opens the door to new students; whoever is inside is untouched. */
export async function setEntryLocked(sessionId: string, locked: boolean): Promise<LiveSession> {
  const result = await apiFetch<{ session: LiveSession }>(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ entryLocked: locked }),
  })
  return normalizeSession(result.session)
}

/** Teacher only: pauses, resumes or finishes. */
export async function setSessionStatus(
  sessionId: string,
  status: LiveSessionStatus,
): Promise<LiveSession> {
  const result = await apiFetch<{ session: LiveSession }>(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
  return normalizeSession(result.session)
}

/**
 * Throws a run away. A run that is still going is refused by the server; the
 * library only offers this for the ones that are over or never started.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await apiFetch<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

/** Student only. The code is normalised server-side, so case and spaces are fine. */
export async function joinSession(code: string): Promise<SessionState> {
  return apiFetch<SessionState>('/api/sessions/join', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}

/** Student only: the paper and the clock of the session in progress, if any. */
export async function getCurrentSession(): Promise<SessionState> {
  return apiFetch<SessionState>('/api/sessions/current')
}

export async function submitSession(
  sessionId: string,
  answers: Record<string, AnswerInput>,
  timings?: Record<string, AnswerTiming>,
): Promise<SubmitResult> {
  return apiFetch<SubmitResult>(`/api/sessions/${sessionId}/submit`, {
    method: 'POST',
    // `timings` is optional in both directions: a client that never measured
    // still submits, it just says nothing about time.
    body: JSON.stringify(timings === undefined ? { answers } : { answers, timings }),
  })
}

/** One student's run in one session: the questions, the answers, the time. */
export async function getAttemptDetail(
  sessionId: string,
  userId: string,
): Promise<AttemptDetail> {
  const result = await apiFetch<{ detail: AttemptDetail }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(userId)}`,
  )
  return result.detail
}

/** What one answer cost the student, as the client measured it. */
export interface AnswerTiming {
  timeMs?: number
  changed?: number
}

/** One question as this student answered it, with what it cost them. */
export interface AttemptQuestion {
  questionId: string
  body: string
  type: StudentQuestion['type']
  points: number
  position: number
  /** What they answered, or null when they never touched it. */
  answer: AnswerInput | null
  /** The right answer, from the paper the teacher wrote. */
  correct: Record<string, unknown>
  isCorrect: boolean
  pointsAwarded: number
  timeMs: number | null
  changed: number
}

export interface AttemptEvent {
  kind: 'visible' | 'hidden'
  at: string
}

/** One student's run in one session, in full. */
export interface AttemptDetail {
  userId: string
  username: string
  fullName: string
  status: ParticipationStatus
  score: number | null
  maxScore: number | null
  percent: number | null
  passed: boolean | null
  joinedAt: string
  submittedAt: string | null
  totalTimeMs: number | null
  focusLost: number
  /** The mean over the questions that were timed; null when none were. */
  averageMs: number | null
  slowest: { questionId: string; body: string; timeMs: number } | null
  questions: AttemptQuestion[]
  events: AttemptEvent[]
}

/** One finished attempt in the student's own history. */
export interface StudentResult {
  participationId: string
  sessionId: string
  joinCode: string
  testId: string
  testTitle: string
  questionCount: number
  status: ParticipationStatus
  score: number | null
  maxScore: number | null
  percent: number | null
  passed: boolean | null
  submittedAt: string | null
}

/** Student only: every finished attempt, newest first. */
export async function listStudentResults(): Promise<StudentResult[]> {
  const result = await apiFetch<{ results: StudentResult[] }>('/api/student/results')
  return result.results
}

export async function getSessionResult(sessionId: string): Promise<SessionResultBody> {
  return apiFetch<SessionResultBody>(`/api/sessions/${sessionId}/result`)
}

import { randomUUID } from 'node:crypto'
import { randomCode } from './codes'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from './db'
import type { QuestionType } from './tests'

export type LiveSessionStatus = 'lobby' | 'active' | 'paused' | 'finished'
export type ParticipationStatus = 'joined' | 'submitted' | 'auto_submitted'

export interface LiveSessionRow {
  id: string
  test_id: string
  owner_id: string
  join_code: string
  status: LiveSessionStatus
  time_limit_sec: number | null
  passing_percent: number | null
  /** What the teacher called this run, when they called it anything. */
  name: string | null
  /** The group this run is for; it defaults to the test's own room. */
  room_id: string | null
  /** While set, nobody new may join; the students already in are untouched. */
  entry_locked: number
  created_at: string
  /** Null until the teacher starts the run; the lobby has no clock. */
  started_at: string | null
  finished_at: string | null
}

export interface LiveSession {
  id: string
  testId: string
  ownerId: string
  joinCode: string
  status: LiveSessionStatus
  timeLimitSec: number | null
  passingPercent: number | null
  name: string | null
  roomId: string | null
  entryLocked: boolean
  startedAt: string | null
  finishedAt: string | null
}

export interface ParticipationRow {
  id: string
  session_id: string
  user_id: string
  status: ParticipationStatus
  question_order: string
  score: number | null
  max_score: number | null
  percent: number | null
  passed: number | null
  joined_at: string
  submitted_at: string | null
}

export interface Participation {
  id: string
  sessionId: string
  userId: string
  status: ParticipationStatus
  questionOrder: string[]
  score: number | null
  maxScore: number | null
  percent: number | null
  passed: boolean | null
  joinedAt: string
  submittedAt: string | null
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
  /**
   * The live half, filled in only when a board is being watched: whether a
   * socket is open, whether the window is on screen, and how far they have got.
   * Absent on a list read straight from the database, where none of it exists.
   */
  online?: boolean
  active?: boolean | null
  questionIndex?: number | null
  answered?: number | null
}

/** A question as the student sees it: no correct answers, no other question's payload. */
export interface StudentQuestion {
  id: string
  type: QuestionType
  body: string
  points: number
  position: number
  payload: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Strips the answer key. Choices keep their keys and text (the client submits
 * keys), matching keeps both sides minus the mapping is not stored anyway, and
 * short answers lose the accepted list.
 */
export function toStudentPayload(type: QuestionType, payload: Record<string, unknown>): Record<string, unknown> {
  if (type === 'single_choice' || type === 'multiple_choice') {
    const options = Array.isArray(payload.options) ? payload.options : []
    return {
      options: options.map((option) =>
        isRecord(option) ? { key: option.key, text: option.text } : option,
      ),
    }
  }
  if (type === 'true_false') return {}
  if (type === 'short_answer') return {}
  if (type === 'matching') {
    const pairs = Array.isArray(payload.pairs) ? payload.pairs : []
    return {
      pairs: pairs.map((pair) =>
        isRecord(pair) ? { left: pair.left, right: pair.right } : pair,
      ),
    }
  }
  return {}
}

export function generateJoinCode(db: DatabaseSync): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = randomCode()
    const taken = db.prepare('SELECT 1 FROM live_sessions WHERE join_code = ?').get(code)
    if (!taken) return code
  }
  throw new Error('could not allocate a unique join code')
}

/** Deterministic per-student order: stored on join so a reload never reshuffles. */
export function shuffledQuestionIds(
  questionIds: string[],
  seed: string,
): string[] {
  // FNV-1a keeps the shuffle reproducible without pulling in a dependency.
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const next = (value: number): number => {
    // xorshift32 keeps the sequence identical across runs and platforms.
    let x = value || 0x9e3779b9
    x ^= x << 13
    x >>>= 0
    x ^= x >> 17
    x ^= x << 5
    x >>>= 0
    return x
  }

  const ids = [...questionIds]
  let state = hash
  for (let index = ids.length - 1; index > 0; index -= 1) {
    state = next(state)
    const swap = state % (index + 1)
    const tmp = ids[index] as string
    ids[index] = ids[swap] as string
    ids[swap] = tmp
  }
  return ids
}

export function toSession(row: LiveSessionRow): LiveSession {
  return {
    id: row.id,
    testId: row.test_id,
    ownerId: row.owner_id,
    joinCode: row.join_code,
    status: row.status,
    timeLimitSec: row.time_limit_sec,
    passingPercent: row.passing_percent,
    name: row.name,
    roomId: row.room_id,
    entryLocked: row.entry_locked === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export function toParticipation(row: ParticipationRow): Participation {
  let questionOrder: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.question_order)
    if (Array.isArray(parsed)) {
      questionOrder = parsed.filter((entry): entry is string => typeof entry === 'string')
    }
  } catch {
    questionOrder = []
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    status: row.status,
    questionOrder,
    score: row.score,
    maxScore: row.max_score,
    percent: row.percent,
    passed: row.passed === null ? null : row.passed === 1,
    joinedAt: row.joined_at,
    submittedAt: row.submitted_at,
  }
}

export function findSessionRow(db: DatabaseSync, id: string): LiveSessionRow | null {
  return (
    (db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(id) as LiveSessionRow | undefined) ?? null
  )
}

export function findSessionByCode(db: DatabaseSync, code: string): LiveSessionRow | null {
  return (
    (db
      .prepare('SELECT * FROM live_sessions WHERE join_code = ?')
      .get(code.trim().toUpperCase()) as LiveSessionRow | undefined) ?? null
  )
}

export function createSession(
  db: DatabaseSync,
  input: {
    testId: string
    ownerId: string
    timeLimitSec: number | null
    passingPercent: number | null
    /** What the teacher called this run; null falls back to the test's title. */
    name?: string | null
    /** The group this run is for; null inherits the test's own room. */
    roomId?: string | null
  },
): LiveSession {
  const id = randomUUID()
  const timestamp = nowIso()
  db.prepare(
    `INSERT INTO live_sessions
       (id, test_id, owner_id, join_code, status, time_limit_sec, passing_percent, name, room_id, entry_locked, created_at, started_at)
     VALUES (?, ?, ?, ?, 'lobby', ?, ?, ?, ?, 0, ?, NULL)`,
  ).run(
    id,
    input.testId,
    input.ownerId,
    generateJoinCode(db),
    input.timeLimitSec,
    input.passingPercent,
    input.name?.trim() ? input.name.trim() : null,
    input.roomId ?? null,
    timestamp,
  )
  const row = findSessionRow(db, id)
  if (!row) throw new Error('session insert failed')
  return toSession(row)
}

/**
 * Starts the run: stamps the clock and opens the doors.
 *
 * Called once, from the lobby, when the teacher decides the room is ready. A
 * session that is already past the lobby is left alone, so a double click does
 * not restart a clock that is already running.
 */
export function startSession(db: DatabaseSync, id: string): LiveSession | null {
  const row = findSessionRow(db, id)
  if (!row) return null
  if (row.status !== 'lobby') return toSession(row)
  db.prepare("UPDATE live_sessions SET status = 'active', started_at = ? WHERE id = ?").run(
    nowIso(),
    id,
  )
  const started = findSessionRow(db, id)
  return started ? toSession(started) : null
}

/** Closes or opens the door to new joiners. Whoever is already in is untouched. */
export function setEntryLocked(db: DatabaseSync, id: string, locked: boolean): LiveSession | null {
  db.prepare('UPDATE live_sessions SET entry_locked = ? WHERE id = ?').run(locked ? 1 : 0, id)
  const row = findSessionRow(db, id)
  return row ? toSession(row) : null
}

/** One row per visibility change, so leaving the window is recorded, not punished. */
export function recordParticipationEvent(
  db: DatabaseSync,
  input: { sessionId: string; participationId: string; kind: 'visible' | 'hidden' },
): void {
  db.prepare(
    'INSERT INTO participation_events (id, session_id, participation_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(randomUUID(), input.sessionId, input.participationId, input.kind, nowIso())
}

export function setSessionStatus(
  db: DatabaseSync,
  id: string,
  status: LiveSessionStatus,
): LiveSession | null {
  const finishedAt = status === 'finished' ? nowIso() : null
  db.prepare(
    'UPDATE live_sessions SET status = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?',
  ).run(status, finishedAt, id)
  const row = findSessionRow(db, id)
  return row ? toSession(row) : null
}

export function findParticipation(
  db: DatabaseSync,
  sessionId: string,
  userId: string,
): ParticipationRow | null {
  return (
    (db
      .prepare('SELECT * FROM participations WHERE session_id = ? AND user_id = ?')
      .get(sessionId, userId) as ParticipationRow | undefined) ?? null
  )
}

export function joinSession(
  db: DatabaseSync,
  sessionId: string,
  userId: string,
  questionIds: string[],
): ParticipationRow {
  const existing = findParticipation(db, sessionId, userId)
  if (existing) return existing

  const order = shuffledQuestionIds(questionIds, `${sessionId}:${userId}`)
  const id = randomUUID()
  db.prepare(
    `INSERT INTO participations (id, session_id, user_id, status, question_order, joined_at)
     VALUES (?, ?, ?, 'joined', ?, ?)`,
  ).run(id, sessionId, userId, JSON.stringify(order), nowIso())
  const row = findParticipation(db, sessionId, userId)
  if (!row) throw new Error('participation insert failed')
  return row
}

export interface SessionSummary extends LiveSession {
  title: string
  joinedCount: number
  submittedCount: number
}

/**
 * What a session list can be narrowed by. Every field is optional and the
 * clauses are ANDed: a teacher who filters by "finished, this week, algebra"
 * gets exactly that, and one who filters by nothing gets their last 50.
 *
 * `ids` is the odd one out: it is what a tag filter resolves to before the
 * query runs, so a tag does not need its own join in here.
 */
export interface SessionFilter {
  ownerId?: string | null
  roomId?: string | null
  testId?: string | null
  status?: LiveSessionStatus | null
  /** ISO date; sessions created on or after it. */
  from?: string | null
  /** ISO date; sessions created at or before it. */
  to?: string | null
  /** Matched against the session name and the test title. */
  query?: string | null
  ids?: string[] | null
  /** Which column the list is ordered by; newest first unless asked otherwise. */
  sort?: SessionSort
  dir?: 'asc' | 'desc'
  /** Rows to skip, for paging; the pair with `limit` makes a page. */
  offset?: number
  limit?: number
}

/** The columns a session list can be ordered by. */
export type SessionSort = 'created' | 'name' | 'status' | 'submitted'

const SESSION_SELECT = `
      SELECT s.*, t.title AS title,
              (SELECT COUNT(*) FROM participations p WHERE p.session_id = s.id) AS joined_count,
              (SELECT COUNT(*) FROM participations p WHERE p.session_id = s.id AND p.status != 'joined') AS submitted_count
         FROM live_sessions s
         JOIN tests t ON t.id = s.test_id`

interface SessionRowWithCounts extends LiveSessionRow {
  title: string
  joined_count: number
  submitted_count: number
}

function toSummary(row: SessionRowWithCounts): SessionSummary {
  return {
    ...toSession(row),
    title: row.title,
    joinedCount: row.joined_count,
    submittedCount: row.submitted_count,
  }
}

/**
 * The WHERE the list and its count share.
 *
 * Built once so paging cannot disagree with its own total: a count computed from
 * a second, slightly different set of clauses is how a library ends up saying
 * "37 sessions" above a list of twelve.
 */
function sessionWhere(filter: SessionFilter): { clause: string; values: Array<string | null> } {
  const where: string[] = []
  const values: Array<string | null> = []

  if (filter.ownerId) {
    where.push('s.owner_id = ?')
    values.push(filter.ownerId)
  }
  if (filter.roomId) {
    where.push('s.room_id = ?')
    values.push(filter.roomId)
  }
  if (filter.testId) {
    where.push('s.test_id = ?')
    values.push(filter.testId)
  }
  if (filter.status) {
    where.push('s.status = ?')
    values.push(filter.status)
  }
  if (filter.from) {
    where.push('s.created_at >= ?')
    values.push(filter.from)
  }
  if (filter.to) {
    where.push('s.created_at <= ?')
    values.push(filter.to)
  }
  if (filter.query) {
    where.push("(COALESCE(s.name, '') LIKE ? OR t.title LIKE ?)")
    const like = `%${filter.query}%`
    values.push(like, like)
  }
  if (filter.ids) {
    // A tag that is on nothing resolves to an empty set, which must match
    // nothing rather than everything - and the count has to agree.
    if (filter.ids.length === 0) {
      where.push('1 = 0')
    } else {
      where.push(`s.id IN (${filter.ids.map(() => '?').join(', ')})`)
      values.push(...filter.ids)
    }
  }

  return { clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', values }
}

/**
 * Which column a list is ordered by. Every one of them is a column the teacher
 * can see on the card - sorting by something invisible is a magic trick, not a
 * feature - so `name` falls back to the test title the card shows instead.
 */
const SESSION_ORDER: Record<SessionSort, string> = {
  created: 's.created_at',
  name: 'COALESCE(s.name, t.title)',
  status: 's.status',
  submitted: 'submitted_count',
}

export interface SessionPage {
  sessions: SessionSummary[]
  total: number
}

/**
 * One page of sessions, with the counts the board needs. Pass a filter to narrow
 * it, a sort to order it, and a limit/offset pair to page it.
 */
export function listSessions(db: DatabaseSync, filter: SessionFilter = {}): SessionSummary[] {
  const { clause, values } = sessionWhere(filter)
  const dir = filter.dir === 'asc' ? 'ASC' : 'DESC'
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const offset = Math.max(filter.offset ?? 0, 0)
  const order = SESSION_ORDER[filter.sort ?? 'created']
  // Ties are broken down to the id, so the order is total: a second page can
  // never repeat a row from the first, whatever the chosen column says.
  const sql = `${SESSION_SELECT}
        ${clause}
        ORDER BY ${order} ${dir}, s.created_at DESC, s.id ASC
        LIMIT ${limit} OFFSET ${offset}`
  const rows = db.prepare(sql).all(...values) as unknown as SessionRowWithCounts[]
  return rows.map(toSummary)
}

/** How many sessions the same filter matches, so a library can page honestly. */
export function countSessions(db: DatabaseSync, filter: SessionFilter = {}): number {
  const { clause, values } = sessionWhere(filter)
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM live_sessions s JOIN tests t ON t.id = s.test_id ${clause}`,
    )
    .get(...values) as { total: number }
  return row.total
}

/** One session by id, in the same shape the list returns. */
export function findSessionSummary(db: DatabaseSync, id: string): SessionSummary | null {
  const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as unknown as
    | SessionRowWithCounts
    | undefined
  return row ? toSummary(row) : null
}

/** One row of the student's own result history, joined with test and session. */
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

/**
 * Every attempt the student has finished, newest first. Only rows the student
 * submitted (or that were auto-submitted for them) count as results.
 */
export function listStudentResults(db: DatabaseSync, userId: string, limit = 50): StudentResult[] {
  const rows = db
    .prepare(
      `SELECT p.id              AS participation_id,
              p.session_id      AS session_id,
              p.status          AS status,
              p.score           AS score,
              p.max_score       AS max_score,
              p.percent         AS percent,
              p.passed          AS passed,
              p.submitted_at    AS submitted_at,
              s.join_code       AS join_code,
              s.test_id         AS test_id,
              t.title           AS test_title,
              (SELECT COUNT(*) FROM questions q WHERE q.test_id = s.test_id) AS question_count
         FROM participations p
         JOIN live_sessions s ON s.id = p.session_id
         JOIN tests t ON t.id = s.test_id
        WHERE p.user_id = ? AND p.status != 'joined'
        ORDER BY p.submitted_at DESC
        LIMIT ?`,
    )
    .all(userId, limit) as unknown as Array<{
    participation_id: string
    session_id: string
    status: ParticipationStatus
    score: number | null
    max_score: number | null
    percent: number | null
    passed: number | null
    submitted_at: string | null
    join_code: string
    test_id: string
    test_title: string
    question_count: number
  }>
  return rows.map((row) => ({
    participationId: row.participation_id,
    sessionId: row.session_id,
    joinCode: row.join_code,
    testId: row.test_id,
    testTitle: row.test_title,
    questionCount: row.question_count,
    status: row.status,
    score: row.score,
    maxScore: row.max_score,
    percent: row.percent,
    passed: row.passed === null ? null : row.passed === 1,
    submittedAt: row.submitted_at,
  }))
}

export function listParticipations(db: DatabaseSync, sessionId: string): ParticipationRow[] {
  return db
    .prepare('SELECT * FROM participations WHERE session_id = ? ORDER BY joined_at ASC')
    .all(sessionId) as unknown as ParticipationRow[]
}

export function listParticipantEntries(
  db: DatabaseSync,
  sessionId: string,
): ParticipantEntry[] {
  const rows = db
    .prepare(
      `SELECT p.user_id, u.username, u.full_name, p.status, p.score, p.percent, p.passed,
              p.joined_at, p.submitted_at
         FROM participations p
         JOIN users u ON u.id = p.user_id
        WHERE p.session_id = ?
        ORDER BY p.joined_at ASC`,
    )
    .all(sessionId) as unknown as Array<{
    user_id: string
    username: string
    full_name: string
    status: ParticipationStatus
    score: number | null
    percent: number | null
    passed: number | null
    joined_at: string
    submitted_at: string | null
  }>
  return rows.map((row) => ({
    userId: row.user_id,
    username: row.username,
    fullName: row.full_name,
    status: row.status,
    score: row.score,
    percent: row.percent,
    passed: row.passed === null ? null : row.passed === 1,
    joinedAt: row.joined_at,
    submittedAt: row.submitted_at,
  }))
}

export function saveSubmission(
  db: DatabaseSync,
  participationId: string,
  status: ParticipationStatus,
  results: Array<{ questionId: string; isCorrect: boolean; points: number }>,
  answers: Record<string, unknown>,
  summary: { score: number; maxScore: number; percent: number; passed: boolean | null },
): ParticipationRow | null {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM participation_answers WHERE participation_id = ?').run(participationId)
    const insert = db.prepare(
      `INSERT INTO participation_answers
         (id, participation_id, question_id, payload, is_correct, points_awarded)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const result of results) {
      insert.run(
        randomUUID(),
        participationId,
        result.questionId,
        JSON.stringify(answers[result.questionId] ?? null),
        result.isCorrect ? 1 : 0,
        result.points,
      )
    }
    db.prepare(
      `UPDATE participations
          SET status = ?, score = ?, max_score = ?, percent = ?, passed = ?, submitted_at = ?
        WHERE id = ?`,
    ).run(
      status,
      summary.score,
      summary.maxScore,
      summary.percent,
      summary.passed === null ? null : summary.passed ? 1 : 0,
      nowIso(),
      participationId,
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return (
    (db.prepare('SELECT * FROM participations WHERE id = ?').get(participationId) as
      | ParticipationRow
      | undefined) ?? null
  )
}

/** Unanswered participations of a session, for the timeout sweep. */
export function listOpenParticipations(db: DatabaseSync, sessionId: string): ParticipationRow[] {
  return db
    .prepare("SELECT * FROM participations WHERE session_id = ? AND status = 'joined'")
    .all(sessionId) as unknown as ParticipationRow[]
}

export function isSessionOver(
  session: LiveSession,
  now: number = Date.now(),
): boolean {
  if (session.status === 'finished') return true
  // A lobby has not started, so it has no clock; nothing can run out.
  if (session.startedAt === null) return false
  if (session.timeLimitSec === null) return false
  return now >= Date.parse(session.startedAt) + session.timeLimitSec * 1000
}

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { Database } from '../lib/db'
import { sendError } from '../lib/http'
import { scoreSubmission, type ScoredQuestion } from '../lib/scoring'
import { findTestRow, listQuestions } from '../lib/tests'
import { findRoomById } from '../lib/rooms'
import { entityIdsWithTag, findTagById, setEntityTags, tagsByEntity, type Tag } from '../lib/tags'
import {
  parseSettings,
  SETTINGS_BODY_SCHEMA,
  type TestSettings,
} from '../lib/testSettings'
import {
  findParticipation,
  createSession,
  findSessionByCode,
  findSessionRow,
  isSessionOver,
  joinSession,
  listOpenParticipations,
  listParticipantEntries,
  listSessions,
  recordParticipationEvent,
  setEntryLocked,
  extendSession,
  setResultsReleased,
  setSessionSettings,
  startSession,
  listStudentResults,
  countSessions,
  findSessionSummary,
  type SessionSort,
  saveSubmission,
  setSessionStatus,
  toParticipation,
  toSession,
  toStudentPayload,
  type LiveSession,
  type ParticipantEntry,
  type ParticipationRow,
  type LiveSessionStatus,
  type Participation,
  type AnswerTiming,
  attemptDetail,
} from '../lib/sessions'
import {
  addSocket,
  broadcast,
  clearPresence,
  isOnline,
  joinRoom,
  leaveRoom,
  presenceOf,
  removeSocket,
  sendTo,
  setPresence,
  type LiveClient,
} from '../lib/live'
import { requireRoles } from '../plugins/auth'
import { resolveSession } from '../lib/tokens'
import { sessionExport, sessionResultsCsv } from '../lib/results'

export interface SessionRoutesDeps {
  database: Database
}

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
} as const

const codeBodySchema = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  // Codes are read aloud in class and pasted from a slide, so the length is
  // deliberately loose: findSessionByCode trims, upper-cases and matches.
  properties: { code: { type: 'string', minLength: 1, maxLength: 32 } },
} as const

const createBodySchema = {
  type: 'object',
  required: ['testId'],
  additionalProperties: false,
  properties: {
    testId: { type: 'string', minLength: 36, maxLength: 36 },
    name: { type: ['string', 'null'], maxLength: 120 },
    roomId: { type: ['string', 'null'], maxLength: 36 },
    tags: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 20 },
    settings: SETTINGS_BODY_SCHEMA,
  },
} as const

/**
 * What a session list can be narrowed by. All optional: a request with none of
 * them is the plain newest-first list, which is what the Live tab asks for.
 */
const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    room: { type: 'string', maxLength: 36 },
    test: { type: 'string', maxLength: 36 },
    status: { type: 'string', enum: ['lobby', 'active', 'paused', 'finished'] },
    from: { type: 'string', maxLength: 40 },
    to: { type: 'string', maxLength: 40 },
    q: { type: 'string', maxLength: 120 },
    tag: { type: 'string', maxLength: 36 },
    sort: { type: 'string', enum: ['created', 'name', 'status', 'submitted'] },
    dir: { type: 'string', enum: ['asc', 'desc'] },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: { type: 'integer', minimum: 0 },
  },
} as const

const answersBodySchema = {
  type: 'object',
  required: ['answers'],
  additionalProperties: false,
  properties: {
    answers: { type: 'object' },
    // What each answer cost the student: how long they sat on it, and how many
    // times they went back. Optional, because a client that never measured is
    // an old client, not a broken one.
    timings: { type: 'object' },
  },
} as const

const participantParamsSchema = {
  type: 'object',
  required: ['id', 'userId'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 36, maxLength: 36 },
    userId: { type: 'string', minLength: 36, maxLength: 36 },
  },
} as const

interface CreateBody {
  testId: string
  name?: string | null
  roomId?: string | null
  tags?: string[]
  settings?: Partial<TestSettings>
}

/** The list query, after validation. */
interface ListQuery {
  room?: string
  test?: string
  status?: LiveSessionStatus
  from?: string
  to?: string
  q?: string
  tag?: string
  sort?: SessionSort
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

interface CodeBody {
  code: string
}

interface AnswersBody {
  answers: Record<string, unknown>
  timings?: Record<string, AnswerTiming>
}

interface SessionResponse {
  session: LiveSession & {
    /** What the run is labelled with; every screen that shows one wants it. */
    tags: Tag[]
    test: { id: string; title: string; questionCount: number }
  }
}

interface ParticipationResponse {
  participation: Participation
  session: {
    id: string
    status: LiveSessionStatus
    timeLimitSec: number | null
    passingPercent: number | null
    /** The run's options, so the runner knows one page or all, and back or not. */
    settings: TestSettings
    /** Null while the run is still a lobby: there is no clock yet. */
    startedAt: string | null
    /** Set while the run is on hold; the runner's clock stops at this mark. */
    pausedAt: string | null
    serverNow: string
  }
  questions: Array<{
    id: string
    type: string
    body: string
    points: number
    position: number
    payload: Record<string, unknown>
  }>
}

/**
 * The status frame every client on the socket receives.
 *
 * The clock is in it, not only the status word: a phone that heard "paused"
 * without hearing when would keep counting its own old deadline down, and a
 * phone that heard nothing about "+15s" would never show the extra time at all.
 */
interface StatusFrame {
  type: 'status'
  status: LiveSessionStatus
  serverNow: string
  startedAt: string | null
  pausedAt: string | null
  timeLimitSec: number | null
}

/** Questions of the session in the student's stored order, without answer keys. */
function studentQuestions(
  questions: ReturnType<typeof listQuestions>,
  order: string[],
  optionOrder: Record<string, string[]> = {},
) {
  const byId = new Map(questions.map((question) => [question.id, question]))
  return order.flatMap((id, index) => {
    const question = byId.get(id)
    if (!question) return []
    return [
      {
        id: question.id,
        type: question.type,
        body: question.body,
        points: question.points,
        position: index,
        payload: toStudentPayload(question.type, question.payload, optionOrder[question.id]),
      },
    ]
  })
}

function scoredQuestions(questions: ReturnType<typeof listQuestions>, order: string[]): ScoredQuestion[] {
  const byId = new Map(questions.map((question) => [question.id, question]))
  const result: ScoredQuestion[] = []
  for (const id of order) {
    const question = byId.get(id)
    if (question) result.push({ id: question.id, type: question.type, payload: question.payload, points: question.points })
  }
  return result
}

export const sessionRoutes: FastifyPluginAsync<SessionRoutesDeps> = async (
  app: FastifyInstance,
  { database },
) => {
  const db = database.raw

  /** Grading source: the participation's stored order, falling back to the test. */
  function questionsFor(participation: Participation, testId: string) {
    const questions = listQuestions(db, testId)
    const order = participation.questionOrder.length > 0
      ? participation.questionOrder
      : questions.map((question) => question.id)
    return { questions, order }
  }

  /**
   * How long past the deadline a paper is still taken.
   *
   * The runner sends its own paper the moment its clock reaches zero, and the
   * sweep must not beat a send that is already on the wire - grading an empty
   * sheet over answers the student did give. Ten seconds is far longer than a
   * request needs and short enough that a class that walked away is settled
   * before the teacher looks twice.
   */
  const EXPIRY_GRACE_MS = 10_000

  /**
   * Closes a session that ran out of time, grading everyone who is still
   * working so nobody loses an attempt to a forgotten timer.
   *
   * Only the clock sweeps. A run the teacher ended is not a clock running out:
   * the paper of whoever is mid-answer lives in their browser, and the runner
   * hands it back to them in a window so they can send it themselves. Grading
   * the empty sheet here would throw that work away, so a finished run is left
   * to those students - whoever never comes back stays on the board as not
   * submitted, which is what happened.
   */
  function autoSubmitExpired(session: LiveSession): LiveSession {
    if (session.status === 'finished') return session
    if (!isSessionOver(session, Date.now() - EXPIRY_GRACE_MS)) return session
    const test = findTestRow(db, session.testId)
    if (!test) return session
    const questions = listQuestions(db, session.testId)
    for (const row of listOpenParticipations(db, session.id)) {
      const participation = toParticipation(row)
      const { order } = questionsFor(participation, session.testId)
      const graded = scoreSubmission(scoredQuestions(questions, order), {}, session.passingPercent)
      saveSubmission(db, participation.id, 'auto_submitted', graded.results, {}, graded.summary)
    }
    return setSessionStatus(db, session.id, 'finished') ?? session
  }

  /**
   * The board: the stored rows with the live half folded in.
   *
   * Presence is memory, not a table, so it is merged here - at the one place a
   * board is assembled - rather than being taught to the database layer.
   */
  function boardEntries(sessionId: string): ParticipantEntry[] {
    const live = presenceOf(sessionId)
    return listParticipantEntries(db, sessionId).map((entry) => {
      const presence = live.get(entry.userId)
      return {
        ...entry,
        online: isOnline(sessionId, entry.userId),
        active: presence ? presence.visible : null,
        questionIndex: presence ? presence.questionIndex : null,
        answered: presence ? presence.answered : null,
      }
    })
  }

  /** The frame every socket on this run receives, whenever the run changes. */
  function statusFrame(session: LiveSession): StatusFrame {
    return {
      type: 'status',
      status: session.status,
      serverNow: new Date().toISOString(),
      startedAt: session.startedAt,
      pausedAt: session.pausedAt,
      timeLimitSec: session.timeLimitSec,
    }
  }

  /** Pushes the new state to everyone watching, and the board to the teachers. */
  function announce(session: LiveSession): void {
    const status: LiveSessionStatus = session.status
    // The clock rides along with the status, and that is the whole fix for a
    // phone that never notices the clock: a status word alone says "paused"
    // without saying what the clock reads, and "+15s" changes nothing a client
    // would hear. Resuming moves `startedAt` forward by the length of the hold,
    // so the same four numbers cover a pause, a resume and an extension, and
    // every client runs the server's deadline rather than a tally of its own.
    broadcast(session.id, statusFrame(session))
    broadcast(session.id, { type: 'participants', participants: boardEntries(session.id) }, true)
    // A finished run has no room left to watch; the in-memory presence goes with
    // it so a long-lived server does not accumulate sessions nobody can see.
    if (status === 'finished') clearPresence(session.id)
  }

  function sessionPayload(session: LiveSession): SessionResponse {
    const test = findTestRow(db, session.testId)
    return {
      session: {
        ...session,
        // The list and the single read both carry the run's tags; an action
        // response has to match, or `toSession` - which reads only the row -
        // would hand the board an unlabelled session to fold over the one on
        // screen, and the teacher's own labels would vanish on every press.
        tags: tagsByEntity(db, 'session', [session.id]).get(session.id) ?? [],
        test: {
          id: session.testId,
          title: test ? test.title : '',
          questionCount: test ? listQuestions(db, session.testId).length : 0,
        },
      },
    }
  }

  // ---------------------------------------------------------------- teacher

  /** Session list: a teacher sees their own, an admin sees every teacher's. */
  app.get(
    '/api/sessions',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { querystring: listQuerySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const query = request.query as ListQuery
      // A tag is a label on the entity, so the filter resolves it to ids first
      // and the list narrows on those: one shape of filtering, not two.
      let ids: string[] | null = null
      if (query.tag) {
        const tag = findTagById(db, query.tag)
        if (!tag) return reply.code(200).send({ sessions: [], total: 0 })
        ids = entityIdsWithTag(db, tag.id, 'session')
      }
      const filter = {
        ownerId: session.role === 'admin' ? null : session.userId,
        roomId: query.room ?? null,
        testId: query.test ?? null,
        status: query.status ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        query: query.q ?? null,
        ids,
        sort: query.sort,
        dir: query.dir,
        offset: query.offset,
        limit: query.limit,
      }
      const sessions = listSessions(db, filter)
      const bySession = tagsByEntity(db, 'session', sessions.map((entry) => entry.id))
      return {
        sessions: sessions.map((entry) => ({
          ...entry,
          tags: bySession.get(entry.id) ?? [],
        })),
        // The total belongs to the filter, not to the page: it is what a
        // library counts pages against.
        total: countSessions(db, filter),
      }
    },
  )

  /** One session, for a screen that arrived at it directly rather than by list. */
  app.get(
    '/api/sessions/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const found = findSessionSummary(db, params.id)
      if (!found) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      if (session.role !== 'admin' && found.ownerId !== session.userId) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const tags = tagsByEntity(db, 'session', [found.id]).get(found.id) ?? []
      return { session: { ...found, tags } }
    },
  )

  /** Starts a live run of one of the teacher's own tests. */
  app.post(
    '/api/sessions',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { body: createBodySchema },
    },
    async (request, reply) => {
      const body = request.body as CreateBody
      const { testId } = body
      const test = findTestRow(db, testId)
      if (!test) {
        return sendError(reply, 404, 'NOT_FOUND', 'test not found')
      }
      if (test.owner_id !== request.session?.userId && request.session?.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'this test belongs to another teacher')
      }
      if (listQuestions(db, testId).length === 0) {
        return sendError(reply, 400, 'VALIDATION', 'add questions before starting a session')
      }
      // A run inherits the test's group unless the teacher says otherwise: most
      // of the time the paper was written for one class and that is who is here.
      let roomId = test.room_id
      if (body.roomId !== undefined) {
        if (body.roomId === null) {
          roomId = null
        } else {
          const room = findRoomById(db, body.roomId)
          if (!room) return sendError(reply, 400, 'VALIDATION', 'no such room')
          if (room.owner_id !== request.session?.userId && request.session?.role !== 'admin') {
            return sendError(reply, 403, 'FORBIDDEN', 'that room belongs to another teacher')
          }
          roomId = room.id
        }
      }
      const created = createSession(db, {
        testId,
        ownerId: test.owner_id,
        timeLimitSec: test.time_limit_sec,
        passingPercent: test.passing_percent,
        name: body.name ?? null,
        roomId,
        // The caller may set the run's options in the start dialog; otherwise the
        // run takes the test's defaults, snapshotted so a later edit cannot move
        // the goalposts under a student.
        settings: body.settings
          ? parseSettings(JSON.stringify(body.settings))
          : parseSettings(test.settings),
      })
      if (body.tags !== undefined) {
        setEntityTags(db, request.session!.userId, 'session', created.id, body.tags)
      }
      return reply.code(201).send(sessionPayload(created))
    },
  )

  /**
   * Gives the run more time: a teacher watching a class run out of a minute can
   * add one without restarting anything. Only a run that has a clock has one to
   * give, so a run with no limit is left as it is.
   */
  app.post(
    '/api/sessions/:id/extend',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: {
        params: idParamsSchema,
        body: {
          type: 'object',
          required: ['seconds'],
          additionalProperties: false,
          properties: { seconds: { type: 'integer', minimum: 1, maximum: 3600 } },
        },
      },
    },
    async (request, reply) => {
      const session = request.session!
      const { id } = request.params as { id: string }
      const row = findSessionRow(db, id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      const current = toSession(row)
      if (current.ownerId !== session.userId && session.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'this session belongs to another teacher')
      }
      const { seconds } = request.body as { seconds: number }
      const updated = extendSession(db, id, seconds) ?? current
      announce(updated)
      return sessionPayload(updated)
    },
  )

  /**
   * Lets the results out. Only meaningful when the run holds them; from then on
   * submitting students see their score, and `released` flips for the board.
   */
  app.post(
    '/api/sessions/:id/release',
    { preHandler: requireRoles('admin', 'teacher'), schema: { params: idParamsSchema } },
    async (request, reply) => {
      const session = request.session!
      const { id } = request.params as { id: string }
      const row = findSessionRow(db, id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      const current = toSession(row)
      if (current.ownerId !== session.userId && session.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'this session belongs to another teacher')
      }
      const updated = setResultsReleased(db, id, true) ?? current
      announce(updated)
      return sessionPayload(updated)
    },
  )

  /** Live participant board for a session the teacher owns. */
  app.get(
    '/api/sessions/:id/participants',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const row = findSessionRow(db, id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      let session = autoSubmitExpired(toSession(row))
      if (session.ownerId !== request.session?.userId && request.session?.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'this session belongs to another teacher')
      }
      if (session.status === 'finished' && row.status !== 'finished') announce(session)
      return {
        session,
        participants: boardEntries(session.id),
      }
    },
  )

  /** Pauses, resumes or finishes a session. */
  app.patch(
    '/api/sessions/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: {
        params: idParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            status: { type: 'string', enum: ['paused', 'active', 'finished'] },
            entryLocked: { type: 'boolean' },
            settings: SETTINGS_BODY_SCHEMA,
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { status, entryLocked, settings } = request.body as {
        status?: LiveSessionStatus
        entryLocked?: boolean
        settings?: Partial<TestSettings>
      }
      const row = findSessionRow(db, id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      let session = toSession(row)
      if (session.ownerId !== request.session?.userId && request.session?.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'this session belongs to another teacher')
      }
      if (entryLocked !== undefined) {
        session = setEntryLocked(db, id, entryLocked) ?? session
      }
      if (settings !== undefined) {
        // Only before it starts: the paper is handed out at the start, and
        // changing the rules mid-run would change them for people mid-answer.
        if (session.status !== 'lobby') {
          return sendError(reply, 409, 'CONFLICT', 'settings can only change in the lobby')
        }
        session = setSessionSettings(db, id, parseSettings(JSON.stringify(settings))) ?? session
      }
      if (status !== undefined) {
        if (session.status === 'finished') {
          return sendError(reply, 409, 'CONFLICT', 'this session is already finished')
        }
        session = setSessionStatus(db, id, status) ?? session
      }
      announce(session)
      return sessionPayload(session)
    },
  )

  /**
   * Throws a run away: a session opened on the wrong paper, or twice by mistake,
   * is not something a teacher wants to keep in the library forever.
   *
   * A run that is still going is refused - students are answering in it, and a
   * board that vanishes under them is worse than a row that stays. Finishing it
   * first is one tap. Everything a run produced hangs off it by foreign key, so
   * the delete takes the participants, their answers and their events with it.
   */
  app.delete(
    '/api/sessions/:id',
    { preHandler: requireRoles('admin', 'teacher'), schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const row = findSessionRow(db, id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      const session = toSession(row)
      if (session.ownerId !== request.session?.userId && request.session?.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'this session belongs to another teacher')
      }
      if (session.status === 'active' || session.status === 'paused') {
        return sendError(reply, 409, 'CONFLICT', 'finish the run before deleting it')
      }
      db.prepare('DELETE FROM live_sessions WHERE id = ?').run(id)
      return reply.code(204).send()
    },
  )

  /**
   * Opens the doors: stamps the clock and flips the lobby to a running session.
   * Only meaningful from the lobby; starting a started run leaves it alone.
   */
  app.post(
    '/api/sessions/:id/start',
    { preHandler: requireRoles('admin', 'teacher'), schema: { params: idParamsSchema } },
    async (request, reply) => {
      const session = request.session!
      const { id } = request.params as { id: string }
      const row = findSessionRow(db, id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      const current = toSession(row)
      if (current.ownerId !== session.userId && session.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'this session belongs to another teacher')
      }
      if (current.status === 'finished') {
        return sendError(reply, 409, 'CONFLICT', 'this session is already finished')
      }
      const started = startSession(db, id) ?? current
      announce(started)
      return sessionPayload(started)
    },
  )

  /** The session as a spreadsheet: one row per participant, ready to open. */
  app.get(
    '/api/sessions/:id/results.csv',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const row = findSessionRow(db, id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      const session = toSession(row)
      if (session.ownerId !== request.session?.userId && request.session?.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'this session belongs to another teacher')
      }
      const test = findTestRow(db, session.testId)
      const { filename, csv } = sessionResultsCsv(db, id, test ? test.title : '')
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(csv)
    },
  )

  /**
   * One student's run in full: what they got right, how long each question took,
   * how many times they changed an answer, and when the window went hidden.
   *
   * This is the teacher's own run, so it carries the answer key the student was
   * never shown - which is the point of looking at it after the fact.
   */
  app.get(
    '/api/sessions/:id/participants/:userId',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: participantParamsSchema },
    },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string }
      const row = findSessionRow(db, id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      const session = toSession(row)
      if (session.ownerId !== request.session?.userId && request.session?.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'this session belongs to another teacher')
      }
      const detail = attemptDetail(db, id, session.testId, userId)
      if (detail === null) {
        return sendError(reply, 404, 'NOT_FOUND', 'this student was not in this run')
      }
      return { detail }
    },
  )

  /**
   * The same results in whichever shape the teacher picked in the save dialog.
   * One reader, two writers, so a column cannot mean two things across formats.
   *
   * `pdf` used to be a third writer. It is refused by name rather than by the
   * schema so the answer says why: a PDF built here has only the standard
   * Helvetica and no Cyrillic, so the class list came out transliterated. Print
   * the screen instead - the browser embeds the fonts.
   */
  app.get(
    '/api/sessions/:id/results',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: {
        params: idParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { format: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const row = findSessionRow(db, id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      const session = toSession(row)
      if (session.ownerId !== request.session?.userId && request.session?.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'this session belongs to another teacher')
      }
      const test = findTestRow(db, session.testId)
      const format = (request.query as { format?: string }).format ?? 'csv'
      if (format !== 'csv' && format !== 'txt') {
        return sendError(reply, 400, 'UNSUPPORTED_FORMAT', 'results are written as csv or txt')
      }
      const { filename, contentType, body } = sessionExport(
        db,
        id,
        test ? test.title : '',
        format,
      )
      return reply
        .type(contentType)
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(body instanceof Uint8Array ? Buffer.from(body) : body)
    },
  )

  /** Questions plus the answer key, for the teacher's own review screen. */
  app.get(
    '/api/sessions/:id/review',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const row = findSessionRow(db, id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      const session = toSession(row)
      if (session.ownerId !== request.session?.userId && request.session?.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'this session belongs to another teacher')
      }
      const test = findTestRow(db, session.testId)
      const questions = listQuestions(db, session.testId)
      return {
        session,
        test: test ? { id: test.id, title: test.title } : null,
        questions,
      }
    },
  )

  // ---------------------------------------------------------------- student

  /** Joins by short code and returns the shuffled paper without answer keys. */
  app.post(
    '/api/sessions/join',
    {
      preHandler: requireRoles('student'),
      schema: { body: codeBodySchema },
    },
    async (request, reply) => {
      const { code } = request.body as CodeBody
      const row = findSessionByCode(db, code)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'no session with that code')
      const session = autoSubmitExpired(toSession(row))
      if (session.status === 'finished') {
        return sendError(reply, 409, 'CONFLICT', 'this session is already finished')
      }
      if (session.status === 'paused') {
        return sendError(reply, 409, 'CONFLICT', 'this session is paused')
      }
      // Locked means no *new* students; somebody already in keeps their seat, so
      // a reload during a locked run does not throw them out of it.
      const alreadyIn = findParticipation(db, session.id, request.session!.userId)
      if (session.entryLocked && !alreadyIn) {
        return sendError(reply, 409, 'ENTRY_LOCKED', 'this session is closed to new students')
      }
      const questions = listQuestions(db, session.testId)
      const participationRow = joinSession(
        db,
        session.id,
        request.session!.userId,
        questions.map((question) => ({ id: question.id, payload: question.payload })),
        session.settings,
      )
      const participation = toParticipation(participationRow)
      const { order } = questionsFor(participation, session.testId)
      const body: ParticipationResponse = {
        participation,
        session: {
          id: session.id,
          status: session.status,
          timeLimitSec: session.timeLimitSec,
          passingPercent: session.passingPercent,
          settings: session.settings,
          startedAt: session.startedAt,
          pausedAt: session.pausedAt,
          serverNow: new Date().toISOString(),
        },
        questions: studentQuestions(questions, order, participation.optionOrder),
      }
      return reply.code(201).send(body)
    },
  )

  /** Re-reads the paper and the clock; safe to poll while answering. */
  app.get(
    '/api/sessions/current',
    { preHandler: requireRoles('student') },
    async (request, reply) => {
      const userId = request.session!.userId
      // Only work still in progress: handing back a paper the student already
      // submitted would drop them onto a screen they cannot submit again.
      const participationRow = db
        .prepare(
          `SELECT p.* FROM participations p
             JOIN live_sessions s ON s.id = p.session_id
            WHERE p.user_id = ? AND p.status = 'joined' AND s.status != 'finished'
            ORDER BY p.joined_at DESC
            LIMIT 1`,
        )
        .get(userId) as ParticipationRow | undefined
      if (!participationRow) {
        return sendError(reply, 404, 'NOT_FOUND', 'no active session')
      }
      const sessionRow = findSessionRow(db, participationRow.session_id)
      if (!sessionRow) return sendError(reply, 404, 'NOT_FOUND', 'no active session')
      const session = autoSubmitExpired(toSession(sessionRow))
      const participation = toParticipation(participationRow)
      const questions = listQuestions(db, session.testId)
      const { order } = questionsFor(participation, session.testId)
      const body: ParticipationResponse = {
        participation,
        session: {
          id: session.id,
          status: session.status,
          timeLimitSec: session.timeLimitSec,
          passingPercent: session.passingPercent,
          settings: session.settings,
          startedAt: session.startedAt,
          pausedAt: session.pausedAt,
          serverNow: new Date().toISOString(),
        },
        questions: studentQuestions(questions, order, participation.optionOrder),
      }
      return body
    },
  )

  /** Submits the paper, grades it and returns the result. */
  app.post(
    '/api/sessions/:id/submit',
    {
      preHandler: requireRoles('student'),
      schema: { params: idParamsSchema, body: answersBodySchema },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { answers, timings } = request.body as AnswersBody
      const sessionRow = findSessionRow(db, id)
      if (!sessionRow) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      const session = autoSubmitExpired(toSession(sessionRow))
      const row = findParticipation(db, id, request.session!.userId)
      if (!row) return sendError(reply, 403, 'FORBIDDEN', 'you have not joined this session')
      const participation = toParticipation(row)
      if (participation.status !== 'joined') {
        return sendError(reply, 409, 'CONFLICT', 'you already submitted this session')
      }
      // The paper does not exist yet in a lobby: the teacher has not started the
      // run, and grading one early would score an empty sheet the student never
      // saw.
      if (session.status === 'lobby') {
        return sendError(reply, 409, 'CONFLICT', 'the session has not started yet')
      }
      const questions = listQuestions(db, session.testId)
      const { order } = questionsFor(participation, session.testId)
      const graded = scoreSubmission(scoredQuestions(questions, order), answers, session.passingPercent)
      const saved = saveSubmission(
        db,
        participation.id,
        'submitted',
        graded.results,
        answers,
        graded.summary,
        timings,
      )
      if (!saved) return sendError(reply, 500, 'INTERNAL', 'could not save the submission')
      announce(session)
      const held = session.settings.releaseResults === 'teacher' && !session.resultsReleased
      return {
        participation: toParticipation(saved),
        // Held results are not a missing result: `released: false` says the paper
        // was graded and the teacher has not let it out yet.
        result: held ? null : graded.summary,
        released: !held,
      }
    },
  )

  /** The student's own history: every finished attempt, newest first. */
  app.get('/api/student/results', { preHandler: requireRoles('student') }, async (request) => {
    return { results: listStudentResults(db, request.session!.userId) }
  })

  /** The student's own result, including the per-question breakdown. */
  app.get(
    '/api/sessions/:id/result',
    {
      preHandler: requireRoles('student'),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const row = findParticipation(db, id, request.session!.userId)
      if (!row) return sendError(reply, 403, 'FORBIDDEN', 'you have not joined this session')
      const participation = toParticipation(row)
      const sessionRow = findSessionRow(db, id)
      if (!sessionRow) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      const session = toSession(sessionRow)
      if (participation.status === 'joined') {
        return sendError(reply, 409, 'CONFLICT', 'you have not submitted yet')
      }
      if (session.settings.releaseResults === 'teacher' && !session.resultsReleased) {
        return sendError(reply, 409, 'RESULT_HELD', 'the teacher has not released the results yet')
      }
      const test = findTestRow(db, session.testId)
      const questions = listQuestions(db, session.testId)
      const { order } = questionsFor(participation, session.testId)
      const byId = new Map(questions.map((question) => [question.id, question]))
      const answers = db
        .prepare('SELECT * FROM participation_answers WHERE participation_id = ?')
        .all(participation.id) as Array<{
        question_id: string
        payload: string
        is_correct: number
        points_awarded: number
      }>
      const answerByQuestion = new Map(answers.map((answer) => [answer.question_id, answer]))

      return {
        participation,
        session: { id: session.id, status: session.status },
        test: test
          ? { id: test.id, title: test.title, passingPercent: test.passing_percent }
          : null,
        questions: order.flatMap((questionId) => {
          const question = byId.get(questionId)
          if (!question) return []
          const answer = answerByQuestion.get(questionId)
          return [
            {
              id: question.id,
              type: question.type,
              body: question.body,
              points: question.points,
              // With the answers hidden, the student payload is sent instead of
              // the stored one - same shape, without the key inside it.
              payload:
                session.settings.showCorrectAnswers === 'never'
                  ? toStudentPayload(
                      question.type,
                      question.payload,
                      participation.optionOrder[question.id],
                    )
                  : question.payload,
              isCorrect: answer ? answer.is_correct === 1 : false,
              pointsAwarded: answer ? answer.points_awarded : 0,
            },
          ]
        }),
      }
    },
  )

  /**
   * Live channel for one session. Browsers cannot set headers on a WebSocket
   * handshake, so the token travels in the query string like the join link.
   * Teachers receive the participant board, students receive status changes.
   */
  app.get('/ws/sessions/:id', { websocket: true }, (socket, request) => {
    const { id } = request.params as { id: string }
    const token = (request.query as { token?: string }).token ?? ''
    const authed = resolveSession(db, token)
    if (!authed) {
      socket.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'authentication required' }))
      socket.close(4401, 'unauthorized')
      return
    }
    const row = findSessionRow(db, id)
    if (!row) {
      socket.send(JSON.stringify({ type: 'error', code: 'NOT_FOUND', message: 'session not found' }))
      socket.close(4404, 'not found')
      return
    }
    const session = toSession(row)
    const isAdmin = authed.role === 'admin'
    const isOwner = session.ownerId === authed.userId
    if (authed.role === 'student') {
      // A student may only watch a session they actually joined.
      if (!findParticipation(db, id, authed.userId)) {
        socket.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'not your session' }))
        socket.close(4403, 'forbidden')
        return
      }
    } else if (!isOwner && !isAdmin) {
      socket.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'not your session' }))
      socket.close(4403, 'forbidden')
      return
    }

    const client: LiveClient = {
      socket,
      userId: authed.userId,
      role: authed.role as LiveClient['role'],
      isTeacher: authed.role !== 'student',
    }
    joinRoom(id, client)
    addSocket(id, client.userId)
    // The same frame `announce` sends: a socket that opens mid-run has to learn
    // the clock as well as the status, or the client falls back to whatever its
    // last fetch said.
    sendTo(client, statusFrame(session))
    if (client.isTeacher) {
      sendTo(client, { type: 'participants', participants: boardEntries(id) })
    }

    /**
     * What a student tells the room about themselves, and nothing else: whether
     * their window is on screen, and how far through the paper they are. A
     * teacher socket has no business sending either, so it is ignored.
     */
    socket.on('message', (raw: unknown) => {
      if (client.isTeacher) return
      let message: { type?: string; visible?: unknown; questionIndex?: unknown; answered?: unknown }
      try {
        message = JSON.parse(String(raw)) as typeof message
      } catch {
        return
      }
      const participation = findParticipation(db, id, client.userId)
      if (!participation) return
      if (message.type === 'presence' && typeof message.visible === 'boolean') {
        const before = presenceOf(id).get(client.userId)
        setPresence(id, client.userId, { visible: message.visible })
        // Only a change is an event: a heartbeat every few seconds would fill
        // the record with rows that all say the same thing.
        if (!before || before.visible !== message.visible) {
          recordParticipationEvent(db, {
            sessionId: id,
            participationId: participation.id,
            kind: message.visible ? 'visible' : 'hidden',
          })
        }
      } else if (message.type === 'progress') {
        setPresence(id, client.userId, {
          ...(typeof message.questionIndex === 'number'
            ? { questionIndex: message.questionIndex }
            : {}),
          ...(typeof message.answered === 'number' ? { answered: message.answered } : {}),
        })
      } else {
        return
      }
      broadcast(id, { type: 'participants', participants: boardEntries(id) }, true)
    })

    const disconnect = (): void => {
      leaveRoom(id, client)
      // The last socket closing is when somebody is actually gone; a reload
      // opens the next one before this fires.
      if (removeSocket(id, client.userId)) {
        broadcast(id, { type: 'participants', participants: boardEntries(id) }, true)
      }
    }
    socket.on('close', disconnect)
    socket.on('error', disconnect)
  })
}

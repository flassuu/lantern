import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { Database } from '../lib/db'
import { sendError } from '../lib/http'
import { scoreSubmission, type ScoredQuestion } from '../lib/scoring'
import { findTestRow, listQuestions } from '../lib/tests'
import { findRoomById } from '../lib/rooms'
import { entityIdsWithTag, findTagById, setEntityTags, tagsByEntity } from '../lib/tags'
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
  type ParticipationRow,
  type LiveSessionStatus,
  type Participation,
} from '../lib/sessions'
import { broadcast, joinRoom, leaveRoom, sendTo, type LiveClient } from '../lib/live'
import { requireRoles } from '../plugins/auth'
import { resolveSession } from '../lib/tokens'
import { sessionResultsCsv } from '../lib/results'

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
    status: { type: 'string', enum: ['active', 'paused', 'finished'] },
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
  properties: { answers: { type: 'object' } },
} as const

interface CreateBody {
  testId: string
  name?: string | null
  roomId?: string | null
  tags?: string[]
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
}

interface SessionResponse {
  session: LiveSession & { test: { id: string; title: string; questionCount: number } }
}

interface ParticipationResponse {
  participation: Participation
  session: {
    id: string
    status: LiveSessionStatus
    timeLimitSec: number | null
    passingPercent: number | null
    startedAt: string
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

/** Questions of the session in the student's stored order, without answer keys. */
function studentQuestions(
  questions: ReturnType<typeof listQuestions>,
  order: string[],
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
        payload: toStudentPayload(question.type, question.payload),
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
   * Closes a session that ran out of time, grading everyone who is still
   * working so nobody loses an attempt to a forgotten timer.
   */
  function autoSubmitExpired(session: LiveSession): LiveSession {
    if (!isSessionOver(session)) return session
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

  /** Pushes the new state to everyone watching, and the board to the teachers. */
  function announce(session: LiveSession): void {
    const status: LiveSessionStatus = session.status
    broadcast(session.id, { type: 'status', status, serverNow: new Date().toISOString() })
    broadcast(session.id, { type: 'participants', participants: listParticipantEntries(db, session.id) }, true)
  }

  function sessionPayload(session: LiveSession): SessionResponse {
    const test = findTestRow(db, session.testId)
    return {
      session: {
        ...session,
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
      })
      if (body.tags !== undefined) {
        setEntityTags(db, request.session!.userId, 'session', created.id, body.tags)
      }
      return reply.code(201).send(sessionPayload(created))
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
        participants: listParticipantEntries(db, session.id),
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
          required: ['status'],
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['paused', 'active', 'finished'] } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { status } = request.body as { status: LiveSessionStatus }
      const row = findSessionRow(db, id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      const session = toSession(row)
      if (session.ownerId !== request.session?.userId && request.session?.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'this session belongs to another teacher')
      }
      if (session.status === 'finished') {
        return sendError(reply, 409, 'CONFLICT', 'this session is already finished')
      }
      const updated = setSessionStatus(db, id, status) ?? session
      announce(updated)
      return sessionPayload(updated)
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
      const questions = listQuestions(db, session.testId)
      const participationRow = joinSession(
        db,
        session.id,
        request.session!.userId,
        questions.map((question) => question.id),
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
          startedAt: session.startedAt,
          serverNow: new Date().toISOString(),
        },
        questions: studentQuestions(questions, order),
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
          startedAt: session.startedAt,
          serverNow: new Date().toISOString(),
        },
        questions: studentQuestions(questions, order),
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
      const { answers } = request.body as AnswersBody
      const sessionRow = findSessionRow(db, id)
      if (!sessionRow) return sendError(reply, 404, 'NOT_FOUND', 'session not found')
      const session = autoSubmitExpired(toSession(sessionRow))
      const row = findParticipation(db, id, request.session!.userId)
      if (!row) return sendError(reply, 403, 'FORBIDDEN', 'you have not joined this session')
      const participation = toParticipation(row)
      if (participation.status !== 'joined') {
        return sendError(reply, 409, 'CONFLICT', 'you already submitted this session')
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
      )
      if (!saved) return sendError(reply, 500, 'INTERNAL', 'could not save the submission')
      announce(session)
      return {
        participation: toParticipation(saved),
        result: graded.summary,
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
              payload: question.payload,
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
    sendTo(client, { type: 'status', status: session.status, serverNow: new Date().toISOString() })
    if (client.isTeacher) {
      sendTo(client, { type: 'participants', participants: listParticipantEntries(db, id) })
    }
    socket.on('close', () => leaveRoom(id, client))
    socket.on('error', () => leaveRoom(id, client))
  })
}

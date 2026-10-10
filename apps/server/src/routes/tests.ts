import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { Database } from '../lib/db'
import { sendError } from '../lib/http'
import {
  createTest,
  deleteTest,
  duplicateTest,
  exportTest,
  findTestRow,
  listQuestions,
  listTestRows,
  setTestRoom,
  updateTest,
  validateExchange,
  validateQuestion,
  type Question,
  type QuestionInput,
  type TestWithQuestions,
} from '../lib/tests'
import { findRoomById } from '../lib/rooms'
import { listEntityTags, setEntityTags, tagsByEntity } from '../lib/tags'
import { requireRoles } from '../plugins/auth'
import { testResults } from '../lib/results'
import type { Session } from '../lib/tokens'

export interface TestsDeps {
  database: Database
}

const questionSchema = {
  type: 'object',
  required: ['type', 'body', 'points', 'position', 'payload'],
  additionalProperties: false,
  properties: {
    type: {
      type: 'string',
      enum: ['single_choice', 'multiple_choice', 'true_false', 'short_answer', 'matching'],
    },
    body: { type: 'string', minLength: 1, maxLength: 5000 },
    points: { type: 'integer', minimum: 1, maximum: 1000 },
    position: { type: 'integer', minimum: 0 },
    payload: { type: 'object' },
  },
} as const

const testBodySchema = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    timeLimitSec: { type: ['integer', 'null'], minimum: 1 },
    passingPercent: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
    roomId: { type: ['string', 'null'], maxLength: 36 },
    tags: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 20 },
    questions: { type: 'array', maxItems: 200, items: questionSchema },
  },
} as const

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
} as const

interface TestInput {
  title: string
  description?: string
  timeLimitSec?: number | null
  passingPercent?: number | null
  roomId?: string | null
  tags?: string[]
  questions?: QuestionInput[]
}

/** True when the session may view/modify a test owned by `ownerId`. */
function canAccess(session: Session, ownerId: string): boolean {
  return session.role === 'admin' || session.userId === ownerId
}

/** Returns the validated questions, or null when any of them is invalid. */
function parseQuestions(questions: QuestionInput[] | undefined): QuestionInput[] | null {
  if (!questions) return []
  for (const question of questions) {
    if (validateQuestion(question)) return null
  }
  return questions
}

function fullTest(
  db: DatabaseSync,
  row: { id: string; owner_id: string; title: string; description: string; time_limit_sec: number | null; passing_percent: number | null; room_id: string | null; created_at: string; updated_at: string },
  questions: Question[],
): TestWithQuestions {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description,
    timeLimitSec: row.time_limit_sec,
    passingPercent: row.passing_percent,
    roomId: row.room_id,
    tags: listEntityTags(db, 'test', row.id),
    questions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Puts the test in a room and gives it its labels, in one place because both are
 * optional extras that arrive in the same body and have to fail the same way: a
 * room that is not the requester's is refused rather than quietly ignored.
 */
function applyRoomAndTags(
  db: DatabaseSync,
  session: Session,
  testId: string,
  roomId: string | null | undefined,
  tags: string[] | undefined,
): boolean {
  if (roomId !== undefined) {
    if (roomId === null) {
      setTestRoom(db, testId, null)
    } else {
      const room = findRoomById(db, roomId)
      if (!room) return false
      if (!canAccess(session, room.owner_id)) return false
      setTestRoom(db, testId, room.id)
    }
  }
  if (tags !== undefined) {
    setEntityTags(db, session.userId, 'test', testId, tags)
  }
  return true
}

export const testRoutes: FastifyPluginAsync<TestsDeps> = async (
  app: FastifyInstance,
  { database }: TestsDeps,
) => {
  const db = database.raw

  app.get(
    '/api/tests',
    { preHandler: requireRoles('admin', 'teacher') },
    async (request) => {
      const session = request.session!
      const rows = listTestRows(db, session.userId, session.role === 'admin')
      // One query for the whole list: each card shows its labels, and a request
      // per card would be a request per card on the screen a teacher opens most.
      const byTest = tagsByEntity(db, 'test', rows.map(({ test }) => test.id))
      const tests = rows.map(({ test }) => ({ ...test, tags: byTest.get(test.id) ?? [] }))
      return { tests }
    },
  )

  app.post(
    '/api/tests',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { body: testBodySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const body = request.body as TestInput
      const questions = parseQuestions(body.questions)
      if (!questions) {
        return sendError(reply, 400, 'VALIDATION', 'one or more questions are invalid')
      }
      const created = createTest(
        db,
        session.userId,
        {
          title: body.title,
          description: body.description ?? '',
          timeLimitSec: body.timeLimitSec,
          passingPercent: body.passingPercent,
        },
        questions,
      )
      if (!applyRoomAndTags(db, session, created.id, body.roomId, body.tags)) {
        return sendError(reply, 400, 'VALIDATION', 'no such room')
      }
      return reply.code(201).send({
        test: fullTest(db, created, listQuestions(db, created.id)),
      })
    },
  )

  app.get(
    '/api/tests/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const test = findTestRow(db, params.id)
      if (!test) return sendError(reply, 404, 'NOT_FOUND', 'test not found')
      if (!canAccess(session, test.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      return { test: fullTest(db, test, listQuestions(db, test.id)) }
    },
  )

  /**
   * The test as a shareable file: no ids, no owner, answer keys included.
   * Answer keys are the point - a colleague has to be able to run it.
   */
  app.get(
    '/api/tests/:id/export',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const test = findTestRow(db, (request.params as { id: string }).id)
      if (!test) return sendError(reply, 404, 'NOT_FOUND', 'test not found')
      if (!canAccess(session, test.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const document = exportTest(db, test)
      const safeName = test.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
      return reply
        .type('application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="${safeName || 'test'}.json"`)
        .send(`${JSON.stringify(document, null, 2)}\n`)
    },
  )

  /** Copies a test - with fresh question ids - so it can be edited independently. */
  app.post(
    '/api/tests/:id/duplicate',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const test = findTestRow(db, (request.params as { id: string }).id)
      if (!test) return sendError(reply, 404, 'NOT_FOUND', 'test not found')
      if (!canAccess(session, test.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const copy = duplicateTest(db, session.userId, test)
      // A copy is the same paper for the same class: the group and the labels
      // travel with it, or the copy is a stranger that has to be set up again.
      applyRoomAndTags(
        db,
        session,
        copy.id,
        test.room_id,
        listEntityTags(db, 'test', test.id).map((tag) => tag.name),
      )
      return reply.code(201).send({ test: fullTest(db, copy, listQuestions(db, copy.id)) })
    },
  )

  /** Reads a test file written by the export, and creates it for the caller. */
  app.post(
    '/api/tests/import',
    {
      preHandler: requireRoles('admin', 'teacher'),
    },
    async (request, reply) => {
      const session = request.session!
      const parsed = validateExchange(request.body)
      if (!parsed.value) {
        return sendError(reply, 400, 'VALIDATION', parsed.error ?? 'the file could not be read')
      }
      const document = parsed.value
      const created = createTest(
        db,
        session.userId,
        {
          title: document.title,
          description: document.description,
          timeLimitSec: document.timeLimitSec,
          passingPercent: document.passingPercent,
        },
        document.questions,
      )
      return reply.code(201).send({ test: fullTest(db, created, listQuestions(db, created.id)) })
    },
  )

  /** Grade journal plus per-question difficulty, across every session of the test. */
  app.get(
    '/api/tests/:id/results',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const test = findTestRow(db, params.id)
      if (!test) return sendError(reply, 404, 'NOT_FOUND', 'test not found')
      if (!canAccess(session, test.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      return { test: { id: test.id, title: test.title, passingPercent: test.passing_percent }, ...testResults(db, test.id) }
    },
  )

  app.put(
    '/api/tests/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema, body: testBodySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const body = request.body as TestInput
      const test = findTestRow(db, params.id)
      if (!test) return sendError(reply, 404, 'NOT_FOUND', 'test not found')
      if (!canAccess(session, test.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const questions = parseQuestions(body.questions)
      if (!questions) {
        return sendError(reply, 400, 'VALIDATION', 'one or more questions are invalid')
      }
      const updated = updateTest(
        db,
        test,
        {
          title: body.title,
          description: body.description ?? '',
          timeLimitSec: body.timeLimitSec,
          passingPercent: body.passingPercent,
        },
        questions,
      )
      if (!applyRoomAndTags(db, session, updated.id, body.roomId, body.tags)) {
        return sendError(reply, 400, 'VALIDATION', 'no such room')
      }
      return { test: fullTest(db, updated, listQuestions(db, updated.id)) }
    },
  )

  app.delete(
    '/api/tests/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const test = findTestRow(db, params.id)
      if (!test) return sendError(reply, 404, 'NOT_FOUND', 'test not found')
      if (!canAccess(session, test.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      deleteTest(db, test.id)
      return reply.code(204).send()
    },
  )
}
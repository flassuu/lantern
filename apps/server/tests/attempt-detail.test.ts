import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildApp, type TestingApp } from '../src/app'
import { recordParticipationEvent } from '../src/lib/sessions'
import { bearer, insertTestAdmin, signInAs } from './support'

process.env.TEACHER_PASSWORD = 'teacher-pass-1'
process.env.ADMIN_PASSWORD = 'test-admin-password'

let app: TestingApp
let tmpDir: string
let teacher: string
let otherTeacher: string
let roomKey: string

interface Detail {
  userId: string
  fullName: string
  score: number | null
  totalTimeMs: number | null
  focusLost: number
  averageMs: number | null
  slowest: { questionId: string; timeMs: number } | null
  questions: Array<{
    questionId: string
    answer: { key?: string } | null
    isCorrect: boolean
    timeMs: number | null
    changed: number
    correct: unknown
  }>
  events: Array<{ kind: 'visible' | 'hidden' }>
}

/** One run, one student, two questions, both submitted with timings. */
async function runWithTimings(username = 'timing'): Promise<{ sessionId: string; userId: string }> {
  const test = await app.server.inject({
    method: 'POST',
    url: '/api/tests',
    headers: bearer(teacher),
    payload: {
      title: 'Timed paper',
      questions: [
        {
          type: 'single_choice',
          body: 'First?',
          points: 1,
          position: 0,
          payload: { options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }], correct: 'a' },
        },
        {
          type: 'single_choice',
          body: 'Second?',
          points: 1,
          position: 1,
          payload: { options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }], correct: 'b' },
        },
      ],
    },
  })
  const testId = (test.json() as { test: { id: string } }).test.id

  const created = await app.server.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: bearer(teacher),
    payload: { testId },
  })
  const sessionId = (created.json() as { session: { id: string } }).session.id
  await app.server.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/start`,
    headers: bearer(teacher),
  })

  const registered = await app.server.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'student-pass-1', fullName: `${username} Student`, roomKey },
  })
  expect(registered.statusCode).toBe(201)
  const student = await signInAs(app, username, 'student-pass-1')

  const joined = await app.server.inject({
    method: 'POST',
    url: '/api/sessions/join',
    headers: bearer(student),
    payload: { code: (created.json() as { session: { joinCode: string } }).session.joinCode },
  })
  const questionIds = (joined.json() as { questions: Array<{ id: string }> }).questions.map(
    (question) => question.id,
  )

  const submitted = await app.server.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/submit`,
    headers: bearer(student),
    payload: {
      answers: { [questionIds[0]!]: { key: 'a' }, [questionIds[1]!]: { key: 'a' } },
      timings: {
        [questionIds[0]!]: { timeMs: 4200, changed: 2 },
        [questionIds[1]!]: { timeMs: 9000, changed: 0 },
      },
    },
  })
  expect(submitted.statusCode).toBe(200)

  const users = await app.server.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/participants`,
    headers: bearer(teacher),
  })
  const userId = (users.json() as { participants: Array<{ userId: string }> }).participants[0]!
    .userId
  return { sessionId, userId }
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-attempt-'))
  app = buildApp({ host: '127.0.0.1', port: 0, dbPath: join(tmpDir, 'test.db'), webRoot: null })
  insertTestAdmin(app)
  await app.server.ready()
  teacher = await signInAs(app, 'teacher', 'teacher-pass-1')
  // A second teacher, so "not yours" can be answered by somebody else's run.
  const admin = await signInAs(app, 'admin', process.env.ADMIN_PASSWORD!)
  const made = await app.server.inject({
    method: 'POST',
    url: '/api/users',
    headers: bearer(admin),
    payload: { username: 'teacher2', password: 'teacher-pass-1', role: 'teacher', fullName: 'Second' },
  })
  expect(made.statusCode).toBe(201)
  otherTeacher = await signInAs(app, 'teacher2', 'teacher-pass-1')
  const room = await app.server.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: bearer(teacher),
    payload: { name: 'Attempt room', courseIds: [] },
  })
  roomKey = (room.json() as { room: { key: string } }).room.key
})

afterAll(() => {
  app.server.close()
  app.database.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('one student, one run, in full', () => {
  it('keeps what each answer cost: time, changes, and where focus went', async () => {
    const { sessionId, userId } = await runWithTimings('timing')
    // The window went away once while they worked; the server said so at the time.
    const participation = app.database.raw
      .prepare('SELECT id FROM participations WHERE session_id = ? AND user_id = ?')
      .get(sessionId, userId) as { id: string }
    recordParticipationEvent(app.database.raw, {
      sessionId,
      participationId: participation.id,
      kind: 'hidden',
    })

    const res = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/participants/${userId}`,
      headers: bearer(teacher),
    })
    expect(res.statusCode).toBe(200)
    const detail = (res.json() as { detail: Detail }).detail

    expect(detail.fullName).toBe('timing Student')
    expect(detail.score).toBe(1)
    // 4.2s + 9s, in the student's own order.
    expect(detail.totalTimeMs).toBe(13200)
    expect(detail.averageMs).toBe(6600)
    expect(detail.slowest?.timeMs).toBe(9000)
    expect(detail.focusLost).toBe(1)
    expect(detail.events.map((event) => event.kind)).toEqual(['hidden'])

    const [first, second] = detail.questions
    expect(first!.isCorrect).toBe(true)
    expect(first!.timeMs).toBe(4200)
    expect(first!.changed).toBe(2)
    expect(first!.answer).toEqual({ key: 'a' })
    // The teacher sees the key the student never did.
    expect((first!.correct as { correct: string }).correct).toBe('a')
    expect(second!.isCorrect).toBe(false)
    expect(second!.changed).toBe(0)
  })

  it('tells a stranger from a teacher who does not own the run', async () => {
    const { sessionId, userId } = await runWithTimings('timing2')

    const forbidden = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/participants/${userId}`,
      headers: bearer(otherTeacher),
    })
    expect(forbidden.statusCode).toBe(403)

    const stranger = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/participants/${randomUUID()}`,
      headers: bearer(teacher),
    })
    expect(stranger.statusCode).toBe(404)
  })
})
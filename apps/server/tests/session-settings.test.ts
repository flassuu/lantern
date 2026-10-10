import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { bearer, signInAs } from './support'

process.env.TEACHER_PASSWORD = 'teacher-pass-1'
process.env.ADMIN_PASSWORD = 'test-admin-password'

let app: TestingApp
let tmpDir: string
let teacher: string
let roomKey: string

interface QuestionBody {
  id: string
  payload: { options?: Array<{ key: string }> }
}

interface Joined {
  questions: QuestionBody[]
}

/** Registers a student through a room key, which approves them outright. */
async function registerStudent(username: string): Promise<string> {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'student-pass-1', fullName: username, roomKey },
  })
  expect(res.statusCode).toBe(201)
  return signInAs(app, username, 'student-pass-1')
}

/** A three-question test whose options have known keys. */
async function makeTest(settings: Record<string, unknown>): Promise<string> {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/tests',
    headers: bearer(teacher),
    payload: {
      title: 'Settings paper',
      settings,
      questions: [0, 1, 2].map((index) => ({
        type: 'single_choice',
        body: `Question ${index}?`,
        points: 1,
        position: index,
        payload: {
          options: [
            { key: 'a', text: 'A' },
            { key: 'b', text: 'B' },
            { key: 'c', text: 'C' },
          ],
          correct: 'a',
        },
      })),
    },
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { test: { id: string } }).test.id
}

async function startRun(
  testId: string,
  settings?: Record<string, unknown>,
): Promise<{ id: string; code: string }> {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: bearer(teacher),
    payload: settings ? { testId, settings } : { testId },
  })
  expect(res.statusCode).toBe(201)
  const session = (res.json() as { session: { id: string; joinCode: string } }).session
  await app.server.inject({
    method: 'POST',
    url: `/api/sessions/${session.id}/start`,
    headers: bearer(teacher),
  })
  return { id: session.id, code: session.joinCode }
}

async function joinByCode(token: string, code: string) {
  return app.server.inject({
    method: 'POST',
    url: '/api/sessions/join',
    headers: bearer(token),
    payload: { code },
  })
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-settings-'))
  app = buildApp({ host: '127.0.0.1', port: 0, dbPath: join(tmpDir, 'test.db'), webRoot: null })
  teacher = await signInAs(app, 'teacher', 'teacher-pass-1')
  const room = await app.server.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: bearer(teacher),
    payload: { name: 'Settings room', courseIds: [] },
  })
  roomKey = (room.json() as { room: { key: string } }).room.key
})

afterAll(() => {
  app.server.close()
  app.database.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('a run takes the test settings and snapshots them', () => {
  it('carries a test default onto the session, and a start-time override wins', async () => {
    const testId = await makeTest({ shuffleQuestions: true, questionsPerPage: 'one' })

    const read = await app.server.inject({
      method: 'GET',
      url: `/api/tests/${testId}`,
      headers: bearer(teacher),
    })
    expect((read.json() as { test: { settings: { questionsPerPage: string } } }).test.settings
      .questionsPerPage).toBe('one')

    const inherited = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacher),
      payload: { testId },
    })
    expect(
      (inherited.json() as { session: { settings: { questionsPerPage: string } } }).session.settings
        .questionsPerPage,
    ).toBe('one')

    const overridden = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacher),
      payload: { testId, settings: { questionsPerPage: 'all' } },
    })
    expect(
      (overridden.json() as { session: { settings: { questionsPerPage: string } } }).session.settings
        .questionsPerPage,
    ).toBe('all')
  })

  it('only lets settings change in the lobby', async () => {
    const testId = await makeTest({})
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacher),
      payload: { testId },
    })
    const id = (created.json() as { session: { id: string } }).session.id

    const ok = await app.server.inject({
      method: 'PATCH',
      url: `/api/sessions/${id}`,
      headers: bearer(teacher),
      payload: { settings: { questionsPerPage: 'one' } },
    })
    expect(ok.statusCode).toBe(200)

    await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${id}/start`,
      headers: bearer(teacher),
    })
    const late = await app.server.inject({
      method: 'PATCH',
      url: `/api/sessions/${id}`,
      headers: bearer(teacher),
      payload: { settings: { questionsPerPage: 'all' } },
    })
    expect(late.statusCode).toBe(409)
  })
})

describe('shuffling is a setting', () => {
  it('keeps the paper in order when questions are not shuffled', async () => {
    const testId = await makeTest({})
    const run = await startRun(testId)
    const student = await registerStudent('orderStudent')
    const joined = await joinByCode(student, run.code)
    const bodies = (joined.json() as Joined).questions.map((q) => q.id)
    expect(bodies).toHaveLength(3)
    // The order is the test's order: positions 0,1,2 in and out.
    const first = (joined.json() as Joined).questions[0]!
    expect((first as unknown as { position: number }).position).toBe(0)
  })

  it('shuffles the options per student, and keeps that order on a reload', async () => {
    const testId = await makeTest({ shuffleOptions: true })
    const run = await startRun(testId)
    const student = await registerStudent('shuffleStudent')

    const joined = await joinByCode(student, run.code)
    const keys = (joined.json() as Joined).questions[0]!.payload.options!.map((o) => o.key)
    expect([...keys].sort()).toEqual(['a', 'b', 'c'])

    const current = await app.server.inject({
      method: 'GET',
      url: '/api/sessions/current',
      headers: bearer(student),
    })
    const again = (current.json() as Joined).questions[0]!.payload.options!.map((o) => o.key)
    expect(again).toEqual(keys)
  })
})

describe('results can be held', () => {
  it('submits without a score until the teacher releases it', async () => {
    const testId = await makeTest({ releaseResults: 'teacher' })
    const run = await startRun(testId)
    const student = await registerStudent('heldStudent')
    const joined = await joinByCode(student, run.code)
    const questionId = (joined.json() as Joined).questions[0]!.id

    const submitted = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${run.id}/submit`,
      headers: bearer(student),
      payload: { answers: { [questionId]: { key: 'a' } } },
    })
    expect(submitted.statusCode).toBe(200)
    const body = submitted.json() as { result: unknown; released: boolean }
    expect(body.released).toBe(false)
    expect(body.result).toBeNull()

    const early = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${run.id}/result`,
      headers: bearer(student),
    })
    expect(early.statusCode).toBe(409)

    await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${run.id}/release`,
      headers: bearer(teacher),
    })

    const after = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${run.id}/result`,
      headers: bearer(student),
    })
    expect(after.statusCode).toBe(200)
  })

  it('hides the answer key when the test says never', async () => {
    const testId = await makeTest({ showCorrectAnswers: 'never' })
    const run = await startRun(testId)
    const student = await registerStudent('hiddenKeyStudent')
    const joined = await joinByCode(student, run.code)
    const questionId = (joined.json() as Joined).questions[0]!.id

    await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${run.id}/submit`,
      headers: bearer(student),
      payload: { answers: { [questionId]: { key: 'a' } } },
    })
    const result = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${run.id}/result`,
      headers: bearer(student),
    })
    const question = (result.json() as { questions: Array<{ payload: Record<string, unknown> }> })
      .questions[0]!
    expect(question.payload.correct).toBeUndefined()
    expect(question.payload.options).toBeDefined()
  })
})

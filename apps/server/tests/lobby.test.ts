import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { bearer, signInAs } from './support'

process.env.TEACHER_PASSWORD = 'teacher-pass-1'
process.env.ADMIN_PASSWORD = 'test-admin-password'

interface SessionBody {
  session: { id: string; status: string; entryLocked: boolean }
}

let app: TestingApp
let tmpDir: string
let teacher: string
let testId: string
let roomKey: string

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

async function makeSession(): Promise<SessionBody['session']> {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: bearer(teacher),
    payload: { testId },
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as SessionBody).session
}

/** The join code, read the way the teacher's screen reads it. */
async function codeOf(sessionId: string): Promise<string> {
  const res = await app.server.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}`,
    headers: bearer(teacher),
  })
  return (res.json() as { session: { joinCode: string } }).session.joinCode
}

async function joinByCode(token: string, code: string) {
  return app.server.inject({
    method: 'POST',
    url: '/api/sessions/join',
    headers: bearer(token),
    payload: { code },
  })
}

async function patch(id: string, body: Record<string, unknown>) {
  return app.server.inject({
    method: 'PATCH',
    url: `/api/sessions/${id}`,
    headers: bearer(teacher),
    payload: body,
  })
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-lobby-'))
  app = buildApp({ host: '127.0.0.1', port: 0, dbPath: join(tmpDir, 'test.db'), webRoot: null })
  teacher = await signInAs(app, 'teacher', 'teacher-pass-1')

  const room = await app.server.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: bearer(teacher),
    payload: { name: 'Lobby room', courseIds: [] },
  })
  roomKey = (room.json() as { room: { key: string } }).room.key

  const test = await app.server.inject({
    method: 'POST',
    url: '/api/tests',
    headers: bearer(teacher),
    payload: {
      title: 'Lobby paper',
      questions: [
        {
          type: 'true_false',
          body: 'Two plus two is four.',
          points: 1,
          position: 0,
          payload: { correct: true },
        },
      ],
    },
  })
  testId = (test.json() as { test: { id: string } }).test.id
})

afterAll(() => {
  app.server.close()
  app.database.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('a session opens in the lobby', () => {
  it('lets students in but not answer, until the teacher starts it', async () => {
    const session = await makeSession()
    expect(session.status).toBe('lobby')

    const student = await registerStudent('lobbyStudent1')
    const joined = await joinByCode(student, await codeOf(session.id))
    expect(joined.statusCode).toBe(201)
    // The student is in the room, and the room has not started.
    expect((joined.json() as { session: { status: string } }).session.status).toBe('lobby')

    const early = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/submit`,
      headers: bearer(student),
      payload: { answers: {} },
    })
    expect(early.statusCode).toBe(409)

    const started = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/start`,
      headers: bearer(teacher),
    })
    expect((started.json() as SessionBody).session.status).toBe('active')

    const now = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/submit`,
      headers: bearer(student),
      payload: { answers: {} },
    })
    expect(now.statusCode).toBe(200)
  })

  it('refuses a new student while entry is locked, and keeps the ones inside', async () => {
    const session = await makeSession()
    const inside = await registerStudent('lobbyStudent2')

    const code = await codeOf(session.id)
    expect((await joinByCode(inside, code)).statusCode).toBe(201)

    const locked = await patch(session.id, { entryLocked: true })
    expect((locked.json() as SessionBody).session.entryLocked).toBe(true)

    const outside = await registerStudent('lobbyStudent3')
    const refused = await joinByCode(outside, code)
    expect(refused.statusCode).toBe(409)
    expect((refused.json() as { error: { code: string } }).error.code).toBe('ENTRY_LOCKED')

    // Somebody already in keeps their seat: a reload must not throw them out.
    expect((await joinByCode(inside, code)).statusCode).toBe(201)

    await patch(session.id, { entryLocked: false })
    expect((await joinByCode(outside, code)).statusCode).toBe(201)
  })
})

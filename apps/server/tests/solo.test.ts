import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { bearer, insertTeacher, signInAs } from './support'

/**
 * The product claim of 0.5.1: one teacher, one machine, no admin anywhere.
 *
 * Every test here fails if a step of that path needs an account that does not
 * exist yet. The whole point of the release is that the list below is the
 * shortest path from a fresh database to a class in progress.
 */

process.env.TEACHER_PASSWORD = 'solo-teacher-password'

interface PublicUser {
  id: string
  role: string
  status: string
  username: string
  fullName: string
}

let app: TestingApp
let tmpDir: string
let teacher: string

async function register(username: string, fullName = username) {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'student-pass-1', fullName },
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { user: PublicUser }).user
}

describe('a lone teacher with no admin', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'testsys-solo-'))
    app = buildApp({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(tmpDir, 'test.db'),
      webRoot: null,
    })
    await app.server.ready()
    teacher = await signInAs(app, 'teacher', process.env.TEACHER_PASSWORD!)
  })

  afterAll(() => {
    app.server.close()
    app.database.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('signs the first boot account in as a teacher, with no admin in sight', async () => {
    const admins = app.database.raw
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
      .get() as { n: number }
    expect(admins.n).toBe(0)
  })

  it('lets that teacher set the public address the QR code uses', async () => {
    const res = await app.server.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: bearer(teacher),
      payload: { publicBaseUrl: 'http://192.168.1.65:3300' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { publicBaseUrl: string }).publicBaseUrl).toBe(
      'http://192.168.1.65:3300',
    )
  })

  it('lets that teacher create a class and read its key', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: bearer(teacher),
      payload: { name: 'Class 9A' },
    })
    expect(res.statusCode).toBe(201)
    const room = (res.json() as { room: { id: string; key: string } }).room
    expect(room.key).toMatch(/^[A-Z0-9]{6}$/)
  })

  it('approves a pending student who registered without a class key', async () => {
    const pendingUser = await register('nokey')
    expect(pendingUser.status).toBe('pending')

    const signedIn = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nokey', password: 'student-pass-1' },
    })
    expect(signedIn.statusCode).toBe(403)

    const list = await app.server.inject({
      method: 'GET',
      url: '/api/users/pending',
      headers: bearer(teacher),
    })
    expect(list.statusCode).toBe(200)
    const waiting = (list.json() as { users: PublicUser[] }).users
    expect(waiting.map((user) => user.username)).toContain('nokey')

    const approved = await app.server.inject({
      method: 'PATCH',
      url: `/api/users/${pendingUser.id}/status`,
      headers: bearer(teacher),
      payload: { status: 'approved' },
    })
    expect(approved.statusCode).toBe(200)

    const retry = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nokey', password: 'student-pass-1' },
    })
    expect(retry.statusCode).toBe(200)
  })

  it('gives that teacher the server log', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: '/api/logs',
      headers: bearer(teacher),
    })
    expect(res.statusCode).toBe(200)
  })

  it('stops a teacher from touching another teacher', async () => {
    insertTeacher(app, 'colleague', 'colleague-pass-1')
    const colleague = await signInAs(app, 'colleague', 'colleague-pass-1')
    const row = app.database.raw
      .prepare("SELECT id FROM users WHERE username = 'colleague'")
      .get() as { id: string }

    const res = await app.server.inject({
      method: 'PATCH',
      url: `/api/users/${row.id}/status`,
      headers: bearer(teacher),
      payload: { status: 'blocked' },
    })
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')
    expect(colleague).toBeTruthy()
  })

  it('stops a teacher from browsing the whole roster', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: '/api/users',
      headers: bearer(teacher),
    })
    expect(res.statusCode).toBe(403)
  })

  it('runs a whole class with no admin ever created', async () => {
    const room = await app.server.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: bearer(teacher),
      payload: { name: 'Physics 1' },
    })
    const key = (room.json() as { room: { key: string } }).room.key

    const created = await app.server.inject({
      method: 'POST',
      url: '/api/tests',
      headers: bearer(teacher),
      payload: {
        title: 'Newton',
        questions: [
          {
            type: 'single_choice',
            body: 'Force unit?',
            position: 0,
            points: 2,
            payload: {
              options: [
                { key: 'a', text: 'newton' },
                { key: 'b', text: 'joule' },
              ],
              correct: 'a',
            },
          },
        ],
      },
    })
    expect(created.statusCode).toBe(201)
    const testId = (created.json() as { test: { id: string } }).test.id

    const session = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacher),
      payload: { testId },
    })
    expect(session.statusCode).toBe(201)
    const { id: sessionId, joinCode } = (
      session.json() as { session: { id: string; joinCode: string } }
    ).session
    expect(joinCode).toMatch(/^[A-Z0-9]{6}$/)

    // The class key gets the student an approved account; the session's own
    // code is what they type once they are answering.
    const reg = await app.server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'withkey',
        password: 'student-pass-1',
        fullName: 'With Key',
        roomKey: key,
      },
    })
    const studentUser = (reg.json() as { user: PublicUser }).user
    expect(studentUser.status).toBe('approved')

    const student = await signInAs(app, 'withkey', 'student-pass-1')
    const joined = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(student),
      payload: { code: joinCode },
    })
    expect(joined.statusCode).toBe(201)

    const participants = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/participants`,
      headers: bearer(teacher),
    })
    expect(participants.statusCode).toBe(200)
  })
})
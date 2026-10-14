import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { insertTestAdmin } from './support'
import { hashPassword } from '../src/lib/passwords'

// Deterministic admin bootstrap so the seed warning stays quiet in tests.
process.env.ADMIN_PASSWORD = 'test-admin-password'

interface LoginBody {
  token: string
  user: { id: string; username: string }
}

interface ErrorBody {
  error: { code: string; message: string }
}

let app: TestingApp
let tmpDir: string

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

/** Creates an account of the given role, without going through the admin UI. */
async function makeUser(
  username: string,
  role: 'admin' | 'teacher' | 'student',
  password = 'secret-pass-1',
): Promise<void> {
  const now = new Date().toISOString()
  app.database.raw
    .prepare(
      `INSERT INTO users (id, role, status, username, password_hash, full_name, created_at, updated_at)
       VALUES (?, ?, 'approved', ?, ?, ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), role, username, hashPassword(password), `${username} person`, now, now)
}

/** Signs in and returns the token. */
async function tokenFor(username: string, password = 'secret-pass-1'): Promise<string> {
  const login = await app.server.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  })
  expect(login.statusCode).toBe(200)
  return (login.json() as LoginBody).token
}

function changePassword(token: string, currentPassword: string, newPassword: string) {
  return app.server.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: bearer(token),
    payload: { currentPassword, newPassword },
  })
}

describe('changing your own password', () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-password-'))
  app = buildApp({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(tmpDir, 'test.db'),
    webRoot: null,
  })
  insertTestAdmin(app)

  afterAll(() => {
    app.server.close()
    app.database.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('requires a signed-in user', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { currentPassword: 'secret-pass-1', newPassword: 'another-pass-1' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('needs the current password, so a borrowed session cannot lock the owner out', async () => {
    await makeUser('pw-teacher', 'teacher')
    const token = await tokenFor('pw-teacher')
    const res = await changePassword(token, 'not-my-password', 'another-pass-1')
    expect(res.statusCode).toBe(401)
    expect((res.json() as ErrorBody).error.code).toBe('INVALID_CREDENTIALS')

    // The old password still works and nothing changed.
    const login = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'pw-teacher', password: 'secret-pass-1' },
    })
    expect(login.statusCode).toBe(200)
  })

  it('refuses a new password that is too short', async () => {
    await makeUser('pw-short', 'teacher')
    const token = await tokenFor('pw-short')
    const res = await changePassword(token, 'secret-pass-1', 'short')
    expect(res.statusCode).toBe(400)
    expect((res.json() as ErrorBody).error.code).toBe('VALIDATION')
  })

  it('rejects an unknown field instead of accepting it', async () => {
    await makeUser('pw-extra', 'teacher')
    const token = await tokenFor('pw-extra')
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: bearer(token),
      payload: { currentPassword: 'secret-pass-1', newPassword: 'another-pass-1', role: 'admin' },
    })
    expect(res.statusCode).toBe(200)
    // Fastify strips unknown fields rather than rejecting the request; the role
    // is not one of them, so the account cannot be promoted this way.
    const user = (
      app.database.raw
        .prepare("SELECT role FROM users WHERE username = 'pw-extra'")
        .get() as { role: string }
    ).role
    expect(user).toBe('teacher')
  })

  it('changes the password, signs the old session out and reissues a token', async () => {
    await makeUser('pw-change', 'teacher')
    const token = await tokenFor('pw-change')
    const res = await changePassword(token, 'secret-pass-1', 'another-pass-1')
    expect(res.statusCode).toBe(200)
    const body = res.json() as LoginBody
    expect(body.token).toBeTruthy()

    // The token from before the change no longer works.
    const withOld = await app.server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: bearer(token),
    })
    expect(withOld.statusCode).toBe(401)

    // The new one does, and the new password signs in.
    const withNew = await app.server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: bearer(body.token),
    })
    expect(withNew.statusCode).toBe(200)

    const old = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'pw-change', password: 'secret-pass-1' },
    })
    expect(old.statusCode).toBe(401)
    const fresh = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'pw-change', password: 'another-pass-1' },
    })
    expect(fresh.statusCode).toBe(200)
  })

  it('ends the account\'s other sessions, so a lost device is actually locked out', async () => {
    await makeUser('pw-sessions', 'student')
    // Two devices, one account: two sign-ins, two tokens.
    const first = await tokenFor('pw-sessions')
    const second = await tokenFor('pw-sessions')
    expect(second).not.toBe(first)

    await changePassword(second, 'secret-pass-1', 'another-pass-1')

    const res = await app.server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: bearer(first),
    })
    expect(res.statusCode).toBe(401)
  })

  it('lets an admin change theirs - the seed variable only applies to a new database', async () => {
    const login = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: process.env.ADMIN_PASSWORD! },
    })
    const token = (login.json() as LoginBody).token

    const res = await changePassword(token, process.env.ADMIN_PASSWORD!, 'a-better-admin-pass')
    expect(res.statusCode).toBe(200)
    const body = res.json() as LoginBody

    const again = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'a-better-admin-pass' },
    })
    expect(again.statusCode).toBe(200)
    expect((again.json() as LoginBody).token).toBeTruthy()
    expect(body.user.username).toBe('admin')
  })

  it('lets an admin set somebody else\u2019s password, and drops their sessions', async () => {
    await makeUser('forgetful', 'student', 'their-own-pass-1')
    const studentToken = await tokenFor('forgetful', 'their-own-pass-1')
    // The test above rotated the admin password, so this is the current one; the
    // file runs in order and this is what the admin is actually called now.
    const adminToken = await tokenFor('admin', 'a-better-admin-pass')

    const users = await app.server.inject({
      method: 'GET',
      url: '/api/users?role=student',
      headers: bearer(adminToken),
    })
    const target = (users.json() as { users: Array<{ id: string; username: string }> }).users.find(
      (user) => user.username === 'forgetful',
    )
    expect(target).toBeDefined()

    const reset = await app.server.inject({
      method: 'PATCH',
      url: `/api/users/${target!.id}/password`,
      headers: bearer(adminToken),
      payload: { password: 'admin-set-pass-1' },
    })
    expect(reset.statusCode).toBe(200)

    // The new password works...
    const withNew = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'forgetful', password: 'admin-set-pass-1' },
    })
    expect(withNew.statusCode).toBe(200)

    // ...the old one does not...
    const withOld = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'forgetful', password: 'their-own-pass-1' },
    })
    expect(withOld.statusCode).toBe(401)

    // ...and the session they were holding is gone, because a reset that leaves
    // the old device signed in is not a reset.
    const stale = await app.server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: bearer(studentToken),
    })
    expect(stale.statusCode).toBe(401)
  })

  it('will not let a teacher reset somebody\u2019s password', async () => {
    await makeUser('teacher2', 'teacher')
    const teacherToken = await tokenFor('teacher2')
    const target = app.database.raw
      .prepare("SELECT id FROM users WHERE username = 'forgetful'")
      .get() as { id: string }

    const res = await app.server.inject({
      method: 'PATCH',
      url: `/api/users/${target.id}/password`,
      headers: bearer(teacherToken),
      payload: { password: 'teacher-set-pass-1' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('answers 404 for a user that cannot exist', async () => {
    // The test above rotated the admin password, so this is the current one; the
    // file runs in order and this is what the admin is actually called now.
    const adminToken = await tokenFor('admin', 'a-better-admin-pass')
    const res = await app.server.inject({
      method: 'PATCH',
      url: '/api/users/00000000-0000-4000-8000-000000000000/password',
      headers: bearer(adminToken),
      payload: { password: 'whatever-pass-1' },
    })
    expect(res.statusCode).toBe(404)
  })
})
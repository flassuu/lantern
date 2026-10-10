import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { bearer, insertTeacher, signInAs } from './support'

// Deterministic teacher bootstrap, and a known password for the seeded one.
process.env.TEACHER_PASSWORD = 'teacher-pass-1'
process.env.ADMIN_PASSWORD = 'test-admin-password'

interface SessionBody {
  session: { id: string; name: string | null; title: string }
}

let app: TestingApp
let tmpDir: string
let teacherA: string
let teacherB: string
let testId: string

/** A one-question test, because a session cannot start without questions. */
async function makeTest(token: string, title: string): Promise<string> {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/tests',
    headers: bearer(token),
    payload: {
      title,
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
  return (res.json() as { test: { id: string } }).test.id
}

async function startSession(token: string, name: string): Promise<string> {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: bearer(token),
    payload: { testId, name },
  })
  return (res.json() as SessionBody).session.id
}

async function list(token: string, query = ''): Promise<{ sessions: SessionBody['session'][]; total: number }> {
  const res = await app.server.inject({
    method: 'GET',
    url: `/api/sessions${query}`,
    headers: bearer(token),
  })
  return res.json() as { sessions: SessionBody['session'][]; total: number }
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-library-'))
  app = buildApp({ host: '127.0.0.1', port: 0, dbPath: join(tmpDir, 'test.db'), webRoot: null })
  teacherA = await signInAs(app, 'teacher', 'teacher-pass-1')
  insertTeacher(app, 'teacherB', 'teacher-pass-1')
  teacherB = await signInAs(app, 'teacherB', 'teacher-pass-1')
  testId = await makeTest(teacherA, 'Library paper')

  // Five runs, named so an alphabetical sort means something, and stamped with
  // distinct times so "newest first" is a fact and not a coin toss between rows
  // created in the same millisecond.
  const names = ['Delta', 'Alpha', 'Echo', 'Beta', 'Gamma']
  const ids: string[] = []
  for (const name of names) ids.push(await startSession(teacherA, name))
  ids.forEach((id, index) => {
    app.database.raw
      .prepare('UPDATE live_sessions SET created_at = ? WHERE id = ?')
      .run(`2026-01-0${index + 1}T00:00:00.000Z`, id)
  })
  // One finished run, so a status filter has something to find.
  app.database.raw
    .prepare("UPDATE live_sessions SET status = 'finished' WHERE name = 'Echo'")
    .run()
})

afterAll(() => {
  app.server.close()
  app.database.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('the session library list', () => {
  it('is newest first by default', async () => {
    const { sessions, total } = await list(teacherA)
    expect(total).toBe(5)
    expect(sessions.map((entry) => entry.name)).toEqual([
      'Gamma',
      'Beta',
      'Echo',
      'Alpha',
      'Delta',
    ])
  })

  it('sorts by name, in either direction', async () => {
    const ascending = await list(teacherA, '?sort=name&dir=asc')
    expect(ascending.sessions.map((entry) => entry.name)).toEqual([
      'Alpha',
      'Beta',
      'Delta',
      'Echo',
      'Gamma',
    ])
    const descending = await list(teacherA, '?sort=name&dir=desc')
    expect(descending.sessions.map((entry) => entry.name)).toEqual([
      'Gamma',
      'Echo',
      'Delta',
      'Beta',
      'Alpha',
    ])
  })

  it('pages without repeating a row, and counts the whole filter', async () => {
    const first = await list(teacherA, '?sort=name&dir=asc&limit=2&offset=0')
    const second = await list(teacherA, '?sort=name&dir=asc&limit=2&offset=2')
    const third = await list(teacherA, '?sort=name&dir=asc&limit=2&offset=4')

    const page = [...first.sessions, ...second.sessions, ...third.sessions]
    expect(page.map((entry) => entry.name)).toEqual([
      'Alpha',
      'Beta',
      'Delta',
      'Echo',
      'Gamma',
    ])
    // The total is the filter's, not the page's.
    expect(first.total).toBe(5)
    expect(third.sessions).toHaveLength(1)
  })

  it('narrows by status, and the total follows the filter', async () => {
    const { sessions, total } = await list(teacherA, '?status=finished')
    expect(total).toBe(1)
    expect(sessions[0]?.name).toBe('Echo')
  })

  it('narrows by word across the run name and the test title', async () => {
    expect((await list(teacherA, '?q=Gamma')).total).toBe(1)
    expect((await list(teacherA, '?q=Library')).total).toBe(5)
    expect((await list(teacherA, '?q=nothing')).total).toBe(0)
  })

  it('never lists another teacher', async () => {
    expect((await list(teacherB)).total).toBe(0)
  })
})

describe('one session by id', () => {
  it('returns it in the same shape the list uses, labels included', async () => {
    const { sessions } = await list(teacherA)
    const wanted = sessions[0]!
    await app.server.inject({
      method: 'PUT',
      url: `/api/tags/session/${wanted.id}`,
      headers: bearer(teacherA),
      payload: { names: ['Algebra'] },
    })

    const res = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${wanted.id}`,
      headers: bearer(teacherA),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { session: { id: string; tags: Array<{ name: string }> } }
    expect(body.session.id).toBe(wanted.id)
    expect(body.session.tags.map((tag) => tag.name)).toEqual(['Algebra'])
  })

  it('refuses another teacher, and 404s a session that is not there', async () => {
    const { sessions } = await list(teacherA)
    const foreign = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${sessions[0]!.id}`,
      headers: bearer(teacherB),
    })
    expect(foreign.statusCode).toBe(403)

    const missing = await app.server.inject({
      method: 'GET',
      url: '/api/sessions/00000000-0000-4000-8000-000000000000',
      headers: bearer(teacherA),
    })
    expect(missing.statusCode).toBe(404)
  })
})

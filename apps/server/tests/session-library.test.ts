import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { createUser } from '../src/lib/users'
import { bearer, insertTeacher, insertTestAdmin, signInAs } from './support'

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
let admin: string
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
  // An admin is not a teacher: the only thing they do here is reach a run that
  // is not theirs, which is the one thing a library delete has to allow.
  insertTestAdmin(app)
  admin = await signInAs(app, 'admin', process.env.ADMIN_PASSWORD!)
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

/** The code the class reads off the board, straight from the row. */
function joinCodeOf(sessionId: string): string {
  const row = app.database.raw
    .prepare('SELECT join_code FROM live_sessions WHERE id = ?')
    .get(sessionId) as { join_code: string }
  return row.join_code
}

/**
 * Everything this run left in the database: the class that sat it, what they
 * answered, and the events that marked it.
 *
 * Answers point at a participation rather than at the run, so they are counted
 * through it - which is also the only way to see whether the cascade reached
 * them.
 */
function leftBehind(sessionId: string): number {
  const row = app.database.raw
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM participations WHERE session_id = ?) AS participants,
         (SELECT COUNT(*) FROM participation_events WHERE session_id = ?) AS events,
         (SELECT COUNT(*) FROM participation_answers WHERE participation_id IN
            (SELECT id FROM participations WHERE session_id = ?)) AS answers`,
    )
    .get(sessionId, sessionId, sessionId) as {
    participants: number
    events: number
    answers: number
  }
  return row.participants + row.events + row.answers
}

/** A student of the class, inserted as the console's `student` command would. */
async function joinStudent(username: string, joinCode: string): Promise<string> {
  createUser(app.database.raw, {
    role: 'student',
    status: 'approved',
    username,
    password: 'student-pass-1',
    fullName: username,
  })
  const token = await signInAs(app, username, 'student-pass-1')
  const joined = await app.server.inject({
    method: 'POST',
    url: '/api/sessions/join',
    headers: bearer(token),
    payload: { code: joinCode },
  })
  expect(joined.statusCode).toBe(201)
  return token
}

describe('throwing a run away', () => {
  it('takes the class and their answers with it', async () => {
    const sessionId = await startSession(teacherA, 'Mistaken run')
    const started = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/start`,
      headers: bearer(teacherA),
    })
    expect(started.statusCode).toBe(200)

    const student = await joinStudent('delstudent', joinCodeOf(sessionId))
    const state = await app.server.inject({
      method: 'GET',
      url: '/api/sessions/current',
      headers: bearer(student),
    })
    const questionId = (state.json() as { questions: Array<{ id: string }> }).questions[0]!.id
    const submitted = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/submit`,
      headers: bearer(student),
      payload: { answers: { [questionId]: { boolean: true } } },
    })
    expect(submitted.statusCode).toBe(200)
    expect(leftBehind(sessionId)).toBeGreaterThan(0)

    // The class has handed the paper in, so the run is over and can go.
    const finished = await app.server.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: bearer(teacherA),
      payload: { status: 'finished' },
    })
    expect(finished.statusCode).toBe(200)

    const deleted = await app.server.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}`,
      headers: bearer(teacherA),
    })
    expect(deleted.statusCode).toBe(204)

    // Gone by id, gone from the list, and nothing left behind pointing at it.
    const gone = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}`,
      headers: bearer(teacherA),
    })
    expect(gone.statusCode).toBe(404)
    expect((await list(teacherA)).sessions.some((row) => row.id === sessionId)).toBe(false)
    expect(leftBehind(sessionId)).toBe(0)
  })

  it('is the owner\'s to do, or an admin\'s', async () => {
    const sessionId = await startSession(teacherA, 'Somebody else\'s run')

    const refused = await app.server.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}`,
      headers: bearer(teacherB),
    })
    expect(refused.statusCode).toBe(403)
    const survives = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}`,
      headers: bearer(teacherA),
    })
    expect(survives.statusCode).toBe(200)

    const byAdmin = await app.server.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}`,
      headers: bearer(admin),
    })
    expect(byAdmin.statusCode).toBe(204)
  })

  it('refuses a run that is still going, and allows it once it is over', async () => {
    const sessionId = await startSession(teacherA, 'Still running')
    await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/start`,
      headers: bearer(teacherA),
    })

    const running = await app.server.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}`,
      headers: bearer(teacherA),
    })
    expect(running.statusCode).toBe(409)

    // A pause is still a class mid-answer, so it is refused as well.
    await app.server.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: bearer(teacherA),
      payload: { status: 'paused' },
    })
    const paused = await app.server.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}`,
      headers: bearer(teacherA),
    })
    expect(paused.statusCode).toBe(409)

    await app.server.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      headers: bearer(teacherA),
      payload: { status: 'finished' },
    })
    const finished = await app.server.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}`,
      headers: bearer(teacherA),
    })
    expect(finished.statusCode).toBe(204)
  })

  it('throws away a lobby nobody ever started, and 404s one that is not there', async () => {
    const sessionId = await startSession(teacherA, 'Opened by mistake')
    const deleted = await app.server.inject({
      method: 'DELETE',
      url: `/api/sessions/${sessionId}`,
      headers: bearer(teacherA),
    })
    expect(deleted.statusCode).toBe(204)

    const missing = await app.server.inject({
      method: 'DELETE',
      url: '/api/sessions/00000000-0000-4000-8000-000000000000',
      headers: bearer(teacherA),
    })
    expect(missing.statusCode).toBe(404)
  })
})

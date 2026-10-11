import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { insertTestAdmin } from './support'

process.env.ADMIN_PASSWORD = 'test-admin-password'

let app: TestingApp
let tmpDir: string

function bearer(token: string) {
  return { authorization: `Bearer ${token}` }
}

async function login(username: string, password: string): Promise<string> {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { token: string }).token
}


/**
 * Starts a run that was just created.
 *
 * A session is born in the lobby now, so a test that is about answering has to
 * open it first - which is the same thing the teacher does, and the reason the
 * lobby exists.
 */
async function startNow(token: string, sessionId: string): Promise<void> {
  const res = await app.server.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/start`,
    headers: bearer(token),
  })
  expect(res.statusCode).toBe(200)
}

/** A test with all five question types, owned by the teacher. */
async function seedTest(token: string): Promise<string> {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/tests',
    headers: bearer(token),
    payload: {
      title: 'Mixed quiz',
      timeLimitSec: 600,
      passingPercent: 50,
      questions: [
        {
          type: 'single_choice',
          body: 'Capital of Ukraine?',
          points: 2,
          position: 0,
          payload: {
            options: [
              { key: 'a', text: 'Kyiv' },
              { key: 'b', text: 'Lviv' },
            ],
            correct: 'a',
          },
        },
        {
          type: 'multiple_choice',
          body: 'Even numbers?',
          points: 2,
          position: 1,
          payload: {
            options: [
              { key: 'a', text: '2' },
              { key: 'b', text: '3' },
              { key: 'c', text: '4' },
            ],
            correct: ['a', 'c'],
          },
        },
        {
          type: 'true_false',
          body: 'Water boils at 100 C at sea level.',
          points: 1,
          position: 2,
          payload: { correct: true },
        },
        {
          type: 'short_answer',
          body: 'Gas plants breathe out.',
          points: 1,
          position: 3,
          payload: { accepted: ['oxygen', 'O2'] },
        },
        {
          type: 'matching',
          body: 'Match the animal to its home.',
          points: 2,
          position: 4,
          payload: {
            pairs: [
              { left: 'Cat', right: 'Animal' },
              { left: 'Rose', right: 'Plant' },
            ],
          },
        },
      ],
    },
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { test: { id: string } }).test.id
}

/** The student's paper is shuffled, so tests must look questions up by type. */
function questionOfType<T extends { type: string }>(questions: readonly T[], type: string): T {
  const found = questions.find((question) => question.type === type)
  if (!found) throw new Error(`no ${type} question in the paper`)
  return found
}

interface SessionBody {
  session: {
    id: string
    joinCode: string
    status: string
    timeLimitSec: number | null
    passingPercent: number | null
    test: { title: string; questionCount: number }
  }
}

interface JoinBody {
  participation: { id: string; status: string; questionOrder: string[] }
  session: { id: string; status: string; timeLimitSec: number | null; startedAt: string; serverNow: string }
  questions: Array<{
    id: string
    type: string
    body: string
    points: number
    position: number
    payload: Record<string, unknown>
  }>
}

interface SubmitBody {
  participation: { id: string; status: string; score: number; maxScore: number; percent: number; passed: boolean | null }
  result: { score: number; maxScore: number; percent: number; passed: boolean | null }
}

interface ParticipantsBody {
  session: { id: string; status: string }
  participants: Array<{ username: string; status: string; percent: number | null; passed: boolean | null }>
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-sessions-'))
  app = buildApp({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(tmpDir, 'test.db'),
    webRoot: null,
  })
  insertTestAdmin(app)
  await app.server.ready()

  const adminToken = await login('admin', process.env.ADMIN_PASSWORD!)
  for (const [username, fullName] of [
    ['teacher1', 'Teacher One'],
    ['teacher2', 'Teacher Two'],
  ] as const) {
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/users',
      headers: bearer(adminToken),
      payload: { username, password: 'teacher-pass-1', fullName },
    })
    expect(res.statusCode).toBe(201)
  }
})

afterAll(() => {
  app.database.close()
  rmSync(tmpDir, { recursive: true, force: true })
})


/** Registers and approves a student with a unique username, returning a token. */
async function approvedStudentForList(username = 'liststudent'): Promise<string> {
  const adminToken = await login('admin', process.env.ADMIN_PASSWORD!)
  const registered = await app.server.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'student-pass-1', fullName: username },
  })
  expect(registered.statusCode).toBe(201)
  const id = (registered.json() as { user: { id: string } }).user.id
  await app.server.inject({
    method: 'PATCH',
    url: `/api/users/${id}/status`,
    headers: bearer(adminToken),
    payload: { status: 'approved' },
  })
  return login(username, 'student-pass-1')
}

describe('live sessions: teacher side', () => {
  it('starts a session for an owned test and hands out a 6-character code', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)

    const res = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    expect(res.statusCode).toBe(201)
    const { session } = res.json() as SessionBody
    expect(session.joinCode).toMatch(/^[A-Z0-9]{6}$/)
    // A run is born in the lobby now: it has a code and a paper, but no clock
    // until the teacher starts it.
    expect(session.status).toBe('lobby')

    const started = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/start`,
      headers: bearer(teacherToken),
    })
    expect(started.statusCode).toBe(200)
    expect((started.json() as SessionBody).session.status).toBe('active')
    expect(session.timeLimitSec).toBe(600)
    expect(session.passingPercent).toBe(50)
    expect(session.test.questionCount).toBe(5)
  })

  it('refuses to start a session for a test with no questions', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/tests',
      headers: bearer(teacherToken),
      payload: { title: 'Empty test' },
    })
    const testId = (created.json() as { test: { id: string } }).test.id

    const res = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses to start a session on another teacher test', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    // A second teacher cannot borrow the first teacher's test.
    const secondToken = await login('teacher2', 'teacher-pass-1')

    const res = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(secondToken),
      payload: { testId },
    })
    expect(res.statusCode).toBe(403)
  })

  it('pauses, resumes and finishes a session', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)

    const paused = await app.server.inject({
      method: 'PATCH',
      url: `/api/sessions/${session.id}`,
      headers: bearer(teacherToken),
      payload: { status: 'paused' },
    })
    expect((paused.json() as SessionBody).session.status).toBe('paused')

    const resumed = await app.server.inject({
      method: 'PATCH',
      url: `/api/sessions/${session.id}`,
      headers: bearer(teacherToken),
      payload: { status: 'active' },
    })
    expect((resumed.json() as SessionBody).session.status).toBe('active')

    const finished = await app.server.inject({
      method: 'PATCH',
      url: `/api/sessions/${session.id}`,
      headers: bearer(teacherToken),
      payload: { status: 'finished' },
    })
    expect((finished.json() as SessionBody).session.status).toBe('finished')

    const again = await app.server.inject({
      method: 'PATCH',
      url: `/api/sessions/${session.id}`,
      headers: bearer(teacherToken),
      payload: { status: 'active' },
    })
    expect(again.statusCode).toBe(409)
  })

  it('lists the own sessions of a teacher with counts, and nobody else', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const first = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const firstId = (first.json() as SessionBody).session.id
    await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })

    const res = await app.server.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: bearer(teacherToken),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      sessions: Array<{
        id: string
        title: string
        joinedCount: number
        submittedCount: number
      }>
    }
    // Earlier tests in this file start sessions too, so assert on membership.
    expect(body.sessions.filter((session) => session.title === 'Mixed quiz').length).toBeGreaterThanOrEqual(2)
    const mine = body.sessions.filter((session) => session.id === firstId)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.title).toBe('Mixed quiz')
    expect(mine[0]?.joinedCount).toBe(0)
    expect(mine[0]?.submittedCount).toBe(0)

    // A second teacher sees none of the first teacher's sessions.
    const other = await app.server.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: bearer(await login('teacher2', 'teacher-pass-1')),
    })
    expect((other.json() as { sessions: unknown[] }).sessions).toHaveLength(0)

    // An admin sees every teacher's sessions.
    const asAdmin = await app.server.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: bearer(await login('admin', 'test-admin-password')),
    })
    expect((asAdmin.json() as { sessions: unknown[] }).sessions.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps a student out of the session list', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: bearer(await approvedStudentForList()),
    })
    expect(res.statusCode).toBe(403)
  })

  it('shows the answer key to the owning teacher only', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)

    const ok = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/review`,
      headers: bearer(teacherToken),
    })
    expect(ok.statusCode).toBe(200)
    const body = ok.json() as { questions: Array<{ payload: Record<string, unknown> }> }
    expect(body.questions[0]?.payload).toHaveProperty('correct', 'a')

    const forbidden = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/review`,
      headers: bearer(await login('teacher2', 'teacher-pass-1')),
    })
    expect(forbidden.statusCode).toBe(403)
  })
})

describe('live sessions: student side', () => {
  async function approvedStudent(username: string): Promise<string> {
    const adminToken = await login('admin', 'test-admin-password')
    const registered = await app.server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'student-pass-1', fullName: username },
    })
    const id = (registered.json() as { user: { id: string } }).user.id
    const approved = await app.server.inject({
      method: 'PATCH',
      url: `/api/users/${id}/status`,
      headers: bearer(adminToken),
      payload: { status: 'approved' },
    })
    expect(approved.statusCode).toBe(200)
    return login(username, 'student-pass-1')
  }

  it('never sends the answer key to the student', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    const studentToken = await approvedStudent('student01')

    const joined = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })
    expect(joined.statusCode).toBe(201)
    const body = joined.json() as JoinBody
    expect(body.questions).toHaveLength(5)
    for (const question of body.questions) {
      expect(question.payload).not.toHaveProperty('correct')
      expect(question.payload).not.toHaveProperty('accepted')
    }
    // Choices keep their keys and texts so the client can submit keys.
    expect(questionOfType(body.questions, 'single_choice').payload).toMatchObject({
      options: [
        { key: 'a', text: 'Kyiv' },
        { key: 'b', text: 'Lviv' },
      ],
    })
    // Matching keeps both sides; there is no key to leak.
    expect(questionOfType(body.questions, 'matching').payload).toMatchObject({
      pairs: [
        { left: 'Cat', right: 'Animal' },
        { left: 'Rose', right: 'Plant' },
      ],
    })
  })

  it('accepts a lowercase code with stray spaces', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    const studentToken = await approvedStudent('student02')

    const joined = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: ` ${session.joinCode.toLowerCase()} ` },
    })
    expect(joined.statusCode).toBe(201)
  })

  it('answers 404, not 400, for a code that cannot exist', async () => {
    const studentToken = await approvedStudent('student15')
    for (const code of ['ZZ', 'not a code', '      ']) {
      const res = await app.server.inject({
        method: 'POST',
        url: '/api/sessions/join',
        headers: bearer(studentToken),
        payload: { code },
      })
      expect(res.statusCode).toBe(404)
    }
  })

  it('keeps the question order stable when the student rejoins', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    const studentToken = await approvedStudent('student03')

    const first = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })
    const firstBody = first.json() as JoinBody
    const again = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })
    const againBody = again.json() as JoinBody
    expect(againBody.participation.id).toBe(firstBody.participation.id)
    expect(againBody.questions.map((q) => q.id)).toEqual(firstBody.questions.map((q) => q.id))
  })

  it('rejects an unknown code and a finished session', async () => {
    const studentToken = await approvedStudent('student04')
    const unknown = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: 'ZZZZZZ' },
    })
    expect(unknown.statusCode).toBe(404)

    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    await app.server.inject({
      method: 'PATCH',
      url: `/api/sessions/${session.id}`,
      headers: bearer(teacherToken),
      payload: { status: 'finished' },
    })
    const closed = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })
    expect(closed.statusCode).toBe(409)
  })

  it('refuses to let a teacher or admin join as a student', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(teacherToken),
      payload: { code: session.joinCode },
    })
    expect(res.statusCode).toBe(403)
  })

  it('grades a full submission across all five question types', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    const studentToken = await approvedStudent('student05')
    const joined = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })
    const { participation, questions } = joined.json() as JoinBody
    expect(participation.status).toBe('joined')

    // Answers are keyed by question id, so the shuffled order does not matter.
    const byType = (type: string) => questions.find((question) => question.type === type)?.id
    const submitted = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/submit`,
      headers: bearer(studentToken),
      payload: {
        answers: {
          [byType('single_choice') as string]: { key: 'a' },
          [byType('multiple_choice') as string]: { keys: ['c', 'a'] },
          [byType('true_false') as string]: { boolean: true },
          [byType('short_answer') as string]: { text: ' OXYGEN ' },
          [byType('matching') as string]: {
            pairs: [
              { left: 'Cat', right: 'Animal' },
              { left: 'Rose', right: 'Plant' },
            ],
          },
        },
      },
    })
    expect(submitted.statusCode).toBe(200)
    const body = submitted.json() as SubmitBody
    expect(body.participation.status).toBe('submitted')
    expect(body.result).toEqual({ score: 8, maxScore: 8, percent: 100, passed: true })
  })

  it('counts unanswered and wrong answers as zero', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    const studentToken = await approvedStudent('student06')
    const joined = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })
    const { questions } = joined.json() as JoinBody
    const single = questions.find((question) => question.type === 'single_choice')?.id

    const submitted = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/submit`,
      headers: bearer(studentToken),
      payload: { answers: { [single as string]: { key: 'b' } } },
    })
    const body = submitted.json() as SubmitBody
    expect(body.result).toEqual({ score: 0, maxScore: 8, percent: 0, passed: false })
  })

  it('refuses a second submission and a submission without joining', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    const studentToken = await approvedStudent('student07')

    const withoutJoin = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/submit`,
      headers: bearer(studentToken),
      payload: { answers: {} },
    })
    expect(withoutJoin.statusCode).toBe(403)

    await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })
    await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/submit`,
      headers: bearer(studentToken),
      payload: { answers: {} },
    })
    const twice = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/submit`,
      headers: bearer(studentToken),
      payload: { answers: {} },
    })
    expect(twice.statusCode).toBe(409)
  })

  it('returns the graded paper with the answer key after submitting', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    const studentToken = await approvedStudent('student08')
    const joined = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })
    const { questions } = joined.json() as JoinBody
    const single = questions.find((question) => question.type === 'single_choice')?.id

    const beforeSubmit = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/result`,
      headers: bearer(studentToken),
    })
    expect(beforeSubmit.statusCode).toBe(409)

    await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/submit`,
      headers: bearer(studentToken),
      payload: { answers: { [single as string]: { key: 'a' } } },
    })
    const result = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/result`,
      headers: bearer(studentToken),
    })
    expect(result.statusCode).toBe(200)
    const body = result.json() as {
      participation: { percent: number; passed: boolean | null }
      test: { title: string }
      questions: Array<{
        type: string
        isCorrect: boolean
        pointsAwarded: number
        payload: Record<string, unknown>
      }>
    }
    expect(body.participation.percent).toBe(25)
    expect(body.participation.passed).toBe(false)
    expect(body.test.title).toBe('Mixed quiz')
    expect(body.questions).toHaveLength(5)
    expect(questionOfType(body.questions, 'single_choice').payload).toHaveProperty('correct', 'a')
  })

  it('hides another student participation', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    await approvedStudent('student09')
    const otherToken = await approvedStudent('student10')
    await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(otherToken),
      payload: { code: session.joinCode },
    })
    const res = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/result`,
      headers: bearer(await login('student09', 'student-pass-1')),
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('live sessions: teacher board', () => {
  it('lists participants with their scores as they submit', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const adminToken = await login('admin', 'test-admin-password')

    const registered = await app.server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'student11', password: 'student-pass-1', fullName: 'Eleven' },
    })
    const studentId = (registered.json() as { user: { id: string } }).user.id
    await app.server.inject({
      method: 'PATCH',
      url: `/api/users/${studentId}/status`,
      headers: bearer(adminToken),
      payload: { status: 'approved' },
    })
    const studentToken = await login('student11', 'student-pass-1')

    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)

    const empty = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/participants`,
      headers: bearer(teacherToken),
    })
    expect((empty.json() as ParticipantsBody).participants).toHaveLength(0)

    const joined = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })
    const { questions } = joined.json() as JoinBody
    const single = questions.find((question) => question.type === 'single_choice')?.id
    await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/submit`,
      headers: bearer(studentToken),
      payload: { answers: { [single as string]: { key: 'a' } } },
    })

    const board = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/participants`,
      headers: bearer(teacherToken),
    })
    const body = board.json() as ParticipantsBody
    expect(body.participants).toHaveLength(1)
    expect(body.participants[0]?.username).toBe('student11')
    expect(body.participants[0]?.status).toBe('submitted')
    expect(body.participants[0]?.percent).toBe(25)
    expect(body.participants[0]?.passed).toBe(false)
  })

  it('auto-submits and closes a session whose time limit has passed', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const adminToken = await login('admin', 'test-admin-password')
    const registered = await app.server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'student12', password: 'student-pass-1', fullName: 'Twelve' },
    })
    const studentId = (registered.json() as { user: { id: string } }).user.id
    await app.server.inject({
      method: 'PATCH',
      url: `/api/users/${studentId}/status`,
      headers: bearer(adminToken),
      payload: { status: 'approved' },
    })
    const studentToken = await login('student12', 'student-pass-1')

    // A 1-second limit that the test below backdates past the deadline.
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/tests',
      headers: bearer(teacherToken),
      payload: {
        title: 'Timed out quiz',
        timeLimitSec: 1,
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
    const testId = (created.json() as { test: { id: string } }).test.id
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })

    // Move the session's start back so the limit is in the past.
    app.database.raw
      .prepare('UPDATE live_sessions SET started_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), session.id)

    const board = await app.server.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/participants`,
      headers: bearer(teacherToken),
    })
    const body = board.json() as ParticipantsBody
    expect(body.session.status).toBe('finished')
    expect(body.participants[0]?.status).toBe('auto_submitted')
    expect(body.participants[0]?.percent).toBe(0)

    const lateJoin = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })
    expect(lateJoin.statusCode).toBe(409)
  })

  it('resumes a student mid-session through the current-session endpoint', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const adminToken = await login('admin', 'test-admin-password')
    const registered = await app.server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'student13', password: 'student-pass-1', fullName: 'Thirteen' },
    })
    const studentId = (registered.json() as { user: { id: string } }).user.id
    await app.server.inject({
      method: 'PATCH',
      url: `/api/users/${studentId}/status`,
      headers: bearer(adminToken),
      payload: { status: 'approved' },
    })
    const studentToken = await login('student13', 'student-pass-1')

    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    const joined = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })
    const firstQuestions = (joined.json() as JoinBody).questions.map((question) => question.id)

    const current = await app.server.inject({
      method: 'GET',
      url: '/api/sessions/current',
      headers: bearer(studentToken),
    })
    expect(current.statusCode).toBe(200)
    const body = current.json() as JoinBody
    expect(body.session.id).toBe(session.id)
    expect(body.questions.map((question) => question.id)).toEqual(firstQuestions)
    expect(body.session.serverNow).toBeTruthy()
  })

  it('lists the student own results, newest first, and nobody elses', async () => {
    const teacherToken = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(teacherToken)
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherToken),
      payload: { testId },
    })
    const { session } = started.json() as SessionBody
    await startNow(teacherToken, session.id)
    const studentToken = await approvedStudentForList('historystudent')

    const empty = await app.server.inject({
      method: 'GET',
      url: '/api/student/results',
      headers: bearer(studentToken),
    })
    expect(empty.statusCode).toBe(200)
    expect((empty.json() as { results: unknown[] }).results).toEqual([])

    const joined = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/join',
      headers: bearer(studentToken),
      payload: { code: session.joinCode },
    })
    const { questions } = joined.json() as JoinBody
    const single = questions.find((question) => question.type === 'single_choice')?.id

    // Still in the paper: not a result yet.
    const whileWorking = await app.server.inject({
      method: 'GET',
      url: '/api/student/results',
      headers: bearer(studentToken),
    })
    expect((whileWorking.json() as { results: unknown[] }).results).toEqual([])

    await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/submit`,
      headers: bearer(studentToken),
      payload: { answers: { [single as string]: { key: 'a' } } },
    })

    const res = await app.server.inject({
      method: 'GET',
      url: '/api/student/results',
      headers: bearer(studentToken),
    })
    expect(res.statusCode).toBe(200)
    // The session is still running, but this paper is done: the resume
    // endpoint must not hand it back, or the student lands on a dead screen.
    const resume = await app.server.inject({
      method: 'GET',
      url: '/api/sessions/current',
      headers: bearer(studentToken),
    })
    expect(resume.statusCode).toBe(404)

    const body = res.json() as {
      results: Array<{
        testTitle: string
        status: string
        percent: number
        passed: boolean | null
        questionCount: number
        submittedAt: string
        joinCode: string
      }>
    }
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.testTitle).toBe('Mixed quiz')
    expect(body.results[0]?.status).toBe('submitted')
    expect(body.results[0]?.percent).toBe(25)
    expect(body.results[0]?.passed).toBe(false)
    expect(body.results[0]?.questionCount).toBe(5)
    expect(body.results[0]?.submittedAt).toBeTruthy()
    expect(body.results[0]?.joinCode).toBe(session.joinCode)

    // Teachers and admins do not have a student history endpoint.
    const asTeacher = await app.server.inject({
      method: 'GET',
      url: '/api/student/results',
      headers: bearer(teacherToken),
    })
    expect(asTeacher.statusCode).toBe(403)
  })

  it('reports no active session for a student who never joined', async () => {
    const adminToken = await login('admin', 'test-admin-password')
    const registered = await app.server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'student14', password: 'student-pass-1', fullName: 'Fourteen' },
    })
    const studentId = (registered.json() as { user: { id: string } }).user.id
    await app.server.inject({
      method: 'PATCH',
      url: `/api/users/${studentId}/status`,
      headers: bearer(adminToken),
      payload: { status: 'approved' },
    })
    const res = await app.server.inject({
      method: 'GET',
      url: '/api/sessions/current',
      headers: bearer(await login('student14', 'student-pass-1')),
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('a run can be given more time', () => {
  it('adds the seconds to the clock, and leaves a run with no clock alone', async () => {
    const owner = await login('teacher1', 'teacher-pass-1')
    const limited = await seedTest(owner)
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(owner),
      payload: { testId: limited },
    })
    const session = (created.json() as SessionBody).session
    expect(session.timeLimitSec).toBe(600)

    const extended = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/extend`,
      headers: bearer(owner),
      payload: { seconds: 90 },
    })
    expect(extended.statusCode).toBe(200)
    expect((extended.json() as SessionBody).session.timeLimitSec).toBe(690)

    // A run with no limit has no clock to add to. It is not an error: the
    // teacher clicked a button while watching a class, and the class is still
    // sitting there - a 400 would make the screen lie about what it just did.
    const untimed = await app.server.inject({
      method: 'POST',
      url: '/api/tests',
      headers: bearer(owner),
      payload: {
        title: 'No clock',
        timeLimitSec: null,
        questions: [
          { type: 'true_false', body: 'No time limit?', points: 1, position: 0, payload: { correct: true } },
        ],
      },
    })
    const untimedId = (untimed.json() as { test: { id: string } }).test.id
    const open = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(owner),
      payload: { testId: untimedId },
    })
    const openId = (open.json() as SessionBody).session.id
    const stillUntimed = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${openId}/extend`,
      headers: bearer(owner),
      payload: { seconds: 90 },
    })
    expect(stillUntimed.statusCode).toBe(200)
    expect((stillUntimed.json() as SessionBody).session.timeLimitSec).toBeNull()
  })

  it('is the owner\'s to give, and nobody else\'s', async () => {
    const owner = await login('teacher1', 'teacher-pass-1')
    const testId = await seedTest(owner)
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(owner),
      payload: { testId },
    })
    const session = (created.json() as SessionBody).session

    const byStranger = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/extend`,
      headers: bearer(await login('teacher2', 'teacher-pass-1')),
      payload: { seconds: 90 },
    })
    expect(byStranger.statusCode).toBe(403)

    const student = await approvedStudentForList('extstudent')
    const byStudent = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/extend`,
      headers: bearer(student),
      payload: { seconds: 90 },
    })
    expect(byStudent.statusCode).toBe(403)

    const missing = await app.server.inject({
      method: 'POST',
      url: '/api/sessions/00000000-0000-4000-8000-000000000000/extend',
      headers: bearer(owner),
      payload: { seconds: 90 },
    })
    expect(missing.statusCode).toBe(404)

    // An hour is the most a class period needs; beyond that it is a typo.
    const tooMuch = await app.server.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/extend`,
      headers: bearer(owner),
      payload: { seconds: 7200 },
    })
    expect(tooMuch.statusCode).toBe(400)
  })
})

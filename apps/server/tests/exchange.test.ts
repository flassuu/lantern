import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { insertTestAdmin } from './support'

process.env.ADMIN_PASSWORD = 'test-admin-password'

interface TestPayload {
  id: string
  title: string
  description: string
  timeLimitSec: number | null
  passingPercent: number | null
  questionCount: number
}

interface QuestionPayload {
  id: string
  type: string
  body: string
  payload: Record<string, unknown>
  points: number
  position: number
}

interface Exchange {
  format: string
  version: number
  title: string
  description: string
  timeLimitSec: number | null
  passingPercent: number | null
  questions: Array<{
    type: string
    body: string
    payload: Record<string, unknown>
    points: number
    position: number
  }>
}

let app: TestingApp
let tmpDir: string
let adminToken: string
let teacherToken: string
let otherTeacherToken: string
let studentToken: string

const SOURCE_QUESTIONS = [
  {
    type: 'single_choice',
    body: 'Capital of Ukraine?',
    points: 3,
    position: 0,
    payload: { options: [{ key: 'a', text: 'Kyiv' }, { key: 'b', text: 'Lviv' }], correct: 'a' },
  },
  {
    type: 'matching',
    body: 'Match the parts',
    points: 4,
    position: 1,
    payload: {
      pairs: [
        { left: 'Roots', right: 'Absorb water' },
        { left: 'Leaves', right: 'Catch light' },
      ],
    },
  },
]

async function login(username: string, password: string) {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { token: string }).token
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

async function makeTest(token: string, title = 'Exchange test'): Promise<string> {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/tests',
    headers: bearer(token),
    payload: {
      title,
      description: 'Round trip',
      timeLimitSec: 900,
      passingPercent: 60,
      questions: SOURCE_QUESTIONS,
    },
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { test: TestPayload }).test.id
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-exchange-'))
  app = buildApp({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(tmpDir, 'test.db'),
    webRoot: null,
  })
  await app.server.ready()

  insertTestAdmin(app)
  adminToken = await login('admin', process.env.ADMIN_PASSWORD!)
  for (const username of ['teacher1', 'teacher2']) {
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/users',
      headers: bearer(adminToken),
      payload: { username, password: 'teacher-pass-1', fullName: username },
    })
    expect(created.statusCode).toBe(201)
  }
  teacherToken = await login('teacher1', 'teacher-pass-1')
  otherTeacherToken = await login('teacher2', 'teacher-pass-1')

  const registered = await app.server.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'student1', password: 'student-pass-1', fullName: 'Student One' },
  })
  const studentId = (registered.json() as { user: { id: string } }).user.id
  await app.server.inject({
    method: 'PATCH',
    url: `/api/users/${studentId}/status`,
    headers: bearer(adminToken),
    payload: { status: 'approved' },
  })
  studentToken = await login('student1', 'student-pass-1')
})

afterAll(() => {
  app.database.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('test exchange format', () => {
  it('exports the test without ids and imports it back intact', async () => {
    const testId = await makeTest(teacherToken)

    const exported = await app.server.inject({
      method: 'GET',
      url: `/api/tests/${testId}/export`,
      headers: bearer(teacherToken),
    })
    expect(exported.statusCode).toBe(200)
    expect(exported.headers['content-disposition']).toContain('exchange-test.json')
    const document = JSON.parse(exported.payload) as Exchange

    expect(document.format).toBe('knowledge-testing.test')
    expect(document.version).toBe(1)
    expect(document.title).toBe('Exchange test')
    expect(document.description).toBe('Round trip')
    expect(document.timeLimitSec).toBe(900)
    expect(document.passingPercent).toBe(60)
    expect(document.questions).toHaveLength(2)
    // Answer keys travel with the file: a colleague has to be able to run it.
    expect(document.questions[0]?.payload).toEqual({
      options: [{ key: 'a', text: 'Kyiv' }, { key: 'b', text: 'Lviv' }],
      correct: 'a',
    })
    // Nothing about this installation leaks into the file.
    expect(JSON.stringify(document)).not.toContain(testId)

    const imported = await app.server.inject({
      method: 'POST',
      url: '/api/tests/import',
      headers: bearer(teacherToken),
      payload: document,
    })
    expect(imported.statusCode).toBe(201)
    const created = (imported.json() as { test: TestPayload & { questions: QuestionPayload[] } }).test
    expect(created.id).not.toBe(testId)
    expect(created.title).toBe('Exchange test')
    expect(created.questions).toHaveLength(2)
    expect(created.questions.map((question) => question.body)).toEqual([
      'Capital of Ukraine?',
      'Match the parts',
    ])
    expect(created.questions[1]?.payload).toEqual(document.questions[1]?.payload)
  })

  it('carries a question image in the file, and says when a copy loses it', async () => {
    // A picture travels as an id, which means nothing after the file crosses to
    // another machine - so the import must keep what it can prove and admit the
    // rest, rather than save a paper full of holes.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const uploaded = await app.server.inject({
      method: 'POST',
      url: '/api/assets?name=diagram.png',
      headers: { ...bearer(teacherToken), 'content-type': 'application/octet-stream' },
      payload: png,
    })
    expect(uploaded.statusCode).toBe(201)
    const assetId = (uploaded.json() as { asset: { id: string } }).asset.id

    const created = await app.server.inject({
      method: 'POST',
      url: '/api/tests',
      headers: bearer(teacherToken),
      payload: {
        title: 'With a picture',
        description: '',
        timeLimitSec: null,
        passingPercent: null,
        questions: [
          {
            type: 'true_false',
            body: 'Read the diagram',
            points: 1,
            position: 0,
            payload: { correct: true, media: { assetId } },
          },
        ],
      },
    })
    expect(created.statusCode).toBe(201)

    const exported = await app.server.inject({
      method: 'GET',
      url: `/api/tests/${(created.json() as { test: TestPayload }).test.id}/export`,
      headers: bearer(teacherToken),
    })
    const document = JSON.parse(exported.payload) as Exchange

    // The same teacher keeps the picture: the id is theirs, and the bytes are
    // still on this server.
    const kept = await app.server.inject({
      method: 'POST',
      url: '/api/tests/import',
      headers: bearer(teacherToken),
      payload: document,
    })
    expect(kept.statusCode).toBe(201)
    const keptBody = kept.json() as {
      test: TestPayload & { questions: QuestionPayload[] }
      imagesDropped?: number
    }
    expect(keptBody.imagesDropped).toBeUndefined()
    expect(keptBody.test.questions[0]?.payload).toEqual(document.questions[0]?.payload)

    // Another teacher gets the same file and no such image - the diagram goes,
    // and the response says how many.
    const elsewhere = await app.server.inject({
      method: 'POST',
      url: '/api/tests/import',
      headers: bearer(otherTeacherToken),
      payload: document,
    })
    expect(elsewhere.statusCode).toBe(201)
    const elsewhereBody = elsewhere.json() as {
      test: TestPayload & { questions: QuestionPayload[] }
      imagesDropped?: number
    }
    expect(elsewhereBody.imagesDropped).toBe(1)
    expect(elsewhereBody.test.questions[0]?.payload).toEqual({ correct: true })
  })

  it('renumbers positions, so a file with odd numbering still imports', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/tests/import',
      headers: bearer(teacherToken),
      payload: {
        format: 'knowledge-testing.test',
        version: 1,
        title: 'Renumbered',
        description: '',
        timeLimitSec: null,
        passingPercent: null,
        questions: [
          { type: 'true_false', body: 'First', points: 1, position: 7, payload: { correct: true } },
          { type: 'true_false', body: 'Second', points: 2, position: 9, payload: { correct: false } },
        ],
      },
    })
    expect(res.statusCode).toBe(201)
    const test = (res.json() as { test: { questions: QuestionPayload[] } }).test
    expect(test.questions.map((question) => question.position)).toEqual([0, 1])
  })

  it('refuses a file that is not a test, or whose questions do not validate', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ hello: 'world' }, 'unrecognised format'],
      [{ format: 'knowledge-testing.test', version: 99, title: 'x', questions: [] }, 'unsupported file version'],
      [{ format: 'knowledge-testing.test', version: 1, title: '', questions: [] }, 'needs a title'],
      [{ format: 'knowledge-testing.test', version: 1, title: 'Empty', questions: [] }, 'at least one question'],
      [
        {
          format: 'knowledge-testing.test',
          version: 1,
          title: 'Broken',
          questions: [{ type: 'single_choice', body: 'No options', points: 1, position: 0, payload: {} }],
        },
        'question 1',
      ],
    ]

    for (const [payload, expected] of cases) {
      const res = await app.server.inject({
        method: 'POST',
        url: '/api/tests/import',
        headers: bearer(teacherToken),
        payload,
      })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: { code: string; message: string } }).error.code).toBe('VALIDATION')
      expect((res.json() as { error: { message: string } }).error.message).toContain(expected)
    }

    const notAnObject = await app.server.inject({
      method: 'POST',
      url: '/api/tests/import',
      headers: bearer(teacherToken),
      payload: ['not', 'an', 'object'] as unknown as Record<string, unknown>,
    })
    expect(notAnObject.statusCode).toBe(400)
  })
})

describe('test duplication', () => {
  it('copies the test with fresh question ids and leaves the original alone', async () => {
    const testId = await makeTest(teacherToken, 'For next year')

    const res = await app.server.inject({
      method: 'POST',
      url: `/api/tests/${testId}/duplicate`,
      headers: bearer(teacherToken),
    })
    expect(res.statusCode).toBe(201)
    const copy = (res.json() as { test: TestPayload & { questions: QuestionPayload[] } }).test

    expect(copy.id).not.toBe(testId)
    expect(copy.title).toBe('For next year (copy)')
    expect(copy.questions).toHaveLength(2)

    const original = await app.server.inject({
      method: 'GET',
      url: `/api/tests/${testId}`,
      headers: bearer(teacherToken),
    })
    const originalTest = (original.json() as { test: { title: string; questions: QuestionPayload[] } }).test
    const copyTest = await app.server.inject({
      method: 'GET',
      url: `/api/tests/${copy.id}`,
      headers: bearer(teacherToken),
    })
    const copyTestBody = (copyTest.json() as { test: { questions: QuestionPayload[] } }).test

    // New question ids, so editing the copy cannot touch the original.
    const originalIds = originalTest.questions.map((question) => question.id)
    const copyIds = copyTestBody.questions.map((question) => question.id)
    expect(copyIds.every((id) => !originalIds.includes(id))).toBe(true)
    expect(copyTestBody.questions.map((question) => question.body)).toEqual(
      originalTest.questions.map((question) => question.body),
    )

    const edited = await app.server.inject({
      method: 'PUT',
      url: `/api/tests/${copy.id}`,
      headers: bearer(teacherToken),
      payload: { title: 'Renamed copy', questions: [] },
    })
    expect(edited.statusCode).toBe(200)

    const untouched = await app.server.inject({
      method: 'GET',
      url: `/api/tests/${testId}`,
      headers: bearer(teacherToken),
    })
    const source = (untouched.json() as { test: { title: string; questions: unknown[] } }).test
    expect(source.title).toBe('For next year')
    expect(source.questions).toHaveLength(2)
  })

  it('gives the copy to the caller, so an admin can branch someone else test', async () => {
    const testId = await makeTest(teacherToken, 'Shared material')

    const res = await app.server.inject({
      method: 'POST',
      url: `/api/tests/${testId}/duplicate`,
      headers: bearer(otherTeacherToken),
    })
    expect(res.statusCode).toBe(403)

    const byAdmin = await app.server.inject({
      method: 'POST',
      url: `/api/tests/${testId}/duplicate`,
      headers: bearer(adminToken),
    })
    expect(byAdmin.statusCode).toBe(201)
    const copy = (byAdmin.json() as { test: TestPayload }).test
    expect(copy.title).toBe('Shared material (copy)')

    // The copy belongs to the admin, and the other teacher still cannot see it.
    const list = await app.server.inject({
      method: 'GET',
      url: '/api/tests',
      headers: bearer(otherTeacherToken),
    })
    const titles = (list.json() as { tests: TestPayload[] }).tests.map((test) => test.title)
    expect(titles).not.toContain('Shared material (copy)')
  })

  it('keeps export and duplicate away from students and strangers', async () => {
    const testId = await makeTest(teacherToken, 'Not yours')

    for (const token of [studentToken, otherTeacherToken]) {
      const exported = await app.server.inject({
        method: 'GET',
        url: `/api/tests/${testId}/export`,
        headers: bearer(token),
      })
      expect(exported.statusCode).toBe(403)

      const duplicated = await app.server.inject({
        method: 'POST',
        url: `/api/tests/${testId}/duplicate`,
        headers: bearer(token),
      })
      expect(duplicated.statusCode).toBe(403)
    }

    const importedByStudent = await app.server.inject({
      method: 'POST',
      url: '/api/tests/import',
      headers: bearer(studentToken),
      payload: {
        format: 'knowledge-testing.test',
        version: 1,
        title: 'Sneaky',
        questions: [{ type: 'true_false', body: 'x', points: 1, position: 0, payload: { correct: true } }],
      },
    })
    expect(importedByStudent.statusCode).toBe(403)

    const missing = await app.server.inject({
      method: 'GET',
      url: '/api/tests/00000000-0000-4000-8000-000000000000/export',
      headers: bearer(teacherToken),
    })
    expect(missing.statusCode).toBe(404)
  })
})
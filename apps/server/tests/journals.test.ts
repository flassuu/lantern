import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import type { Journal } from '../src/lib/journals'
import { addRoomMember } from '../src/lib/rooms'
import { insertTestAdmin } from './support'

// Deterministic admin bootstrap so the seed warning stays quiet in tests.
process.env.ADMIN_PASSWORD = 'test-admin-password'

let app: TestingApp
let tmpDir: string
let adminToken: string
let teacherToken: string
let otherToken: string
let studentToken: string
let courseId: string
let roomId: string
let testId: string
let otherTestId: string

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

async function makeTest(title: string, roomIdToAttach?: string): Promise<string> {
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/tests',
    headers: bearer(teacherToken),
    payload: {
      title,
      description: '',
      timeLimitSec: null,
      passingPercent: 50,
      ...(roomIdToAttach ? { roomId: roomIdToAttach } : {}),
      questions: [
        {
          type: 'true_false',
          body: 'Two plus two?',
          points: 1,
          position: 0,
          payload: { correct: true },
        },
      ],
    },
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { test: { id: string } }).test.id
}

async function runAndSubmit(testToRun: string, username: string, correct: boolean) {
  const session = await app.server.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: bearer(teacherToken),
    payload: { testId: testToRun },
  })
  const sessionId = (session.json() as { session: { id: string } }).session.id
  await app.server.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/start`,
    headers: bearer(teacherToken),
  })
  const login = await app.server.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'student-pass-1' },
  })
  const token = (login.json() as { token: string }).token
  const join = await app.server.inject({
    method: 'POST',
    url: '/api/sessions/join',
    headers: bearer(token),
    payload: { code: (session.json() as { session: { joinCode: string } }).session.joinCode },
  })
  expect(join.statusCode).toBe(201)
  const questionId = (join.json() as { questions: Array<{ id: string }> }).questions[0]!.id
  const submitted = await app.server.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/submit`,
    headers: bearer(token),
    // Answers are a map keyed by question id, the shape the runner sends.
    payload: { answers: { [questionId]: { boolean: correct } } },
  })
  expect(submitted.statusCode).toBe(200)
  return { sessionId, token }
}

describe('journals by room and by course', () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-journal-'))
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

  it('boots a teacher, a second teacher and two enrolled students', async () => {
    const admin = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: process.env.ADMIN_PASSWORD! },
    })
    adminToken = (admin.json() as { token: string }).token
    for (const [username, fullName] of [
      ['journalT', 'Teacher Journal'],
      ['journalO', 'Teacher Outsider'],
    ] as const) {
      const res = await app.server.inject({
        method: 'POST',
        url: '/api/users',
        headers: bearer(adminToken),
        payload: { username, password: 'teacher-pass-1', fullName },
      })
      expect(res.statusCode).toBe(201)
    }
    const own = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'journalT', password: 'teacher-pass-1' },
    })
    const other = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'journalO', password: 'teacher-pass-1' },
    })
    teacherToken = (own.json() as { token: string }).token
    otherToken = (other.json() as { token: string }).token

    for (const [username, fullName] of [
      ['journalS1', 'Stu One'],
      ['journalS2', 'Stu Two'],
    ] as const) {
      const reg = await app.server.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username, password: 'student-pass-1', fullName },
      })
      const id = (reg.json() as { user: { id: string } }).user.id
      await app.server.inject({
        method: 'PATCH',
        url: `/api/users/${id}/status`,
        headers: bearer(adminToken),
        payload: { status: 'approved' },
      })
    }

    const course = await app.server.inject({
      method: 'POST',
      url: '/api/courses',
      headers: bearer(teacherToken),
      payload: { title: 'Journal course', description: '' },
    })
    courseId = (course.json() as { id: string }).id
    const room = await app.server.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: bearer(teacherToken),
      payload: { name: 'Journal room', courseIds: [courseId] },
    })
    roomId = (room.json() as { room: { id: string } }).room.id
    for (const username of ['journalS1', 'journalS2']) {
      const enroll = await app.server.inject({
        method: 'POST',
        url: `/api/courses/${courseId}/enrollments`,
        headers: bearer(teacherToken),
        payload: { username },
      })
      expect(enroll.statusCode).toBe(201)
    }
    // Being enrolled in a course and being in the room are two different things:
    // the room is *who*, and its members are the roster a journal is about. In the
    // app a student joins the room by its key; here they are put in directly.
    for (const username of ['journalS1', 'journalS2']) {
      const row = app.database.raw
        .prepare('SELECT id FROM users WHERE username = ?')
        .get(username) as { id: string }
      addRoomMember(app.database.raw, roomId, row.id)
    }

    const login = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'journalS1', password: 'student-pass-1' },
    })
    studentToken = (login.json() as { token: string }).token
  })

  it('shows a cell per student and test, a dash for the ones never attempted', async () => {
    testId = await makeTest('Algebra', roomId)
    otherTestId = await makeTest('Geometry')

    // Two attempts on one test, so the cell can be "where they ended up" rather
    // than the flattering best.
    await runAndSubmit(testId, 'journalS1', false)
    await runAndSubmit(testId, 'journalS1', true)
    await runAndSubmit(otherTestId, 'journalS1', false)

    const res = await app.server.inject({
      method: 'GET',
      url: `/api/journals/rooms/${roomId}`,
      headers: bearer(teacherToken),
    })
    expect(res.statusCode).toBe(200)
    const { journal } = res.json() as { journal: Journal }
    expect(journal.scope).toBe('room')
    expect(journal.title).toBe('Journal room')
    // Only Algebra so far. Geometry was run in a run that could not name a room,
    // and it is not yet one of this room's course's tests, so nothing ties it to
    // this class - the test below attaches it and checks that it joins.
    expect(journal.tests.map((test) => test.title)).toEqual(['Algebra'])
    expect(journal.students.map((student) => student.username)).toEqual([
      'journalS1',
      'journalS2',
    ])

    const one = journal.students.findIndex((student) => student.username === 'journalS1')
    const two = journal.students.findIndex((student) => student.username === 'journalS2')
    // Two attempts, and the cell is where they ended up - not their best. A
    // journal that flatters the student hides the one who guessed once.
    expect(journal.cells[one]![0]).toMatchObject({ percent: 100, attempts: 2 })
    // Stu Two is on the roster and has done nothing: an empty cell, not a zero.
    expect(journal.cells[two]![0]).toEqual({
      percent: null,
      attempts: 0,
      lastSubmittedAt: null,
    })
  })

  it('covers the course plan, not only the tests that were run', async () => {
    for (const id of [testId, otherTestId]) {
      const attach = await app.server.inject({
        method: 'POST',
        url: `/api/courses/${courseId}/tests`,
        headers: bearer(teacherToken),
        payload: { testId: id },
      })
      expect(attach.statusCode).toBe(201)
    }

    const res = await app.server.inject({
      method: 'GET',
      url: `/api/journals/courses/${courseId}`,
      headers: bearer(teacherToken),
    })
    expect(res.statusCode).toBe(200)
    const { journal } = res.json() as { journal: Journal }
    expect(journal.scope).toBe('course')
    // Both tests, though only one was ever run: a course is a plan, and a test
    // nobody has done is exactly the empty cell worth seeing before a lesson.
    expect(journal.tests.map((test) => test.title).sort()).toEqual(['Algebra', 'Geometry'])
    const two = journal.students.findIndex((s) => s.username === 'journalS2')
    expect(journal.cells[two]!.every((cell) => cell.percent === null)).toBe(true)

    // The same attach makes Geometry a column of the room's journal: a run that
    // predates naming a room still happened for this class.
    const room = await app.server.inject({
      method: 'GET',
      url: `/api/journals/rooms/${roomId}`,
      headers: bearer(teacherToken),
    })
    const roomJournal = (room.json() as { journal: Journal }).journal
    expect(roomJournal.tests.map((test) => test.title)).toEqual(['Algebra', 'Geometry'])
    const one = roomJournal.students.findIndex((s) => s.username === 'journalS1')
    expect(roomJournal.cells[one]![1]).toMatchObject({ percent: 0, attempts: 1 })
  })

  it('exports the same numbers as CSV', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: `/api/journals/rooms/${roomId}?format=csv`,
      headers: bearer(teacherToken),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('journal-room.csv')
    const lines = res.payload.trim().split('\r\n')
    expect(lines[0]).toContain('Student')
    expect(lines[0]).toContain('Algebra')
    const one = lines.find((line) => line.includes('journalS1'))
    expect(one).toContain('100%')
    const two = lines.find((line) => line.includes('journalS2'))
    // An empty cell is an empty field; a zero would read as "scored nothing".
    expect(two).toBe('Stu Two,journalS2,,')
  })

  it('keeps the journal to the owner, and students out of it entirely', async () => {
    const byOther = await app.server.inject({
      method: 'GET',
      url: `/api/journals/rooms/${roomId}`,
      headers: bearer(otherToken),
    })
    expect(byOther.statusCode).toBe(403)
    const courseByOther = await app.server.inject({
      method: 'GET',
      url: `/api/journals/courses/${courseId}`,
      headers: bearer(otherToken),
    })
    expect(courseByOther.statusCode).toBe(403)
    const byStudent = await app.server.inject({
      method: 'GET',
      url: `/api/journals/rooms/${roomId}`,
      headers: bearer(studentToken),
    })
    expect(byStudent.statusCode).toBe(403)
    const byAdmin = await app.server.inject({
      method: 'GET',
      url: `/api/journals/rooms/${roomId}`,
      headers: bearer(adminToken),
    })
    expect(byAdmin.statusCode).toBe(200)

    const missing = await app.server.inject({
      method: 'GET',
      url: '/api/journals/rooms/00000000-0000-4000-8000-000000000000',
      headers: bearer(teacherToken),
    })
    expect(missing.statusCode).toBe(404)
  })
})

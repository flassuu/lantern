import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { DEMO_STUDENT_PASSWORD, seedDemo } from '../src/lib/demo'
import { courseJournal } from '../src/lib/journals'
import { listTopics } from '../src/lib/courses'
import { findUserByUsername } from '../src/lib/users'

process.env.TEACHER_PASSWORD = 'teacher-pass-1'
process.env.ADMIN_PASSWORD = 'test-admin-password'

let app: TestingApp
let tmpDir: string
let uploadsDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-demo-'))
  uploadsDir = join(tmpDir, 'uploads')
  app = buildApp({ host: '127.0.0.1', port: 0, dbPath: join(tmpDir, 'test.db'), webRoot: null })
})

afterAll(() => {
  app.server.close()
  app.database.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('demo data', () => {
  it('fills an empty database and says what it made', () => {
    const result = seedDemo(app.database.raw, { uploadsDir })
    expect(result.seeded).toBe(true)
    expect(result.teacher?.username).toBe('teacher')
    expect(result.students).toHaveLength(4)
    expect(result.students?.[0]?.password).toBe(DEMO_STUDENT_PASSWORD)
    expect(result.roomKey).toMatch(/^[A-Z0-9]{6}$/)
    expect(result.counts?.tests).toBe(5)
    expect(result.counts?.lessons).toBe(2)
    expect(result.counts?.journalCells).toBe(3)

    // The picture a question points at is on disk, not only in the database: a
    // row whose file is missing is a broken image on the one screen the demo
    // exists to show.
    expect(existsSync(join(uploadsDir, 'demo-refraction-diagram.png'))).toBe(true)
  })

  it('is a no-op the second time, rather than a second copy', () => {
    const again = seedDemo(app.database.raw, { uploadsDir })
    expect(again.seeded).toBe(false)
    expect(again.reason).toContain('already')
  })

  it('leaves a journal with numbers in it, and dashes for what was never run', () => {
    const journal = courseJournal(app.database.raw, lastCourseId(app), 'Physics, grade 9')
    expect(journal.tests).toHaveLength(5)
    expect(journal.students).toHaveLength(4)
    const filled = journal.cells.flat().filter((cell) => cell.percent !== null)
    const empty = journal.cells.flat().filter((cell) => cell.percent === null)
    // Three students answered one test; the rest of the plan was never run, and
    // that is the fact the journal is built to show rather than hide.
    expect(filled).toHaveLength(3)
    expect(empty.length).toBeGreaterThan(0)
  })

  it('files tests and materials under a lesson, and leaves the rest loose', () => {
    const rows = app.database.raw
      .prepare('SELECT COUNT(*) AS total FROM course_tests WHERE topic_id IS NOT NULL')
      .get() as { total: number }
    const loose = app.database.raw
      .prepare('SELECT COUNT(*) AS total FROM course_tests WHERE topic_id IS NULL')
      .get() as { total: number }
    const materials = app.database.raw
      .prepare('SELECT COUNT(*) AS total FROM materials WHERE topic_id IS NOT NULL')
      .get() as { total: number }
    expect(rows.total).toBe(2)
    expect(loose.total).toBe(3)
    expect(materials.total).toBe(1)
    expect(listTopics(app.database.raw, lastCourseId(app))).toHaveLength(2)
  })

  it('creates the students as approved, and reuses the teacher already here', () => {
    expect(findUserByUsername(app.database.raw, 'demo_alina')?.status).toBe('approved')
    // The server seeds a teacher on first boot; the demo uses that one rather
    // than creating a second.
    const teachers = app.database.raw
      .prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'teacher'")
      .get() as { total: number }
    expect(teachers.total).toBe(1)
  })
})

describe('demo data refuses to land on real work', () => {
  it('will not seed a database that already holds a course', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'testsys-demo-busy-'))
    const busy = buildApp({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(otherDir, 'test.db'),
      webRoot: null,
    })
    try {
      const teacher = findUserByUsername(busy.database.raw, 'teacher')
      busy.database.raw
        .prepare(
          'INSERT INTO courses (id, owner_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('c1', teacher!.id, 'Somebody’s real course', '', new Date().toISOString(), new Date().toISOString())

      const result = seedDemo(busy.database.raw, { uploadsDir: join(otherDir, 'uploads') })
      expect(result.seeded).toBe(false)
      expect(result.reason).toContain('already holds')
    } finally {
      busy.server.close()
      busy.database.close()
      rmSync(otherDir, { recursive: true, force: true })
    }
  })
})

/** The one course the demo made, for the tests that need its id. */
function lastCourseId(target: TestingApp): string {
  const row = target.database.raw
    .prepare('SELECT id FROM courses ORDER BY created_at DESC LIMIT 1')
    .get() as { id: string }
  return row.id
}

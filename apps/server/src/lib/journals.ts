import type { DatabaseSync } from 'node:sqlite'

/**
 * The journal: students down the side, tests across the top, one cell per pair.
 *
 * It is the table a teacher actually wants before a lesson rather than after it -
 * "who has not done this, and who did it badly" - so a cell is a *last* attempt
 * rather than a best one. A best would be the flattering number, and the one
 * that hides a student who guessed once and never came back.
 *
 * A student who has never attempted a test has a cell, and the cell is empty.
 * They are on the roster, and leaving them out would make the table say they do
 * not exist. An empty cell and a zero are different facts: the first is "no
 * attempt", the second is "attempted and scored nothing".
 */
export interface JournalCell {
  /** The student's last percent, or null when they have never attempted it. */
  percent: number | null
  /** How many times they submitted it. */
  attempts: number
  lastSubmittedAt: string | null
  /**
   * The run the last attempt was made in, or null when there is none.
   *
   * The cell is a number, and a teacher who wants to know *why* it is what it
   * is has to be able to open the attempt behind it - the same detail screen
   * the run's own board opens - so the cell carries the way there.
   */
  sessionId: string | null
}

export interface JournalStudent {
  userId: string
  username: string
  fullName: string
}

export interface Journal {
  /** What the table is about: a room or a course, named for the title. */
  scope: 'room' | 'course'
  title: string
  tests: Array<{ id: string; title: string }>
  students: JournalStudent[]
  /** One row of cells per student, in the same order as `students`. */
  cells: JournalCell[][]
}

interface CellRaw {
  user_id: string
  test_id: string
  attempts: number
  last_percent: number | null
  last_submitted_at: string | null
  last_session_id: string | null
}

/**
 * The attempts of a set of tests by a set of students, last one per pair.
 *
 * `ROW_NUMBER` picks the latest submission per (student, test) rather than an
 * aggregate over all of them: the cell is "where this student ended up on this
 * test", which is what a journal column means, and `MAX(percent)` would be a
 * different and more flattering thing.
 */
function cellsFor(
  db: DatabaseSync,
  testIds: string[],
  studentIds: string[],
): Map<string, Map<string, JournalCell>> {
  if (testIds.length === 0 || studentIds.length === 0) return new Map()
  const placeholders = testIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `WITH attempts AS (
         SELECT p.user_id, s.test_id, p.percent, p.submitted_at, s.id AS session_id,
                ROW_NUMBER() OVER (
                  PARTITION BY p.user_id, s.test_id ORDER BY p.submitted_at DESC
                ) AS rn
           FROM participations p
           JOIN live_sessions s ON s.id = p.session_id
          WHERE s.test_id IN (${placeholders}) AND p.status != 'joined'
       )
       SELECT user_id, test_id,
              COUNT(*) AS attempts,
              MAX(CASE WHEN rn = 1 THEN percent END)        AS last_percent,
              MAX(CASE WHEN rn = 1 THEN submitted_at END)   AS last_submitted_at,
              MAX(CASE WHEN rn = 1 THEN session_id END)     AS last_session_id
         FROM attempts
        GROUP BY user_id, test_id`,
    )
    .all(...testIds) as unknown as CellRaw[]

  const byStudent = new Map<string, Map<string, JournalCell>>()
  for (const row of rows) {
    if (!byStudent.has(row.user_id)) byStudent.set(row.user_id, new Map())
    byStudent.get(row.user_id)!.set(row.test_id, {
      percent: row.last_percent,
      attempts: row.attempts,
      lastSubmittedAt: row.last_submitted_at,
      sessionId: row.last_session_id,
    })
  }
  return byStudent
}

/** Fills a grid for any roster, keeping the given order in both directions. */
function buildJournal(
  db: DatabaseSync,
  scope: 'room' | 'course',
  title: string,
  tests: Array<{ id: string; title: string }>,
  roster: JournalStudent[],
): Journal {
  const byStudent = cellsFor(
    db,
    tests.map((test) => test.id),
    roster.map((student) => student.userId),
  )
  const cells = roster.map((student) =>
    tests.map((test) => {
      const found = byStudent.get(student.userId)?.get(test.id)
      return (
        found ?? {
          percent: null,
          attempts: 0,
          lastSubmittedAt: null,
          sessionId: null,
        }
      )
    }),
  )
  return { scope, title, tests, students: roster, cells }
}

/**
 * A room's journal.
 *
 * The tests are the ones the room has actually been run: a room's courses hold
 * tests that have not been used in it yet, and a column of empty cells for every
 * one of those teaches nothing. A run created before the room was picked (6.1
 * made `room_id` nullable, and an older run has none) belongs to the room the
 * test was written for, so it counts too.
 */
export function roomJournal(db: DatabaseSync, roomId: string, title: string): Journal {
  const tests = db
    .prepare(
      `SELECT DISTINCT t.id, t.title
         FROM live_sessions s
         JOIN tests t ON t.id = s.test_id
        WHERE s.room_id = ?
           OR (s.room_id IS NULL AND EXISTS (
                 SELECT 1
                   FROM course_tests ct
                   JOIN course_rooms cr ON cr.course_id = ct.course_id
                  WHERE ct.test_id = s.test_id AND cr.room_id = ?
              ))
        ORDER BY t.title ASC`,
    )
    .all(roomId, roomId) as unknown as Array<{ id: string; title: string }>

  const roster = db
    .prepare(
      `SELECT u.id AS userId, u.username, u.full_name AS fullName
         FROM room_members m JOIN users u ON u.id = m.user_id
        WHERE m.room_id = ?
        ORDER BY u.full_name ASC`,
    )
    .all(roomId) as unknown as JournalStudent[]

  return buildJournal(db, 'room', title, tests, roster)
}

/**
 * A course's journal.
 *
 * The tests here are the course's tests whether they have been run or not: a
 * course is a plan, and a planned test that nobody has done is exactly the cell
 * a teacher wants to see empty before the next lesson.
 */
export function courseJournal(db: DatabaseSync, courseId: string, title: string): Journal {
  const tests = db
    .prepare(
      `SELECT t.id, t.title
         FROM course_tests ct JOIN tests t ON t.id = ct.test_id
        WHERE ct.course_id = ?
        ORDER BY t.title ASC`,
    )
    .all(courseId) as unknown as Array<{ id: string; title: string }>

  const roster = db
    .prepare(
      `SELECT u.id AS userId, u.username, u.full_name AS fullName
         FROM course_enrollments e JOIN users u ON u.id = e.user_id
        WHERE e.course_id = ?
        ORDER BY u.full_name ASC`,
    )
    .all(courseId) as unknown as JournalStudent[]

  return buildJournal(db, 'course', title, tests, roster)
}

/** One journal as CSV: a name column, then one column per test. */
export function journalCsv(journal: Journal): string {
  const field = (value: string | number | null): string => {
    const text = value === null ? '' : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = [
    'Student',
    'Username',
    ...journal.tests.map((test) => test.title),
  ].join(',')
  const rows = journal.students.map((student, row) =>
    [
      field(student.fullName),
      field(student.username),
      ...journal.cells[row]!.map((cell) => field(cell.percent === null ? null : `${cell.percent}%`)),
    ].join(','),
  )
  return [header, ...rows].join('\r\n')
}

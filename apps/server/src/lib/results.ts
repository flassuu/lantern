import type { DatabaseSync } from 'node:sqlite'
import type { QuestionType } from './tests'

/** One row of the grade journal: a student's record for one test. */
export interface JournalRow {
  userId: string
  username: string
  fullName: string
  attempts: number
  bestPercent: number
  lastPercent: number
  lastPassed: boolean | null
  averagePercent: number
  lastSubmittedAt: string | null
}

/** How a class did on one question - the "which question did we teach badly" view. */
export interface QuestionStat {
  questionId: string
  body: string
  type: QuestionType
  points: number
  answers: number
  correct: number
  percent: number
}

export interface TestResults {
  students: number
  submissions: number
  averagePercent: number
  passRate: number | null
  journal: JournalRow[]
  questions: QuestionStat[]
}

interface JournalRaw {
  user_id: string
  username: string
  full_name: string
  attempts: number
  best_percent: number
  last_percent: number
  last_passed: number | null
  average_percent: number
  last_submitted_at: string | null
}

interface QuestionStatRaw {
  question_id: string
  body: string
  type: QuestionType
  points: number
  answers: number
  correct: number
  avg_ms: number | null
}

/**
 * The grade journal for one test, aggregated over every session it was run in.
 * Attempts still in progress are ignored; a test with a pass mark also reports
 * the pass rate, otherwise that stays null rather than reading as 0%.
 */
export function testResults(db: DatabaseSync, testId: string): TestResults {
  const journal = db
    .prepare(
      `WITH attempts AS (
         SELECT p.user_id, p.percent, p.passed, p.submitted_at,
                ROW_NUMBER() OVER (PARTITION BY p.user_id ORDER BY p.submitted_at DESC) AS rn
           FROM participations p
           JOIN live_sessions s ON s.id = p.session_id
          WHERE s.test_id = ? AND p.status != 'joined'
       )
       SELECT u.id AS user_id, u.username, u.full_name,
              COUNT(*)                AS attempts,
              MAX(a.percent)          AS best_percent,
              MAX(CASE WHEN a.rn = 1 THEN a.percent END) AS last_percent,
              MAX(CASE WHEN a.rn = 1 THEN a.passed END)  AS last_passed,
              AVG(a.percent)          AS average_percent,
              MAX(CASE WHEN a.rn = 1 THEN a.submitted_at END) AS last_submitted_at
         FROM attempts a
         JOIN users u ON u.id = a.user_id
        GROUP BY u.id
        ORDER BY last_percent DESC, u.full_name ASC`,
    )
    .all(testId) as unknown as JournalRaw[]

  const questionStats = db
    .prepare(
      `SELECT q.id AS question_id, q.body, q.type, q.points,
              COUNT(pa.id)          AS answers,
              COALESCE(SUM(pa.is_correct), 0) AS correct,
              AVG(pa.time_ms)      AS avg_ms
         FROM questions q
         LEFT JOIN participation_answers pa ON pa.question_id = q.id
        WHERE q.test_id = ?
        GROUP BY q.id
        ORDER BY q.position ASC`,
    )
    .all(testId) as unknown as QuestionStatRaw[]

  const rows: JournalRow[] = journal.map((row) => ({
    userId: row.user_id,
    username: row.username,
    fullName: row.full_name,
    attempts: row.attempts,
    bestPercent: row.best_percent,
    lastPercent: row.last_percent,
    lastPassed: row.last_passed === null ? null : row.last_passed === 1,
    averagePercent: Math.round(row.average_percent),
    lastSubmittedAt: row.last_submitted_at,
  }))

  const questions: QuestionStat[] = questionStats.map((row) => ({
    questionId: row.question_id,
    body: row.body,
    type: row.type,
    points: row.points,
    answers: row.answers,
    correct: row.correct,
    percent: row.answers > 0 ? Math.round((row.correct / row.answers) * 100) : 0,
    averageMs: row.avg_ms === null ? null : Math.round(row.avg_ms),
  }))

  const submissions = rows.reduce((sum, row) => sum + row.attempts, 0)
  const weighted = rows.reduce((sum, row) => sum + row.averagePercent * row.attempts, 0)

  // Both class figures are per student, judged on their last attempt - a
  // student who improved since the first try should not be counted as a fail.
  // passRate stays null when the test has no pass mark, rather than reading 0%.
  const judged = rows.filter((row) => row.lastPassed !== null)
  const passed = judged.filter((row) => row.lastPassed === true).length

  return {
    students: rows.length,
    submissions,
    averagePercent: submissions > 0 ? Math.round(weighted / submissions) : 0,
    passRate: judged.length > 0 ? Math.round((passed / judged.length) * 100) : null,
    journal: rows,
    questions,
  }
}

/** Escapes one CSV field: quotes doubled, wrapped when it contains a comma or quote. */
function csvField(value: string | number | null): string {
  if (value === null) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export interface SessionReportRow {
  fullName: string
  username: string
  status: string
  score: number | null
  maxScore: number | null
  percent: number | null
  passed: number | null
  submittedAt: string | null
}

export interface SessionReport {
  title: string
  joinCode: string
  status: string
  startedAt: string
  finishedAt: string | null
  passMark: string
  rows: SessionReportRow[]
}

/**
 * Everything an export needs, read once so the three formats cannot drift.
 *
 * The rows are ordered by name, which is how a teacher reads a class list and
 * therefore how every format presents it.
 */
export function sessionReport(db: DatabaseSync, sessionId: string, title: string): SessionReport {
  const session = db
    .prepare(
      'SELECT join_code, status, started_at, finished_at, passing_percent FROM live_sessions WHERE id = ?',
    )
    .get(sessionId) as
    | {
        join_code: string
        status: string
        started_at: string
        finished_at: string | null
        passing_percent: number | null
      }
    | undefined
  const rows = db
    .prepare(
      `SELECT u.username, u.full_name, p.status, p.score, p.max_score, p.percent, p.passed, p.submitted_at
         FROM participations p
         JOIN users u ON u.id = p.user_id
        WHERE p.session_id = ?
        ORDER BY u.full_name ASC, u.username ASC`,
    )
    .all(sessionId) as unknown as Array<{
    username: string
    full_name: string
    status: string
    score: number | null
    max_score: number | null
    percent: number | null
    passed: number | null
    submitted_at: string | null
  }>

  return {
    title,
    joinCode: session?.join_code ?? '',
    status: session?.status ?? '',
    startedAt: session?.started_at ?? '',
    finishedAt: session?.finished_at ?? null,
    passMark:
      session?.passing_percent === null || session?.passing_percent === undefined
        ? ''
        : `${session.passing_percent}%`,
    rows: rows.map((row) => ({
      fullName: row.full_name,
      username: row.username,
      status: row.status,
      score: row.score,
      maxScore: row.max_score,
      percent: row.percent,
      passed: row.passed,
      submittedAt: row.submitted_at,
    })),
  }
}

function passedText(passed: number | null): string {
  return passed === null ? 'n/a' : passed === 1 ? 'yes' : 'no'
}

/**
 * The spreadsheet form: a header block with the run, then one row per student.
 * Spreadsheet apps open the BOM'd UTF-8 happily, so non-ASCII names survive.
 */
export function sessionCsv(report: SessionReport): string {
  const lines: string[][] = [
    ['Test', report.title],
    ['Join code', report.joinCode],
    ['Status', report.status],
    ['Started', report.startedAt],
    ['Finished', report.finishedAt ?? ''],
    ['Pass mark', report.passMark],
    [],
    ['Student', 'Username', 'Status', 'Score', 'Max', 'Percent', 'Passed', 'Submitted at'],
  ]
  for (const row of report.rows) {
    lines.push([
      row.fullName,
      row.username,
      row.status,
      String(row.score ?? ''),
      String(row.maxScore ?? ''),
      row.percent === null ? '' : `${row.percent}%`,
      passedText(row.passed),
      row.submittedAt ?? '',
    ])
  }
  const csv = lines.map((line) => line.map(csvField).join(',')).join('\r\n')
  // BOM so Excel reads UTF-8 instead of guessing a code page.
  return `\uFEFF${csv}\r\n`
}

/** For reading rather than opening: the same report, lined up in plain text. */
export function sessionTxt(report: SessionReport): string {
  const columns = ['Student', 'Status', 'Score', 'Percent', 'Passed']
  const cells = report.rows.map((row) => [
    row.fullName,
    row.status,
    row.score === null ? '' : `${row.score}/${row.maxScore ?? ''}`,
    row.percent === null ? '' : `${row.percent}%`,
    passedText(row.passed),
  ])
  const widths = columns.map((label, index) =>
    Math.max(label.length, ...cells.map((row) => (row[index] ?? '').length)),
  )
  const line = (row: string[]): string =>
    row
      .map((value, index) => (value ?? '').padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd()
  return [
    `Test: ${report.title}`,
    `Join code: ${report.joinCode}`,
    `Status: ${report.status}`,
    `Started: ${report.startedAt}`,
    `Finished: ${report.finishedAt ?? ''}`,
    `Pass mark: ${report.passMark}`,
    '',
    line(columns),
    ...cells.map(line),
    '',
  ].join('\n')
}

export type ExportFormat = 'csv' | 'txt'

export interface SessionExport {
  filename: string
  contentType: string
  body: string | Uint8Array
}

/** One session in the format the teacher asked for. */
export function sessionExport(
  db: DatabaseSync,
  sessionId: string,
  title: string,
  format: ExportFormat,
): SessionExport {
  const report = sessionReport(db, sessionId, title)
  const base = `session-${report.joinCode === '' ? sessionId : report.joinCode}`
  if (format === 'txt') {
    return {
      filename: `${base}.txt`,
      contentType: 'text/plain; charset=utf-8',
      body: `\uFEFF${sessionTxt(report)}`,
    }
  }
  return {
    filename: `${base}.csv`,
    contentType: 'text/csv; charset=utf-8',
    body: sessionCsv(report),
  }
}

export interface SessionCsv {
  filename: string
  csv: string
}

/** The CSV alone, for the route that has always served it. */
export function sessionResultsCsv(db: DatabaseSync, sessionId: string, title: string): SessionCsv {
  const report = sessionReport(db, sessionId, title)
  return {
    filename: `session-${report.joinCode === '' ? sessionId : report.joinCode}.csv`,
    csv: sessionCsv(report),
  }
}

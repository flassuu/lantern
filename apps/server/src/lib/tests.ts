import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from './db'
import type { Tag } from './tags'

export type QuestionType =
  | 'single_choice'
  | 'multiple_choice'
  | 'true_false'
  | 'short_answer'
  | 'matching'

export const QUESTION_TYPES: QuestionType[] = [
  'single_choice',
  'multiple_choice',
  'true_false',
  'short_answer',
  'matching',
]

export interface QuestionInput {
  type: QuestionType
  body: string
  payload: Record<string, unknown>
  points: number
  position: number
}

export interface QuestionRow {
  id: string
  test_id: string
  type: QuestionType
  body: string
  payload: string
  points: number
  position: number
}

export interface Question {
  id: string
  type: QuestionType
  body: string
  payload: Record<string, unknown>
  points: number
  position: number
}

export interface TestRow {
  id: string
  owner_id: string
  title: string
  description: string
  time_limit_sec: number | null
  passing_percent: number | null
  /** The group this test was written for, or null when it is not tied to one. */
  room_id: string | null
  created_at: string
  updated_at: string
}

export interface Test {
  id: string
  ownerId: string
  title: string
  description: string
  timeLimitSec: number | null
  passingPercent: number | null
  roomId: string | null
  questionCount: number
  createdAt: string
  updatedAt: string
}

export interface TestWithQuestions extends Omit<Test, 'questionCount'> {
  questions: Question[]
  /** The teacher's own labels; a test carries them wherever it goes. */
  tags: Tag[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  )
}

/** Validates the type-specific payload; returns an error message or null. */
export function validateQuestionPayload(
  type: QuestionType,
  payload: Record<string, unknown>,
): string | null {
  switch (type) {
    case 'single_choice':
    case 'multiple_choice': {
      const options = payload.options
      if (!Array.isArray(options) || options.length < 2) {
        return 'payload.options must contain at least 2 options'
      }
      if (
        !options.every(
          (option) =>
            isRecord(option) &&
            typeof option.key === 'string' &&
            option.key.trim().length > 0 &&
            typeof option.text === 'string' &&
            option.text.trim().length > 0,
        )
      ) {
        return 'payload.options must be [{ key, text }] with non-empty values'
      }
      const keys = new Set(
        (options as Array<{ key: string }>).map((option) => option.key.trim()),
      )
      if (keys.size !== options.length) return 'option keys must be unique'

      if (type === 'single_choice') {
        const correct = payload.correct
        if (typeof correct !== 'string' || !keys.has(correct.trim())) {
          return 'payload.correct must reference one option key'
        }
      } else {
        const correct = payload.correct
        if (
          !Array.isArray(correct) ||
          correct.length < 1 ||
          !correct.every((key) => typeof key === 'string' && keys.has(key.trim()))
        ) {
          return 'payload.correct must contain at least one option key'
        }
      }
      return null
    }

    case 'true_false':
      if (typeof payload.correct !== 'boolean') {
        return 'payload.correct must be a boolean'
      }
      return null

    case 'short_answer':
      if (!isStringArray(payload.accepted)) {
        return 'payload.accepted must be a non-empty array of strings'
      }
      return null

    case 'matching': {
      const pairs = payload.pairs
      if (!Array.isArray(pairs) || pairs.length < 2) {
        return 'payload.pairs must contain at least 2 pairs'
      }
      if (
        !pairs.every(
          (pair) =>
            isRecord(pair) &&
            typeof pair.left === 'string' &&
            pair.left.trim().length > 0 &&
            typeof pair.right === 'string' &&
            pair.right.trim().length > 0,
        )
      ) {
        return 'payload.pairs must be [{ left, right }] with non-empty values'
      }
      return null
    }
  }
}

/** Validates a question shape (used for both create and replace). */
export function validateQuestion(question: QuestionInput): string | null {
  if (!QUESTION_TYPES.includes(question.type)) {
    return 'unsupported question type'
  }
  if (!question.body || question.body.trim().length === 0) {
    return 'question body must not be empty'
  }
  if (!Number.isInteger(question.points) || question.points < 1) {
    return 'question points must be a positive integer'
  }
  if (!Number.isInteger(question.position) || question.position < 0) {
    return 'question position must be a non-negative integer'
  }
  if (!isRecord(question.payload)) {
    return 'question payload must be an object'
  }
  return validateQuestionPayload(question.type, question.payload)
}

export function toQuestion(row: QuestionRow): Question {
  return {
    id: row.id,
    type: row.type,
    body: row.body,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    points: row.points,
    position: row.position,
  }
}

export function toTest(row: TestRow, questionCount: number): Test {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description,
    timeLimitSec: row.time_limit_sec,
    passingPercent: row.passing_percent,
    roomId: row.room_id,
    questionCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function findTestRow(db: DatabaseSync, id: string): TestRow | null {
  const row = db.prepare('SELECT * FROM tests WHERE id = ?').get(id)
  return (row as TestRow | undefined) ?? null
}

/** Which group a test belongs to, or none. Never changes the test itself. */
export function setTestRoom(db: DatabaseSync, id: string, roomId: string | null): void {
  db.prepare('UPDATE tests SET room_id = ?, updated_at = ? WHERE id = ?').run(roomId, new Date().toISOString(), id)
}

interface TestWithCountRow extends TestRow {
  question_count: number
}

export function listTestRows(
  db: DatabaseSync,
  ownerId: string,
  isAdmin: boolean,
): Array<{ test: Test; full: TestWithCountRow }> {
  const sql = isAdmin
    ? `SELECT t.*, (SELECT COUNT(*) FROM questions q WHERE q.test_id = t.id) AS question_count
       FROM tests t ORDER BY t.created_at DESC`
    : `SELECT t.*, (SELECT COUNT(*) FROM questions q WHERE q.test_id = t.id) AS question_count
       FROM tests t WHERE t.owner_id = ? ORDER BY t.created_at DESC`
  const rows = (isAdmin
    ? db.prepare(sql).all()
    : db.prepare(sql).all(ownerId)) as unknown as TestWithCountRow[]
  return rows.map((full) => ({ test: toTest(full, full.question_count), full }))
}

export function listQuestions(db: DatabaseSync, testId: string): Question[] {
  const rows = db
    .prepare('SELECT * FROM questions WHERE test_id = ? ORDER BY position ASC')
    .all(testId) as unknown as QuestionRow[]
  return rows.map(toQuestion)
}

/**
 * Replaces a test's questions in one transaction: deletes the old set and
 * inserts the new one at its declared positions.
 */
export function replaceQuestions(
  db: DatabaseSync,
  testId: string,
  questions: QuestionInput[],
): void {
  db.prepare('DELETE FROM questions WHERE test_id = ?').run(testId)
  for (const question of questions) {
    db.prepare(
      `INSERT INTO questions (id, test_id, type, body, payload, points, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      testId,
      question.type,
      question.body.trim(),
      JSON.stringify(question.payload),
      question.points,
      question.position,
    )
  }
}

export function createTest(
  db: DatabaseSync,
  ownerId: string,
  input: { title: string; description: string; timeLimitSec?: number | null; passingPercent?: number | null },
  questions: QuestionInput[],
): TestRow {
  const id = randomUUID()
  const now = nowIso()
  db.prepare(
    `INSERT INTO tests (id, owner_id, title, description, time_limit_sec, passing_percent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ownerId,
    input.title.trim(),
    input.description.trim(),
    input.timeLimitSec ?? null,
    input.passingPercent ?? null,
    now,
    now,
  )
  replaceQuestions(db, id, questions)
  return findTestRow(db, id) as TestRow
}

export function updateTest(
  db: DatabaseSync,
  test: TestRow,
  input: { title: string; description: string; timeLimitSec?: number | null; passingPercent?: number | null },
  questions: QuestionInput[],
): TestRow {
  db.prepare(
    `UPDATE tests
     SET title = ?, description = ?, time_limit_sec = ?, passing_percent = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.title.trim(),
    input.description.trim(),
    input.timeLimitSec ?? null,
    input.passingPercent ?? null,
    nowIso(),
    test.id,
  )
  replaceQuestions(db, test.id, questions)
  return findTestRow(db, test.id) as TestRow
}

export function deleteTest(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM tests WHERE id = ?').run(id)
}
/**
 * The exchange format: one test with its questions, no ids, no owner, no
 * timestamps. It is what an export writes and what an import reads, so a file
 * can be handed to another teacher without carrying anything about this system.
 */
export interface TestExchange {
  format: 'knowledge-testing.test'
  version: 1
  title: string
  description: string
  timeLimitSec: number | null
  passingPercent: number | null
  questions: QuestionInput[]
}

/** Builds the exchange document for a stored test, answer keys included. */
export function exportTest(db: DatabaseSync, test: TestRow): TestExchange {
  return {
    format: 'knowledge-testing.test',
    version: 1,
    title: test.title,
    description: test.description,
    timeLimitSec: test.time_limit_sec,
    passingPercent: test.passing_percent,
    questions: listQuestions(db, test.id).map((question) => ({
      type: question.type,
      body: question.body,
      payload: question.payload,
      points: question.points,
      position: question.position,
    })),
  }
}

export function validateExchange(raw: unknown): { value?: TestExchange; error?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'the file must contain one test object' }
  }
  const document = raw as Record<string, unknown>
  if (document.format !== 'knowledge-testing.test') {
    return { error: 'unrecognised format: not a Knowledge Testing test file' }
  }
  if (document.version !== 1) {
    return { error: 'unsupported file version' }
  }
  if (typeof document.title !== 'string' || document.title.trim() === '') {
    return { error: 'the test needs a title' }
  }
  if (!Array.isArray(document.questions) || document.questions.length === 0) {
    return { error: 'the test needs at least one question' }
  }

  const questions: QuestionInput[] = []
  for (const [index, entry] of document.questions.entries()) {
    const candidate = entry as Record<string, unknown>
    const question: QuestionInput = {
      type: candidate.type as QuestionType,
      body: typeof candidate.body === 'string' ? candidate.body : '',
      payload:
        typeof candidate.payload === 'object' && candidate.payload !== null
          ? (candidate.payload as Record<string, unknown>)
          : {},
      points: typeof candidate.points === 'number' ? candidate.points : 1,
      position: index,
    }
    const problem = validateQuestion(question)
    if (problem) return { error: `question ${index + 1}: ${problem}` }
    questions.push(question)
  }

  const timeLimitSec = document.timeLimitSec
  const passingPercent = document.passingPercent
  return {
    value: {
      format: 'knowledge-testing.test',
      version: 1,
      title: document.title,
      description: typeof document.description === 'string' ? document.description : '',
      timeLimitSec: typeof timeLimitSec === 'number' ? timeLimitSec : null,
      passingPercent: typeof passingPercent === 'number' ? passingPercent : null,
      questions,
    },
  }
}

/**
 * Copies a test into a new one the caller owns. Question ids are new, so the
 * copy can be edited without touching the original - which is the whole point
 * of duplicating rather than retyping.
 */
export function duplicateTest(
  db: DatabaseSync,
  ownerId: string,
  source: TestRow,
): TestRow {
  return createTest(
    db,
    ownerId,
    {
      title: `${source.title} (copy)`,
      description: source.description,
      timeLimitSec: source.time_limit_sec,
      passingPercent: source.passing_percent,
    },
    listQuestions(db, source.id).map((question) => ({
      type: question.type,
      body: question.body,
      payload: question.payload,
      points: question.points,
      position: question.position,
    })),
  )
}

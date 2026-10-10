import { ApiError, apiFetch, downloadFile } from './client'
import { normalizeTest } from './normalize'
import type { TestDetails, TestInput, TestSummary } from './types'

/** Teacher/admin: own tests (admin sees all). */
export async function listTests(): Promise<TestSummary[]> {
  const result = await apiFetch<{ tests: TestSummary[] }>('/api/tests')
  return result.tests.map(normalizeTest)
}

export async function getTest(id: string): Promise<TestDetails> {
  const result = await apiFetch<{ test: TestDetails }>(`/api/tests/${id}`)
  return normalizeTest(result.test)
}

export async function createTest(input: TestInput): Promise<TestDetails> {
  const result = await apiFetch<{ test: TestDetails }>('/api/tests', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return normalizeTest(result.test)
}

/** Replaces the test and all of its questions. */
export async function updateTest(id: string, input: TestInput): Promise<TestDetails> {
  const result = await apiFetch<{ test: TestDetails }>(`/api/tests/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
  return normalizeTest(result.test)
}

export async function deleteTest(id: string): Promise<void> {
  await apiFetch<void>(`/api/tests/${id}`, { method: 'DELETE' })
}

/** Copies a test under the caller's name; question ids are new. */
export async function duplicateTest(id: string): Promise<TestDetails> {
  const result = await apiFetch<{ test: TestDetails }>(`/api/tests/${id}/duplicate`, {
    method: 'POST',
  })
  return normalizeTest(result.test)
}

/** A filename both the browser and a person can live with. */
function fileSafe(title: string): string {
  const slug = title
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  return slug || 'test'
}

/**
 * Saves the test as a shareable file. Fetched rather than linked: the API
 * authenticates with a header, and an <a href> would arrive unauthenticated.
 */
export async function exportTestFile(id: string, title: string): Promise<void> {
  await downloadFile(`/api/tests/${id}/export`, `${fileSafe(title)}.json`)
}

/** Reads a test file and creates the test for the signed-in teacher. */
export async function importTestFile(file: File): Promise<TestDetails> {
  const text = await file.text()
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw new ApiError(0, 'VALIDATION', 'not a JSON file')
  }
  const result = await apiFetch<{ test: TestDetails }>('/api/tests/import', {
    method: 'POST',
    body: JSON.stringify(document),
  })
  return normalizeTest(result.test)
}

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

/** How the class did on one question. */
export interface QuestionStat {
  questionId: string
  body: string
  type: string
  points: number
  answers: number
  correct: number
  percent: number
}

export interface TestResults {
  test: { id: string; title: string; passingPercent: number | null }
  students: number
  submissions: number
  averagePercent: number
  passRate: number | null
  journal: JournalRow[]
  questions: QuestionStat[]
}

/** Teacher only: the grade journal and per-question difficulty for a test. */
export async function getTestResults(testId: string): Promise<TestResults> {
  return apiFetch<TestResults>(`/api/tests/${testId}/results`)
}

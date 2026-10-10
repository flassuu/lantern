/**
 * What a teacher can decide about a run, beyond the questions themselves.
 *
 * Stored as JSON on the test (its defaults) and copied onto the session when it
 * is created (the snapshot), so editing the test afterwards cannot change a run
 * that is already in the lobby or under way - the same reason the time limit and
 * pass mark are snapshotted.
 *
 * Every field defaults to what the app did before there were settings at all:
 * nothing shuffled, answers revealed after submitting, results shown straight
 * away, the whole paper on one page, and going back allowed.
 */
export interface TestSettings {
  shuffleQuestions: boolean
  shuffleOptions: boolean
  showCorrectAnswers: 'never' | 'after_submit'
  releaseResults: 'immediate' | 'teacher'
  questionsPerPage: 'all' | 'one'
  allowBack: boolean
}

export const DEFAULT_SETTINGS: TestSettings = {
  shuffleQuestions: false,
  shuffleOptions: false,
  showCorrectAnswers: 'after_submit',
  releaseResults: 'immediate',
  questionsPerPage: 'all',
  allowBack: true,
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/**
 * Settings from the database, made safe.
 *
 * Anything unknown falls back to the default rather than throwing: a settings
 * blob is data, and a bad one should mean "the usual behaviour", not a session
 * that cannot be opened.
 */
export function parseSettings(raw: string | null | undefined): TestSettings {
  if (!raw) return { ...DEFAULT_SETTINGS }
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS }
  const record = value as Record<string, unknown>
  return {
    shuffleQuestions: bool(record.shuffleQuestions, DEFAULT_SETTINGS.shuffleQuestions),
    shuffleOptions: bool(record.shuffleOptions, DEFAULT_SETTINGS.shuffleOptions),
    showCorrectAnswers: oneOf(
      record.showCorrectAnswers,
      ['never', 'after_submit'],
      DEFAULT_SETTINGS.showCorrectAnswers,
    ),
    releaseResults: oneOf(
      record.releaseResults,
      ['immediate', 'teacher'],
      DEFAULT_SETTINGS.releaseResults,
    ),
    questionsPerPage: oneOf(
      record.questionsPerPage,
      ['all', 'one'],
      DEFAULT_SETTINGS.questionsPerPage,
    ),
    allowBack: bool(record.allowBack, DEFAULT_SETTINGS.allowBack),
  }
}

/** Settings as they go into the database; `null` means "the defaults". */
export function serializeSettings(settings: TestSettings | null | undefined): string | null {
  return settings ? JSON.stringify(settings) : null
}

/**
 * The JSON-schema fragment these settings parse from, shared by the test editor
 * and the session's start/edit body so the two cannot drift apart.
 */
export const SETTINGS_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // Every field is optional: a caller may send the two it changed, and the rest
  // fall back to the defaults.
  properties: {
    shuffleQuestions: { type: 'boolean' },
    shuffleOptions: { type: 'boolean' },
    showCorrectAnswers: { type: 'string', enum: ['never', 'after_submit'] },
    releaseResults: { type: 'string', enum: ['immediate', 'teacher'] },
    questionsPerPage: { type: 'string', enum: ['all', 'one'] },
    allowBack: { type: 'boolean' },
  },
} as const

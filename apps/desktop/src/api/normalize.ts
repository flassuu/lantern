import type { Tag } from './types'

/**
 * Filling in the fields the client expects and an older server does not send.
 *
 * The room/tag release added `roomId`, `name` and `tags` to what tests, sessions
 * and courses carry. A server that has not been restarted since answers without
 * them, and a screen that reads `session.tags.length` dies on the undefined -
 * which does not blank one card. The throw aborts the render of the page the
 * card is on, so the whole workbench stops responding and the tab strip goes
 * dead with it, which is exactly how this was found: every tab looked like the
 * Live tab, because none of them could render.
 *
 * This is the one layer that knows it is talking to a server it does not
 * control, so it is where the coping belongs. Everything above can keep relying
 * on the declared types instead of remembering an optional chain.
 */
export function normalizeSession<
  T extends {
    name?: string | null
    roomId?: string | null
    tags?: Tag[] | null
    entryLocked?: boolean | null
    resultsReleased?: boolean | null
    pausedAt?: string | null
    settings?: Partial<TestSettings> | null
  },
>(session: T): T & {
  name: string | null
  roomId: string | null
  tags: Tag[]
  entryLocked: boolean
  resultsReleased: boolean
  pausedAt: string | null
  settings: TestSettings
} {
  return {
    ...session,
    name: session.name ?? null,
    roomId: session.roomId ?? null,
    tags: session.tags ?? [],
    entryLocked: session.entryLocked ?? false,
    resultsReleased: session.resultsReleased ?? false,
    pausedAt: session.pausedAt ?? null,
    settings: normalizeSettings(session.settings),
  }
}

/** A test as the client expects it; see `normalizeSession` for why. */
export function normalizeTest<
  T extends { roomId?: string | null; tags?: Tag[] | null; settings?: Partial<TestSettings> | null },
>(test: T): T & { roomId: string | null; tags: Tag[]; settings: TestSettings } {
  return {
    ...test,
    roomId: test.roomId ?? null,
    tags: test.tags ?? [],
    settings: normalizeSettings(test.settings),
  }
}

/** A course as the client expects it; see `normalizeSession` for why. */
export function normalizeCourse<
  T extends {
    tags?: Tag[] | null
    topics?: unknown[] | null
    announcements?: unknown[] | null
  },
>(course: T): T & { tags: Tag[]; topics: unknown[]; announcements: unknown[] } {
  return {
    ...course,
    tags: course.tags ?? [],
    // Lessons and announcements arrived in 6.7. A server that has not been
    // restarted since answers a course without them, and `course.topics.length`
    // on an undefined takes the whole course screen down with it - not one card,
    // the render. An empty list here means "this server has no lessons", which
    // is what it means.
    topics: course.topics ?? [],
    announcements: course.announcements ?? [],
  }
}

/**
 * What a teacher can decide about a run, beyond the questions.
 *
 * The test holds the defaults; a session snapshots them when it is created, so
 * editing the test later cannot change a run that is already under way.
 *
 * It lives here, next to the normalisers, for the same reason they do: this
 * module has no runtime imports, so a plain `node --test` can load it.
 */
export interface TestSettings {
  shuffleQuestions: boolean
  shuffleOptions: boolean
  showCorrectAnswers: 'never' | 'after_submit'
  releaseResults: 'immediate' | 'teacher'
  questionsPerPage: 'all' | 'one'
  allowBack: boolean
}

/** What the app did before there were settings: the safe reading of a blank blob. */
export const DEFAULT_SETTINGS: TestSettings = {
  shuffleQuestions: false,
  shuffleOptions: false,
  showCorrectAnswers: 'after_submit',
  releaseResults: 'immediate',
  questionsPerPage: 'all',
  allowBack: true,
}

/** Settings from the wire, made whole; a server older than the app sends none. */
export function normalizeSettings(raw: Partial<TestSettings> | null | undefined): TestSettings {
  if (!raw) return { ...DEFAULT_SETTINGS }
  return {
    shuffleQuestions: raw.shuffleQuestions ?? DEFAULT_SETTINGS.shuffleQuestions,
    shuffleOptions: raw.shuffleOptions ?? DEFAULT_SETTINGS.shuffleOptions,
    showCorrectAnswers: raw.showCorrectAnswers ?? DEFAULT_SETTINGS.showCorrectAnswers,
    releaseResults: raw.releaseResults ?? DEFAULT_SETTINGS.releaseResults,
    questionsPerPage: raw.questionsPerPage ?? DEFAULT_SETTINGS.questionsPerPage,
    allowBack: raw.allowBack ?? DEFAULT_SETTINGS.allowBack,
  }
}

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
  },
>(session: T): T & {
  name: string | null
  roomId: string | null
  tags: Tag[]
  entryLocked: boolean
} {
  return {
    ...session,
    name: session.name ?? null,
    roomId: session.roomId ?? null,
    tags: session.tags ?? [],
    entryLocked: session.entryLocked ?? false,
  }
}

/** A test as the client expects it; see `normalizeSession` for why. */
export function normalizeTest<T extends { roomId?: string | null; tags?: Tag[] | null }>(
  test: T,
): T & { roomId: string | null; tags: Tag[] } {
  return { ...test, roomId: test.roomId ?? null, tags: test.tags ?? [] }
}

/** A course as the client expects it; see `normalizeSession` for why. */
export function normalizeCourse<T extends { tags?: Tag[] | null }>(
  course: T,
): T & { tags: Tag[] } {
  return { ...course, tags: course.tags ?? [] }
}

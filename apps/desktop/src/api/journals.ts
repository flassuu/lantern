import { apiFetch, fetchBlob } from './client'
import type { Journal } from './types'

export type { Journal, JournalCell, JournalStudent } from './types'

/**
 * The journal of a room or a course.
 *
 * `scope` and `title` come back with it so one screen can serve both: a teacher
 * arriving from a room and one arriving from a course read the same table, and
 * the heading says which of the two they are looking at.
 */
export async function getRoomJournal(roomId: string): Promise<Journal> {
  const result = await apiFetch<{ journal: Journal }>(`/api/journals/rooms/${roomId}`)
  return result.journal
}

export async function getCourseJournal(courseId: string): Promise<Journal> {
  const result = await apiFetch<{ journal: Journal }>(`/api/journals/courses/${courseId}`)
  return result.journal
}

/**
 * The same table as a file.
 *
 * Fetched with the token and handed over as an object URL, the way a material
 * is: the API authenticates with a header, so a plain link would be turned away
 * at the door.
 */
export async function downloadJournalCsv(
  scope: 'room' | 'course',
  id: string,
  title: string,
): Promise<void> {
  const blob = await fetchBlob(`/api/journals/${scope}s/${id}?format=csv`)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${title || 'journal'}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

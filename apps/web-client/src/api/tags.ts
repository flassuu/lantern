import { apiFetch } from './client'
import type { Tag } from './types'

/** What kind of thing a label can be stuck to. */
export type TagEntity = 'test' | 'session' | 'course'

/** The signed-in teacher's own vocabulary. */
export async function listTags(): Promise<Tag[]> {
  const result = await apiFetch<{ tags: Tag[] }>('/api/tags')
  return result.tags
}

export async function createTag(name: string): Promise<Tag> {
  const result = await apiFetch<{ tag: Tag }>('/api/tags', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  return result.tag
}

export async function renameTag(id: string, name: string): Promise<Tag> {
  const result = await apiFetch<{ tag: Tag }>(`/api/tags/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
  return result.tag
}

export async function deleteTag(id: string): Promise<void> {
  await apiFetch<void>(`/api/tags/${id}`, { method: 'DELETE' })
}

/**
 * Puts these labels on that thing, and answers with what it ended up carrying.
 *
 * One call on purpose: names the teacher has not used before become tags, names
 * that are gone lose their link, and the caller writes the answer to its state
 * rather than to what it asked for — which is the only way the screen and the
 * server can disagree honestly.
 */
export async function setTags(
  entity: TagEntity,
  id: string,
  names: string[],
): Promise<Tag[]> {
  const result = await apiFetch<{ tags: Tag[] }>(`/api/tags/${entity}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ names }),
  })
  return result.tags
}
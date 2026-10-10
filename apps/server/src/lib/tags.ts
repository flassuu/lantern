import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from './db'

/**
 * Free labels a teacher puts on things.
 *
 * Deliberately only labels: what class something belongs to is a foreign key
 * (`room_id`), not a tag, because a room can be enrolled, revoked and joined -
 * a label cannot. What a tag is for is the softer question: "algebra", "photosynthesis",
 * "chapter 4" - the things a filter can offer as a choice.
 *
 * Tags are the teacher's own and carry no permissions of their own: attaching one
 * to an entity still needs permission on that entity, which is checked by the
 * routes and never here.
 */
export type TagEntity = 'test' | 'session' | 'course'

export const TAG_ENTITIES: TagEntity[] = ['test', 'session', 'course']

export interface Tag {
  id: string
  ownerId: string
  name: string
  createdAt: string
}

interface TagRow {
  id: string
  owner_id: string
  name: string
  created_at: string
}

function toTag(row: TagRow): Tag {
  return { id: row.id, ownerId: row.owner_id, name: row.name, createdAt: row.created_at }
}

export function listTags(db: DatabaseSync, ownerId: string): Tag[] {
  const rows = db
    .prepare('SELECT * FROM tags WHERE owner_id = ? ORDER BY lower(name)')
    .all(ownerId) as unknown as TagRow[]
  return rows.map(toTag)
}

export function findTagById(db: DatabaseSync, id: string): Tag | null {
  const row = db.prepare('SELECT * FROM tags WHERE id = ?').get(id)
  return (row as unknown as TagRow | undefined) ? toTag(row as unknown as TagRow) : null
}

/** Case-insensitive: "Algebra" and "algebra" are the same label, once. */
export function findTagByName(db: DatabaseSync, ownerId: string, name: string): Tag | null {
  const row = db.prepare('SELECT * FROM tags WHERE owner_id = ? AND lower(name) = lower(?)').get(
    ownerId,
    name.trim(),
  )
  return (row as unknown as TagRow | undefined) ? toTag(row as unknown as TagRow) : null
}

/**
 * Returns the tag with that name, making it if the teacher has not used it yet.
 * This is what makes tagging a thing a single operation on the client: type a
 * word, get a tag, no "create this first?" dialog.
 */
export function ensureTag(db: DatabaseSync, ownerId: string, rawName: string): Tag {
  const name = rawName.trim()
  const existing = findTagByName(db, ownerId, name)
  if (existing) return existing
  const id = randomUUID()
  db.prepare(
    'INSERT INTO tags (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, ownerId, name, nowIso())
  const created = findTagById(db, id)
  if (!created) throw new Error('tag insert failed')
  return created
}

export function renameTag(db: DatabaseSync, id: string, name: string): void {
  db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name.trim(), id)
}

export function deleteTag(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM tags WHERE id = ?').run(id)
}

export function listEntityTags(
  db: DatabaseSync,
  entityType: TagEntity,
  entityId: string,
): Tag[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM entity_tags e
         JOIN tags t ON t.id = e.tag_id
        WHERE e.entity_type = ? AND e.entity_id = ?
        ORDER BY lower(t.name)`,
    )
    .all(entityType, entityId) as unknown as TagRow[]
  return rows.map(toTag)
}

/**
 * Replaces an entity's labels with the given names, creating the ones that do not
 * exist yet and dropping the ones that were removed. Returns what it settled on,
 * so a caller can echo the real state back rather than what was asked for.
 */
export function setEntityTags(
  db: DatabaseSync,
  ownerId: string,
  entityType: TagEntity,
  entityId: string,
  names: string[],
): Tag[] {
  const wanted: Tag[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const trimmed = name.trim()
    if (trimmed === '') continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    wanted.push(ensureTag(db, ownerId, trimmed))
  }

  db.prepare('DELETE FROM entity_tags WHERE entity_type = ? AND entity_id = ?').run(
    entityType,
    entityId,
  )
  const link = db.prepare(
    `INSERT INTO entity_tags (id, tag_id, entity_type, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tag_id, entity_type, entity_id) DO NOTHING`,
  )
  for (const tag of wanted) {
    link.run(randomUUID(), tag.id, entityType, entityId, nowIso())
  }
  return wanted
}

/**
 * Labels for a whole list in one query.
 *
 * A test list or a session list renders one card per row and each card shows its
 * labels; asking per row would be a request per card, and the lists are exactly
 * where the labels are wanted.
 */
export function tagsByEntity(
  db: DatabaseSync,
  entityType: TagEntity,
  entityIds: string[],
): Map<string, Tag[]> {
  const result = new Map<string, Tag[]>()
  if (entityIds.length === 0) return result
  const placeholders = entityIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT e.entity_id, t.* FROM entity_tags e
         JOIN tags t ON t.id = e.tag_id
        WHERE e.entity_type = ? AND e.entity_id IN (${placeholders})
        ORDER BY lower(t.name)`,
    )
    .all(entityType, ...entityIds) as unknown as Array<TagRow & { entity_id: string }>
  for (const row of rows) {
    const list = result.get(row.entity_id) ?? []
    list.push(toTag(row))
    result.set(row.entity_id, list)
  }
  return result
}

/** The entities carrying a tag - the other half of a filter by tag. */
export function entityIdsWithTag(db: DatabaseSync, tagId: string, entityType: TagEntity): string[] {
  const rows = db
    .prepare('SELECT entity_id FROM entity_tags WHERE tag_id = ? AND entity_type = ?')
    .all(tagId, entityType) as Array<{ entity_id: string }>
  return rows.map((row) => row.entity_id)
}
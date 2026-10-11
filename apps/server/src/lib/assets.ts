import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { nowIso } from './db'

/**
 * An image a question points at.
 *
 * The bytes live on disk next to the database, the way a course material's do;
 * this row is the name on them. Keeping the row and the file apart is what lets
 * the server decide who may fetch an id: a student holding a paper may read the
 * pictures on it without becoming able to list anybody else's.
 */
export interface AssetRow {
  id: string
  owner_id: string
  title: string
  file_path: string
  mime_type: string
  size_bytes: number
  created_at: string
}

export interface Asset {
  id: string
  ownerId: string
  title: string
  mimeType: string
  sizeBytes: number
  createdAt: string
}

export interface AssetInput {
  title: string
  filePath: string
  mimeType: string
  sizeBytes: number
}

export function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  }
}

export function createAsset(
  db: DatabaseSync,
  ownerId: string,
  input: AssetInput,
): Asset {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO assets (id, owner_id, title, file_path, mime_type, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ownerId, input.title, input.filePath, input.mimeType, input.sizeBytes, nowIso())
  const row = findAssetRow(db, id)
  if (!row) throw new Error('asset row vanished after insert')
  return toAsset(row)
}

export function findAssetRow(db: DatabaseSync, id: string): AssetRow | null {
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as
    | AssetRow
    | undefined
  return row ?? null
}

export function listAssets(db: DatabaseSync, ownerId: string): Asset[] {
  return db
    .prepare('SELECT * FROM assets WHERE owner_id = ? ORDER BY created_at DESC')
    .all(ownerId)
    .map((row) => toAsset(row as unknown as AssetRow))
}

/** Deletes the row and returns the stored name, so the caller can unlink the file. */
export function deleteAsset(db: DatabaseSync, id: string, ownerId: string): string | null {
  const row = findAssetRow(db, id)
  if (!row || row.owner_id !== ownerId) return null
  db.prepare('DELETE FROM assets WHERE id = ?').run(id)
  return row.file_path
}

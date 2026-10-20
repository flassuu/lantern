import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { SCHEMA_VERSION } from './db'

/**
 * A gradebook in one file, and the two ways it can leave or enter the machine.
 *
 * A snapshot is written with `VACUUM INTO` rather than a file copy: a live
 * SQLite database with a WAL is not a database on disk, it is a database plus a
 * journal that holds the newest transactions, and copying one without the other
 * loses exactly the work a teacher is trying to save.
 *
 * A restore does not touch the open handle. The file is checked, parked next to
 * the database and applied by the next start, because replacing the file under
 * a running server is how a gradebook gets corrupted at the worst moment.
 */

/** Where an accepted restore waits for the next start. */
export const RESTORE_FILE = '.restore'
/** The database a restore replaced, kept until the next one. */
const REPLACED_SUFFIX = '.before-restore'
/** The folder a snapshot is kept in before a migration runs. */
const BACKUPS_DIR = 'backups'
const BACKUPS_KEEP = 7

const SQLITE_HEADER = 'SQLite format 3\u0000'
const HEADER_BYTES = 16

export type RestoreCheck =
  | { ok: true; schemaVersion: number }
  | {
      ok: false
      code: 'NOT_SQLITE' | 'NOT_LANTERN' | 'NEWER_SCHEMA' | 'CORRUPT'
      message: string
    }

export function pendingRestorePath(dataDir: string): string {
  return join(dataDir, RESTORE_FILE)
}

export function backupsDir(dataDir: string): string {
  return join(dataDir, BACKUPS_DIR)
}

/** A dated name, so two downloads never overwrite each other in a folder. */
export function backupFileName(prefix = 'lantern-backup', now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `${prefix}-${stamp}.db`
}

/** Writes a consistent copy of the open database to `target`. */
export function snapshotTo(db: DatabaseSync, target: string): void {
  // The path is ours, but a quote in it would end the literal and run SQL.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
}

/**
 * Keeps a copy of the database before a migration changes it.
 *
 * Only when a migration is actually pending: a copy on every launch would fill
 * the folder with seven identical files and teach nobody anything. Returns the
 * file it wrote, or null when there was nothing to do.
 */
export function snapshotOnUpgrade(
  dbPath: string,
  dir: string,
  keep = BACKUPS_KEEP,
): string | null {
  if (!existsSync(dbPath)) return null
  const db = new DatabaseSync(dbPath)
  try {
    if (versionOf(db) >= SCHEMA_VERSION) return null
    mkdirSync(dir, { recursive: true })
    const target = join(dir, backupFileName('app'))
    snapshotTo(db, target)
    pruneBackups(dir, keep)
    return target
  } finally {
    db.close()
  }
}

/** Leaves the last `keep` snapshots and removes the rest, oldest first. */
export function pruneBackups(dir: string, keep = BACKUPS_KEEP): void {
  const snapshots = readdirSync(dir)
    .filter((name) => name.startsWith('app-') && name.endsWith('.db'))
    .sort()
  for (const name of snapshots.slice(0, Math.max(snapshots.length - keep, 0))) {
    rmSync(join(dir, name), { force: true })
  }
}

/**
 * Reads a candidate restore without trusting it: the header, the integrity of
 * every page, and a schema version this build can open. An older file is fine -
 * the migrations bring it forward at the next start.
 */
export function checkRestoreFile(path: string): RestoreCheck {
  const header = Buffer.alloc(HEADER_BYTES)
  let read = 0
  const fd = openSync(path, 'r')
  try {
    read = readSync(fd, header, 0, HEADER_BYTES, 0)
  } finally {
    closeSync(fd)
  }
  if (read < HEADER_BYTES || header.toString('latin1') !== SQLITE_HEADER) {
    return { ok: false, code: 'NOT_SQLITE', message: 'the file is not a SQLite database' }
  }

  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch {
    return { ok: false, code: 'CORRUPT', message: 'the database could not be opened' }
  }
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined
    if (integrity?.integrity_check !== 'ok') {
      return { ok: false, code: 'CORRUPT', message: 'the database is damaged' }
    }
    const version = versionOf(db)
    if (version === 0) {
      return { ok: false, code: 'NOT_LANTERN', message: 'the file is not a LANtern database' }
    }
    if (version > SCHEMA_VERSION) {
      return {
        ok: false,
        code: 'NEWER_SCHEMA',
        message: `the file comes from a newer server (schema ${version}, this one is ${SCHEMA_VERSION})`,
      }
    }
    return { ok: true, schemaVersion: version }
  } catch {
    return { ok: false, code: 'CORRUPT', message: 'the database could not be read' }
  } finally {
    db.close()
  }
}

/**
 * Applies a parked restore before the database is opened. The replaced file is
 * kept beside it, so a restore that turns out to be the wrong one is not the end
 * of the gradebook.
 */
export function applyPendingRestore(dataDir: string, dbPath: string): boolean {
  const pending = pendingRestorePath(dataDir)
  if (!existsSync(pending)) return false

  // A WAL belongs to the database being replaced. Left behind, it would be
  // replayed on top of the restored file.
  for (const suffix of ['-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
  if (existsSync(dbPath)) {
    // Windows refuses to rename over an existing file; POSIX replaces quietly.
    rmSync(`${dbPath}${REPLACED_SUFFIX}`, { force: true })
    renameSync(dbPath, `${dbPath}${REPLACED_SUFFIX}`)
  }
  renameSync(pending, dbPath)
  return true
}

function versionOf(db: DatabaseSync): number {
  try {
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    return row ? Number(row.value) : 0
  } catch {
    return 0
  }
}

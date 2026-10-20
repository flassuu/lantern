import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildApp, type TestingApp } from '../src/app'
import { applyPendingRestore, pendingRestorePath, pruneBackups, snapshotOnUpgrade } from '../src/lib/backup'
import { SCHEMA_VERSION } from '../src/lib/db'
import { bearer, insertTestAdmin, signInAs } from './support'

process.env.ADMIN_PASSWORD = 'test-admin-password'
process.env.TEACHER_PASSWORD = 'teacher-pass-1'

let app: TestingApp
let tmpDir: string
let admin: string
let teacher: string
let snapshot: Buffer

const dbPath = (): string => join(tmpDir, 'app.db')

function open(): void {
  app = buildApp({ host: '127.0.0.1', port: 0, dbPath: dbPath(), webRoot: null })
}

function close(): void {
  app.server.close()
  app.database.close()
}

function count(table: 'tests' | 'users'): number {
  const row = app.database.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return row.n
}

async function download() {
  return app.server.inject({
    method: 'GET',
    url: '/api/admin/backup',
    headers: bearer(admin),
  })
}

async function upload(bytes: Buffer) {
  return app.server.inject({
    method: 'POST',
    url: '/api/admin/backup/restore',
    headers: { ...bearer(admin), 'content-type': 'application/octet-stream' },
    payload: bytes,
  })
}

describe('backup and restore', () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lantern-backup-'))
  open()
  insertTestAdmin(app)

  afterAll(() => {
    close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('lets only an admin touch the gradebook', async () => {
    admin = await signInAs(app, 'admin', process.env.ADMIN_PASSWORD!)
    teacher = await signInAs(app, 'teacher', process.env.TEACHER_PASSWORD!)

    const listing = await app.server.inject({
      method: 'GET',
      url: '/api/admin/backup',
      headers: bearer(teacher),
    })
    expect(listing.statusCode).toBe(403)

    const restore = await app.server.inject({
      method: 'POST',
      url: '/api/admin/backup/restore',
      headers: { ...bearer(teacher), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('nope'),
    })
    expect(restore.statusCode).toBe(403)
  })

  it('downloads a snapshot that is a database, and stamps the moment', async () => {
    const res = await download()
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/vnd.sqlite3')
    expect(String(res.headers['content-disposition'])).toContain('lantern-backup-')
    snapshot = res.rawPayload
    expect(snapshot.subarray(0, 15).toString()).toBe('SQLite format 3')

    const stats = await app.server.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: bearer(admin),
    })
    const { stats: body } = stats.json() as { stats: { lastBackupAt: string | null } }
    expect(body.lastBackupAt).not.toBeNull()
    // The temporary file the stream was served from is not left behind.
    expect(readdirSync(tmpDir).filter((name) => name.startsWith('.backup-'))).toEqual([])
  })

  it('refuses a file that is not a database', async () => {
    const res = await upload(Buffer.from('this is a photograph of a cat'))
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_SQLITE')
    expect(existsSync(pendingRestorePath(tmpDir))).toBe(false)
  })

  it('refuses a sqlite file from some other program', async () => {
    const stranger = join(tmpDir, 'stranger.db')
    const db = new DatabaseSync(stranger)
    db.exec('CREATE TABLE notes (body TEXT);')
    db.close()

    const res = await upload(Buffer.from(await Bun.file(stranger).arrayBuffer()))
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_LANTERN')
  })

  it('refuses a backup from a newer server', async () => {
    const newer = join(tmpDir, 'newer.db')
    writeFileSync(newer, snapshot)
    const db = new DatabaseSync(newer)
    db.prepare('UPDATE app_meta SET value = ? WHERE key = ?').run('99', 'schema_version')
    db.close()

    const res = await upload(Buffer.from(await Bun.file(newer).arrayBuffer()))
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('NEWER_SCHEMA')
  })

  it('puts the snapshot back at the next start', async () => {
    // Work done after the snapshot is what a restore has to undo.
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/tests',
      headers: bearer(teacher),
      payload: {
        title: 'Written after the snapshot',
        questions: [
          {
            type: 'true_false',
            body: '1 + 1 = 2',
            points: 1,
            position: 0,
            payload: { correct: true },
          },
        ],
      },
    })
    expect(created.statusCode).toBe(201)
    expect(count('tests')).toBe(1)

    const res = await upload(snapshot)
    expect(res.statusCode).toBe(202)
    expect(existsSync(pendingRestorePath(tmpDir))).toBe(true)

    // The running server keeps the gradebook it has; nothing changes under it.
    expect(count('tests')).toBe(1)

    close()
    expect(applyPendingRestore(tmpDir, dbPath())).toBe(true)
    expect(existsSync(pendingRestorePath(tmpDir))).toBe(false)
    expect(existsSync(`${dbPath()}.before-restore`)).toBe(true)
    open()

    expect(count('tests')).toBe(0)
  })

  it('refuses while a run is open', async () => {
    const paper = await app.server.inject({
      method: 'POST',
      url: '/api/tests',
      headers: bearer(teacher),
      payload: {
        title: 'Matter',
        questions: [
          {
            type: 'true_false',
            body: 'Ice is water.',
            points: 1,
            position: 0,
            payload: { correct: true },
          },
        ],
      },
    })
    const testId = (paper.json() as { test: { id: string } }).test.id
    const run = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacher),
      payload: { testId },
    })
    expect(run.statusCode).toBe(201)

    const res = await upload(snapshot)
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: { code: string } }).error.code).toBe('SESSION_ACTIVE')
    expect(existsSync(pendingRestorePath(tmpDir))).toBe(false)
  })
})

describe('backup files', () => {
  it('keeps a copy only when a migration is pending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lantern-snapshot-'))
    const path = join(dir, 'app.db')
    try {
      const db = new DatabaseSync(path)
      db.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
      db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(
        'schema_version',
        String(SCHEMA_VERSION - 1),
      )
      db.close()

      const copy = snapshotOnUpgrade(path, join(dir, 'backups'))
      expect(copy).not.toBeNull()
      expect(existsSync(copy!)).toBe(true)

      // Already current: another launch must not fill the folder with copies.
      const current = join(dir, 'current.db')
      const second = new DatabaseSync(current)
      second.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
      second.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(
        'schema_version',
        String(SCHEMA_VERSION),
      )
      second.close()
      expect(snapshotOnUpgrade(current, join(dir, 'backups'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves the newest seven snapshots and removes the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lantern-prune-'))
    try {
      for (let index = 0; index < 9; index += 1) {
        writeFileSync(join(dir, `app-2026-01-0${index + 1}-00-00-00.db`), 'x')
      }
      pruneBackups(dir)
      const left = readdirSync(dir).sort()
      expect(left).toHaveLength(7)
      expect(left[0]).toBe('app-2026-01-03-00-00-00.db')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { createReadStream, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from '../lib/db'
import { checkDatabase, schemaVersion } from '../lib/db'
import {
  backupFileName,
  checkRestoreFile,
  pendingRestorePath,
  snapshotTo,
} from '../lib/backup'
import { listParticipants, tableCounts } from '../lib/admin'
import { sendError } from '../lib/http'
import { requireRoles } from '../plugins/auth'

/** A snapshot of a classroom database is text and numbers; 64 MB is generous. */
const MAX_RESTORE_BYTES = 64 * 1024 * 1024
const LAST_BACKUP_KEY = 'last_backup_at'

export interface AdminDeps {
  database: Database
  version: string
  /** Where the database lives; a restore is parked next to it. */
  dataDir: string
}

/**
 * Admin-only introspection endpoints: aggregated table counts + DB health,
 * the flat course→student participation list, and the backup pair.
 */
export const adminRoutes: FastifyPluginAsync<AdminDeps> = async (
  app: FastifyInstance,
  { database, version, dataDir }: AdminDeps,
) => {
  app.get(
    '/api/admin/stats',
    { preHandler: requireRoles('admin') },
    async () => {
      return {
        stats: {
          version,
          uptimeMs: process.uptime() * 1000,
          schemaVersion: schemaVersion(database),
          database: checkDatabase(database) ? 'ok' : 'error',
          lastBackupAt: readMeta(database, LAST_BACKUP_KEY),
          counts: tableCounts(database),
        },
      }
    },
  )

  app.get(
    '/api/admin/participants',
    { preHandler: requireRoles('admin') },
    async () => {
      const rows = listParticipants(database)
      return {
        participants: rows.map((row) => ({
          courseId: row.course_id,
          courseTitle: row.course_title,
          studentId: row.student_id,
          username: row.username,
          fullName: row.full_name,
          status: row.student_status,
          enrolledAt: row.enrolled_at,
        })),
      }
    },
  )

  /**
   * The whole gradebook as one file. Written beside the database, streamed, and
   * deleted when the stream closes - a handled download is not a second copy
   * nobody knows about.
   */
  app.get('/api/admin/backup', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const name = backupFileName()
    const target = join(dataDir, `.backup-${Date.now()}.db`)
    try {
      snapshotTo(database.raw, target)
    } catch (error) {
      request.log.error(error)
      return sendError(reply, 500, 'BACKUP_FAILED', 'the database could not be copied')
    }

    writeMeta(database, LAST_BACKUP_KEY, new Date().toISOString())
    const stream = createReadStream(target)
    // The snapshot is a means to the download, not a second copy on the disk:
    // it goes when the last byte is read, when the stream closes, or when it
    // fails halfway.
    const discard = (): void => rmSync(target, { force: true })
    stream.on('end', discard)
    stream.on('close', discard)
    stream.on('error', discard)

    return reply
      .header('content-type', 'application/vnd.sqlite3')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('content-length', String(statSync(target).size))
      .send(stream)
  })

  /**
   * A snapshot comes back as raw bytes. The file is checked here and parked; it
   * is applied by the next start, because a restore under a live server is how
   * a gradebook gets corrupted.
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  )

  app.post(
    '/api/admin/backup/restore',
    { preHandler: requireRoles('admin'), bodyLimit: MAX_RESTORE_BYTES },
    async (request, reply) => {
      if (activeSessions(database) > 0) {
        return sendError(
          reply,
          409,
          'SESSION_ACTIVE',
          'a run is open; finish it before restoring a backup',
        )
      }

      const body = request.body
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return sendError(reply, 400, 'EMPTY', 'send the database file as the request body')
      }

      const incoming = join(dataDir, '.restore.incoming')
      writeFileSync(incoming, body)
      const check = checkRestoreFile(incoming)
      if (!check.ok) {
        rmSync(incoming, { force: true })
        return sendError(reply, 400, check.code, check.message)
      }

      const pending = pendingRestorePath(dataDir)
      rmSync(pending, { force: true })
      renameSync(incoming, pending)
      return reply.code(202).send({
        restore: { restartRequired: true, schemaVersion: check.schemaVersion },
      })
    },
  )
}

function activeSessions(database: Database): number {
  const row = database.raw
    .prepare("SELECT COUNT(*) AS n FROM live_sessions WHERE status IN ('lobby', 'active', 'paused')")
    .get() as { n: number }
  return row.n
}

function readMeta(database: Database, key: string): string | null {
  const row = database.raw.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function writeMeta(database: Database, key: string, value: string): void {
  database.raw
    .prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value)
}

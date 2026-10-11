import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { findCourseRow } from '../lib/courses'
import type { Database } from '../lib/db'
import { sendError } from '../lib/http'
import { courseJournal, journalCsv, roomJournal } from '../lib/journals'
import { findRoomById } from '../lib/rooms'
import type { Session } from '../lib/tokens'
import { requireRoles } from '../plugins/auth'

/**
 * The journal, by room or by course: students against tests, one cell per pair.
 *
 * Two routes rather than one with a parameter, because the two rosters are not
 * the same thing - a room is who, a course is what - and a body that named
 * either would be a request the caller can get wrong. The path says which it is.
 *
 * The CSV is the same numbers the screen shows, from the same query, so a
 * teacher who exports and a teacher who prints are looking at one truth.
 */
const idParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
} as const

/** `?format=csv` is the only format asked for; the screen reads JSON. */
const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { format: { type: 'string', enum: ['csv'] } },
} as const

export const journalRoutes: FastifyPluginAsync<{ database: Database }> = async (
  app: FastifyInstance,
  { database },
) => {
  const db = database.raw

  /** The journal of a room the caller owns, or of any room for an admin. */
  function roomFor(session: Session, roomId: string) {
    const room = findRoomById(db, roomId)
    if (!room) return { missing: true as const }
    if (session.role !== 'admin' && session.userId !== room.owner_id) {
      return { forbidden: true as const }
    }
    return { room }
  }

  app.get(
    '/api/journals/rooms/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema, querystring: querySchema },
    },
    async (request, reply) => {
      const session = request.session as Session
      const params = request.params as { id: string }
      const found = roomFor(session, params.id)
      if ('missing' in found) return sendError(reply, 404, 'NOT_FOUND', 'room not found')
      if ('forbidden' in found) return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      const journal = roomJournal(db, found.room.id, found.room.name)
      if ((request.query as { format?: string }).format === 'csv') {
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="journal-room.csv"')
          .send(journalCsv(journal))
      }
      return { journal }
    },
  )

  app.get(
    '/api/journals/courses/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema, querystring: querySchema },
    },
    async (request, reply) => {
      const session = request.session as Session
      const params = request.params as { id: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (session.role !== 'admin' && session.userId !== course.owner_id) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const journal = courseJournal(db, course.id, course.title)
      if ((request.query as { format?: string }).format === 'csv') {
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="journal-course.csv"')
          .send(journalCsv(journal))
      }
      return { journal }
    },
  )
}

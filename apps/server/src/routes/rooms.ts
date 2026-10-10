import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import {
  createRoom,
  deleteRoom,
  findActiveRoomByKey,
  findRoomById,
  getRoom,
  listRoomCourses,
  listRoomMembers,
  listRooms,
  regenerateRoomKey,
  renameRoom,
  revokeRoom,
  setRoomCourses,
  toRoomPreview,
} from '../lib/rooms'
import { normalizeCode } from '../lib/codes'
import { findCourseRow } from '../lib/courses'
import type { Database } from '../lib/db'
import { sendError } from '../lib/http'
import { requireRoles } from '../plugins/auth'
import type { Session } from '../lib/tokens'

export interface RoomDeps {
  database: Database
}

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
} as const

const createSchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    courseIds: { type: 'array', items: { type: 'string', maxLength: 36 }, maxItems: 20 },
  },
} as const

const renameSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    courseIds: { type: 'array', items: { type: 'string', maxLength: 36 }, maxItems: 20 },
  },
} as const

const previewQuerySchema = {
  type: 'object',
  required: ['key'],
  additionalProperties: false,
  properties: { key: { type: 'string', minLength: 1, maxLength: 16 } },
} as const

/**
 * Ownership. A room belongs to the teacher who made it: an admin may see and
 * manage everything, another teacher may see nothing. There is deliberately no
 * way for one teacher to touch another's room - that is the boundary this
 * whole feature exists to draw.
 */
function mayManage(session: Session, ownerId: string): boolean {
  return session.role === 'admin' || session.userId === ownerId
}

export const roomRoutes: FastifyPluginAsync<RoomDeps> = async (
  app: FastifyInstance,
  { database }: RoomDeps,
) => {
  const db: DatabaseSync = database.raw

  /**
   * What a room key leads to, without signing anything up. Public on purpose:
   * the register screen is the one screen nobody is signed in on, and a student
   * deserves to see "Class 9A · Olena M." before typing a password.
   *
   * A wrong key and a revoked key answer the same way, so a key cannot be used
   * to find out which rooms existed.
   */
  app.get(
    '/api/rooms/preview',
    { schema: { querystring: previewQuerySchema } },
    async (request, reply) => {
      const query = request.query as { key: string }
      const key = normalizeCode(query.key)
      const row = key ? findActiveRoomByKey(db, key) : null
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'no such room key')
      return { preview: toRoomPreview(db, row) }
    },
  )

  app.get(
    '/api/rooms',
    { preHandler: requireRoles('admin', 'teacher') },
    async (request) => {
      const session = request.session!
      // A teacher sees their own rooms; an admin sees every room in the school.
      const ownerId = session.role === 'admin' ? null : session.userId
      return { rooms: listRooms(db, ownerId) }
    },
  )

  app.post(
    '/api/rooms',
    { preHandler: requireRoles('admin', 'teacher'), schema: { body: createSchema } },
    async (request, reply) => {
      const session = request.session!
      const body = request.body as { name: string; courseIds?: string[] }
      const name = body.name.trim()
      if (name === '') return sendError(reply, 400, 'VALIDATION', 'room name is required')
      const courseIds = checkCourses(db, body.courseIds ?? [], session)
      if (!courseIds) return sendError(reply, 400, 'VALIDATION', 'no such course')
      const room = createRoom(db, { ownerId: session.userId, name, courseIds })
      return reply.code(201).send({ room })
    },
  )

  app.get(
    '/api/rooms/:id',
    { preHandler: requireRoles('admin', 'teacher'), schema: { params: idParamsSchema } },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const row = findRoomById(db, params.id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'room not found')
      if (!mayManage(session, row.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      return {
        room: getRoom(db, row.id),
        members: listRoomMembers(db, row.id),
        courses: listRoomCourses(db, row.id),
      }
    },
  )

  app.patch(
    '/api/rooms/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema, body: renameSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const row = findRoomById(db, params.id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'room not found')
      if (!mayManage(session, row.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const body = request.body as { name?: string; courseIds?: string[] }
      if (body.courseIds !== undefined) {
        const courseIds = checkCourses(db, body.courseIds, session)
        if (!courseIds) return sendError(reply, 400, 'VALIDATION', 'no such course')
        setRoomCourses(db, row.id, courseIds)
      }
      if (body.name !== undefined) {
        const name = body.name.trim()
        if (name === '') return sendError(reply, 400, 'VALIDATION', 'room name is required')
        renameRoom(db, row.id, name)
      }
      return { room: getRoom(db, row.id), courses: listRoomCourses(db, row.id) }
    },
  )

  app.post(
    '/api/rooms/:id/revoke',
    { preHandler: requireRoles('admin', 'teacher'), schema: { params: idParamsSchema } },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const row = findRoomById(db, params.id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'room not found')
      if (!mayManage(session, row.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      revokeRoom(db, row.id)
      return { room: getRoom(db, row.id) }
    },
  )

  /** A new key for a room someone photographed and posted on a wall. */
  app.post(
    '/api/rooms/:id/key',
    { preHandler: requireRoles('admin', 'teacher'), schema: { params: idParamsSchema } },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const row = findRoomById(db, params.id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'room not found')
      if (!mayManage(session, row.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const key = regenerateRoomKey(db, row.id)
      return { key, room: getRoom(db, row.id) }
    },
  )

  app.delete(
    '/api/rooms/:id',
    { preHandler: requireRoles('admin', 'teacher'), schema: { params: idParamsSchema } },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const row = findRoomById(db, params.id)
      if (!row) return sendError(reply, 404, 'NOT_FOUND', 'room not found')
      if (!mayManage(session, row.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      deleteRoom(db, row.id)
      return reply.code(204).send()
    },
  )
}

/**
 * Validates the courses a room is attached to. Returns null when any of them
 * cannot be used, which the caller turns into a 400 — a course the requester
 * cannot attach is rejected the same way as a missing one, rather than silently
 * dropped, because a teacher who thinks a group takes algebra should find out
 * now rather than at enrolment.
 */
function checkCourses(db: DatabaseSync, courseIds: string[], session: Session): string[] | null {
  const unique = [...new Set(courseIds)]
  for (const courseId of unique) {
    const course = findCourseRow(db, courseId)
    if (!course) return null
    if (!mayManage(session, course.owner_id)) return null
  }
  return unique
}
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { Database } from '../lib/db'
import { sendError } from '../lib/http'
import { setUserStatus } from '../lib/accountActions'
import {
  createUser,
  findUserByUsername,
  findUserById,
  listUsers,
  toPublicUser,
  type UserStatus,
} from '../lib/users'
import { requireRoles } from '../plugins/auth'
import { hashPassword } from '../lib/passwords'
import { deleteSessionByHash } from '../lib/tokens'
import { nowIso } from '../lib/db'

export interface UsersDeps {
  database: Database
}

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', enum: ['admin', 'teacher', 'student'] },
    status: { type: 'string', enum: ['pending', 'approved', 'blocked'] },
    q: { type: 'string', maxLength: 64 },
  },
} as const

const createUserSchema = {
  type: 'object',
  required: ['username', 'password', 'fullName'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', minLength: 3, maxLength: 32 },
    password: { type: 'string', minLength: 8, maxLength: 128 },
    fullName: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const

const statusParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 36, maxLength: 36 },
  },
} as const

const statusBodySchema = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['pending', 'approved', 'blocked'] },
  },
} as const

export const userRoutes: FastifyPluginAsync<UsersDeps> = async (
  app: FastifyInstance,
  { database }: UsersDeps,
) => {
  const db = database.raw

  /** List users with optional filters; only admins can browse the roster. */
  app.get(
    '/api/users',
    {
      preHandler: requireRoles('admin'),
      schema: { querystring: listQuerySchema },
    },
    async (request) => {
      const query = request.query as {
        role?: 'admin' | 'teacher' | 'student'
        status?: UserStatus
        q?: string
      }
      const users = listUsers(db, {
        role: query.role,
        status: query.status,
        q: query.q,
      }).map(toPublicUser)
      return { users }
    },
  )

  /**
   * Students waiting for approval, for a teacher as well as an admin.
   *
   * A student who registered without a class key is stuck at `pending` until
   * somebody approves them. That somebody used to have to be an admin, which put
   * an institution between a lone teacher and a student who just typed their
   * name. The full roster stays admin-only; this is the one list a teacher needs,
   * and it only ever contains pending students.
   */
  app.get(
    '/api/users/pending',
    { preHandler: requireRoles('admin', 'teacher') },
    async () => ({
      users: listUsers(db, { role: 'student', status: 'pending' }).map(toPublicUser),
    }),
  )

  /** Admin creates teachers; they are approved immediately. */
  app.post(
    '/api/users',
    {
      preHandler: requireRoles('admin'),
      schema: { body: createUserSchema },
    },
    async (request, reply) => {
      const body = request.body as {
        username: string
        password: string
        fullName: string
      }
      if (findUserByUsername(db, body.username)) {
        return sendError(reply, 409, 'CONFLICT', 'username already taken')
      }
      const user = createUser(db, {
        role: 'teacher',
        status: 'approved',
        username: body.username,
        password: body.password,
        fullName: body.fullName,
      })
      return reply.code(201).send({ user: toPublicUser(user) })
    },
  )

  /**
   * Approve or block an account.
   *
   * Admins reach anyone. A teacher reaches students only — a teacher who could
   * block another teacher could lock a colleague out of the room they share the
   * server with, and "one teacher, no admin" must not become "any teacher can
   * disable any account".
   */
  app.patch(
    '/api/users/:id/status',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: statusParamsSchema, body: statusBodySchema },
    },
    async (request, reply) => {
      const params = request.params as { id: string }
      const body = request.body as { status: UserStatus }
      const session = request.session!
      const target = findUserById(db, params.id)
      if (!target) {
        return sendError(reply, 404, 'NOT_FOUND', 'user not found')
      }
      if (session.role === 'teacher' && target.role !== 'student') {
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'a teacher can only approve or block students',
        )
      }
      // The rule - including "blocking revokes live sessions" - lives in the
      // library, so the server console cannot get it subtly different.
      const result = setUserStatus(db, params.id, body.status)
      if (!result.ok) {
        return result.reason === 'not_found'
          ? sendError(reply, 404, 'NOT_FOUND', 'user not found')
          : sendError(reply, 400, 'INVALID_OPERATION', 'admin accounts cannot be modified')
      }
      return { user: toPublicUser(result.user) }
    },
  )

  /**
   * An admin sets somebody else's password.
   *
   * The case is a student who forgot theirs mid-term, or a teacher who needs
   * back into a laptop somebody else has hands on: the person who holds the
   * password cannot change it without the old one, so somebody with the admin
   * role has to be able to. Every session that user held is dropped, because a
   * reset that leaves the old device signed in is not a reset.
   */
  app.patch(
    '/api/users/:id/password',
    {
      preHandler: requireRoles('admin'),
      schema: {
        params: statusParamsSchema,
        body: {
          type: 'object',
          required: ['password'],
          additionalProperties: false,
          properties: { password: { type: 'string', minLength: 8, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { id: string }
      const body = request.body as { password: string }
      const target = findUserById(db, params.id)
      if (!target) return sendError(reply, 404, 'NOT_FOUND', 'user not found')
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
        hashPassword(body.password),
        nowIso(),
        target.id,
      )
      const sessions = db
        .prepare('SELECT token_hash FROM sessions WHERE user_id = ?')
        .all(target.id) as Array<{ token_hash: string }>
      for (const stored of sessions) {
        deleteSessionByHash(db, stored.token_hash)
      }
      return { user: toPublicUser(findUserById(db, params.id)!) }
    },
  )

  /** Admins can remove teachers and students; admin accounts stay immutable. */
  app.delete(
    '/api/users/:id',
    {
      preHandler: requireRoles('admin'),
      schema: { params: statusParamsSchema },
    },
    async (request, reply) => {
      const params = request.params as { id: string }
      const target = findUserById(db, params.id)
      if (!target) {
        return sendError(reply, 404, 'NOT_FOUND', 'user not found')
      }
      if (target.role === 'admin') {
        return sendError(reply, 400, 'INVALID_OPERATION', 'admin accounts cannot be deleted')
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id)
      return reply.code(204).send()
    },
  )
}
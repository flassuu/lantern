import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { Database } from '../lib/db'
import { nowIso } from '../lib/db'
import { sendError } from '../lib/http'
import { addRoomMember, findActiveRoomByKey, toRoomPreview, type RoomRow } from '../lib/rooms'
import { normalizeCode } from '../lib/codes'
import { hashPassword, verifyPassword } from '../lib/passwords'
import { createSession, deleteSession, deleteSessionByHash } from '../lib/tokens'
import {
  findUserByUsername,
  findUserById,
  toPublicUser,
  type UserRow,
} from '../lib/users'
import { requireRoles } from '../plugins/auth'

export interface AuthDeps {
  database: Database
}

const registerSchema = {
  type: 'object',
  required: ['username', 'password', 'fullName'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', minLength: 3, maxLength: 32 },
    password: { type: 'string', minLength: 8, maxLength: 128 },
    fullName: { type: 'string', minLength: 1, maxLength: 100 },
    // Optional: a key a teacher handed out. It approves the account, and it
    // never grants anything but a student role.
    roomKey: { type: 'string', maxLength: 16 },
  },
} as const

const passwordSchema = {
  type: 'object',
  required: ['currentPassword', 'newPassword'],
  additionalProperties: false,
  properties: {
    currentPassword: { type: 'string', minLength: 1, maxLength: 128 },
    newPassword: { type: 'string', minLength: 8, maxLength: 128 },
  },
} as const

const loginSchema = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 32 },
    password: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

export const authRoutes: FastifyPluginAsync<AuthDeps> = async (
  app: FastifyInstance,
  { database }: AuthDeps,
) => {
  const db = database.raw

  /**
   * Students register themselves.
   *
   * Without a key the account starts `pending` and waits for an admin, exactly
   * as before. With a key that a teacher handed out it starts `approved` and the
   * room is recorded - that is the whole point of a room key: the teacher is
   * alone in the room, so nobody else can press "Approve".
   *
   * A key only ever approves a *student*. The role is hard-coded below, so no
   * key, however it was obtained, can produce anything but a student account.
   */
  app.post(
    '/api/auth/register',
    { schema: { body: registerSchema } },
    async (request, reply) => {
      const body = request.body as {
        username: string
        password: string
        fullName: string
        roomKey?: string
      }
      if (findUserByUsername(db, body.username)) {
        return sendError(reply, 409, 'CONFLICT', 'username already taken')
      }

      // A key that was typed but is not usable is an error the student can fix,
      // so nothing is created: no half-registered account to explain later.
      const typedKey = (body.roomKey ?? '').trim()
      let room: RoomRow | null = null
      if (typedKey !== '') {
        const key = normalizeCode(typedKey)
        room = key ? findActiveRoomByKey(db, key) : null
        if (!room) {
          return sendError(reply, 400, 'INVALID_ROOM_KEY', 'no such room key')
        }
      }

      const now = nowIso()
      const userId = randomUUID()
      db.prepare(
        `INSERT INTO users (id, role, status, username, password_hash, full_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        userId,
        'student',
        room ? 'approved' : 'pending',
        body.username,
        hashPassword(body.password),
        body.fullName,
        now,
        now,
      )

      let viaRoom: { roomName: string; teacherName: string } | null = null
      if (room) {
        // Membership, and with it enrolment in every course the room is
        // attached to: arriving at the group is enough to be on the course roll.
        addRoomMember(db, room.id, userId)
        viaRoom = toRoomPreview(db, room)
      }

      const user = findUserByUsername(db, body.username) as UserRow
      return reply.code(201).send({ user: toPublicUser(user), viaRoom })
    },
  )

  app.post(
    '/api/auth/login',
    { schema: { body: loginSchema } },
    async (request, reply) => {
      const body = request.body as { username: string; password: string }
      const user = findUserByUsername(db, body.username)
      if (!user || !verifyPassword(body.password, user.password_hash)) {
        return sendError(reply, 401, 'INVALID_CREDENTIALS', 'invalid username or password')
      }
      if (user.status === 'pending') {
        return sendError(reply, 403, 'PENDING_APPROVAL', 'account awaits approval')
      }
      if (user.status === 'blocked') {
        return sendError(reply, 403, 'BLOCKED', 'account is blocked')
      }
      const token = createSession(db, user.id)
      return { token, user: toPublicUser(user) }
    },
  )

  app.post(
    '/api/auth/logout',
    { preHandler: requireRoles('admin', 'teacher', 'student') },
    async (request, reply) => {
      const session = request.session
      if (session) deleteSession(db, session.token)
      return reply.code(204).send()
    },
  )

  /**
   * A signed-in user changes their own password.
   *
   * This is what makes the desktop app's "admin password" setting real: the seed
   * variable only ever applies to a data directory that has no admin yet, so
   * without this endpoint the setting would silently stop working after the
   * first launch.
   *
   * The current password is required, so a borrowed session cannot lock the owner
   * out. Every other session is ended and this one is reissued, which is what
   * makes a change safe: whoever prompted for it is signed out too.
   */
  app.post(
    '/api/auth/password',
    { preHandler: requireRoles('admin', 'teacher', 'student'), schema: { body: passwordSchema } },
    async (request, reply) => {
      const session = request.session
      if (!session) {
        return sendError(reply, 401, 'UNAUTHORIZED', 'authentication required')
      }
      const body = request.body as { currentPassword: string; newPassword: string }
      const user = findUserById(db, session.userId)
      if (!user) {
        return sendError(reply, 404, 'NOT_FOUND', 'user not found')
      }
      if (!verifyPassword(body.currentPassword, user.password_hash)) {
        return sendError(reply, 401, 'INVALID_CREDENTIALS', 'current password is wrong')
      }

      const now = nowIso()
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
        hashPassword(body.newPassword),
        now,
        user.id,
      )
      const sessions = db
        .prepare('SELECT token_hash FROM sessions WHERE user_id = ?')
        .all(user.id) as Array<{ token_hash: string }>
      for (const stored of sessions) {
        deleteSessionByHash(db, stored.token_hash)
      }
      const token = createSession(db, user.id)
      return { token, user: toPublicUser(findUserById(db, user.id) as UserRow) }
    },
  )

  app.get(
    '/api/auth/me',
    { preHandler: requireRoles('admin', 'teacher', 'student') },
    async (request, reply) => {
      const session = request.session
      if (!session) {
        return sendError(reply, 401, 'UNAUTHORIZED', 'authentication required')
      }
      const user = findUserById(db, session.userId)
      if (!user) {
        return sendError(reply, 404, 'NOT_FOUND', 'user not found')
      }
      return { user: toPublicUser(user) }
    },
  )
}
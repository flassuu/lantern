import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import {
  deleteTag,
  ensureTag,
  findTagById,
  listTags,
  renameTag,
  setEntityTags,
  type TagEntity,
} from '../lib/tags'
import { findCourseRow } from '../lib/courses'
import type { Database } from '../lib/db'
import { sendError } from '../lib/http'
import { findSessionRow } from '../lib/sessions'
import { findTestRow } from '../lib/tests'
import { requireRoles } from '../plugins/auth'

export interface TagDeps {
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
  properties: { name: { type: 'string', minLength: 1, maxLength: 40 } },
} as const

const renameSchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 40 } },
} as const

const linkSchema = {
  type: 'object',
  required: ['names'],
  additionalProperties: false,
  properties: {
    names: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 20 },
  },
} as const

const entityParamsSchema = {
  type: 'object',
  required: ['entity', 'id'],
  additionalProperties: false,
  properties: {
    entity: { type: 'string', enum: ['test', 'session', 'course'] },
    id: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const

/**
 * Who owns the thing a tag is being put on.
 *
 * A tag carries no rights of its own: it inherits the entity's. This is the
 * check that keeps "attach a label to somebody else's test" impossible, and it
 * lives here rather than in the tag library so the library never has to know
 * what a test is.
 */
function entityOwner(db: DatabaseSync, entity: TagEntity, id: string): string | null {
  if (entity === 'test') return findTestRow(db, id)?.owner_id ?? null
  if (entity === 'course') return findCourseRow(db, id)?.owner_id ?? null
  return findSessionRow(db, id)?.owner_id ?? null
}

export const tagRoutes: FastifyPluginAsync<TagDeps> = async (
  app: FastifyInstance,
  { database }: TagDeps,
) => {
  const db: DatabaseSync = database.raw

  app.get('/api/tags', { preHandler: requireRoles('admin', 'teacher') }, async (request) => {
    const session = request.session!
    // Tags are the teacher's own vocabulary. An admin manages everything, but a
    // tag list is a personal list and does not become shared by being read.
    return { tags: listTags(db, session.userId) }
  })

  app.post(
    '/api/tags',
    { preHandler: requireRoles('admin', 'teacher'), schema: { body: createSchema } },
    async (request, reply) => {
      const session = request.session!
      const body = request.body as { name: string }
      const name = body.name.trim()
      if (name === '') return sendError(reply, 400, 'VALIDATION', 'tag name is required')
      return reply.code(201).send({ tag: ensureTag(db, session.userId, name) })
    },
  )

  app.patch(
    '/api/tags/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema, body: renameSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const tag = findTagById(db, params.id)
      if (!tag) return sendError(reply, 404, 'NOT_FOUND', 'tag not found')
      if (tag.ownerId !== session.userId) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const body = request.body as { name: string }
      const name = body.name.trim()
      if (name === '') return sendError(reply, 400, 'VALIDATION', 'tag name is required')
      renameTag(db, tag.id, name)
      return { tag: findTagById(db, tag.id) }
    },
  )

  app.delete(
    '/api/tags/:id',
    { preHandler: requireRoles('admin', 'teacher'), schema: { params: idParamsSchema } },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const tag = findTagById(db, params.id)
      if (!tag) return sendError(reply, 404, 'NOT_FOUND', 'tag not found')
      if (tag.ownerId !== session.userId) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      deleteTag(db, tag.id)
      return reply.code(204).send()
    },
  )

  /**
   * The one call the UI actually makes: put these labels on that thing. Names
   * that are new become tags, names that were dropped lose their link, and the
   * answer is what the entity ends up carrying.
   */
  app.put(
    '/api/tags/:entity/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: entityParamsSchema, body: linkSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { entity: string; id: string }
      // The schema's enum has already refused anything that is not one of the
      // three kinds, so this cast is the narrowing rather than a hope.
      const entity = params.entity as TagEntity
      const ownerId = entityOwner(db, entity, params.id)
      if (ownerId === null) return sendError(reply, 404, 'NOT_FOUND', 'thing not found')
      if (ownerId !== session.userId && session.role !== 'admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const body = request.body as { names: string[] }
      const tags = setEntityTags(db, session.userId, entity, params.id, body.names)
      return { tags }
    },
  )
}
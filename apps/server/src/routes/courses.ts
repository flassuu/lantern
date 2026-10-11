import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { Database } from '../lib/db'
import { sendError } from '../lib/http'
import {
  attachTest,
  createAnnouncement,
  createCourse,
  createMaterial,
  createTopic,
  deleteAnnouncement,
  deleteCourse,
  deleteTopic,
  detachTest,
  enrollStudent,
  findAnnouncementRow,
  findCourseRow,
  findMaterialRow,
  findTopicRow,
  isEnrolled,
  listAnnouncements,
  listCourseRows,
  listEnrolledCourses,
  listMaterials,
  listTopics,
  reorderTopics,
  setMaterialTopic,
  setTestTopic,
  unenrollStudent,
  updateCourse,
  updateTopic,
  type CourseWithRelations,
} from '../lib/courses'
import { findUserByUsername } from '../lib/users'
import { findTestRow } from '../lib/tests'
import { listEntityTags, setEntityTags, tagsByEntity } from '../lib/tags'
import { requireRoles } from '../plugins/auth'
import type { Session } from '../lib/tokens'

export interface CoursesDeps {
  database: Database
  uploadsDir: string
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024 // 100 MiB

const courseBodySchema = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    tags: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 20 },
  },
} as const

const uuidSchema = { type: 'string', minLength: 36, maxLength: 36 }

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: uuidSchema },
} as const

const materialParamsSchema = {
  type: 'object',
  required: ['id', 'materialId'],
  additionalProperties: false,
  properties: { id: uuidSchema, materialId: uuidSchema },
} as const

const enrollParamsSchema = {
  type: 'object',
  required: ['id', 'userId'],
  additionalProperties: false,
  properties: { id: uuidSchema, userId: uuidSchema },
} as const

const testParamsSchema = {
  type: 'object',
  required: ['id', 'testId'],
  additionalProperties: false,
  properties: { id: uuidSchema, testId: uuidSchema },
} as const

const usernameBodySchema = {
  type: 'object',
  required: ['username'],
  additionalProperties: false,
  properties: { username: { type: 'string', minLength: 1, maxLength: 32 } },
} as const

const attachTestBodySchema = {
  type: 'object',
  required: ['testId'],
  additionalProperties: false,
  properties: { testId: uuidSchema },
} as const

const topicParamsSchema = {
  type: 'object',
  required: ['id', 'topicId'],
  additionalProperties: false,
  properties: { id: uuidSchema, topicId: uuidSchema },
} as const

const announcementParamsSchema = {
  type: 'object',
  required: ['id', 'announcementId'],
  additionalProperties: false,
  properties: { id: uuidSchema, announcementId: uuidSchema },
} as const

const topicBodySchema = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: { title: { type: 'string', minLength: 1, maxLength: 200 } },
} as const

const topicOrderSchema = {
  type: 'object',
  required: ['ids'],
  additionalProperties: false,
  properties: {
    ids: { type: 'array', items: uuidSchema, maxItems: 200 },
  },
} as const

const attachmentBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { topicId: { type: ['string', 'null'], maxLength: 36 } },
} as const

const announcementBodySchema = {
  type: 'object',
  required: ['body'],
  additionalProperties: false,
  properties: {
    body: { type: 'string', minLength: 1, maxLength: 4000 },
    materialId: { type: ['string', 'null'], maxLength: 36 },
  },
} as const

const materialQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
} as const

/** True when the session manages a course owned by `ownerId`. */
function canManage(session: Session, ownerId: string): boolean {
  return session.role === 'admin' || session.userId === ownerId
}

export const courseRoutes: FastifyPluginAsync<CoursesDeps> = async (
  app: FastifyInstance,
  { database, uploadsDir }: CoursesDeps,
) => {
  const db = database.raw
  mkdirSync(uploadsDir, { recursive: true })

  // Raw binary uploads without multipart: no native dependencies needed.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    const chunks: Buffer[] = []
    payload.on('data', (chunk: Buffer) => chunks.push(chunk))
    payload.on('end', () => done(null, Buffer.concat(chunks)))
    payload.on('error', (error: Error) => done(error))
  })

  /** `forStudent` drops the roster: who else is in the class is the teacher's business. */
  function courseDetails(courseId: string, forStudent = false): CourseWithRelations {
    const course = findCourseRow(db, courseId) as NonNullable<ReturnType<typeof findCourseRow>>
    const testRows = db
      .prepare(
        `SELECT t.id, t.title, ct.topic_id FROM course_tests ct JOIN tests t ON t.id = ct.test_id
         WHERE ct.course_id = ? ORDER BY ct.added_at ASC`,
      )
      .all(courseId) as Array<{ id: string; title: string; topic_id: string | null }>
    const studentRows = db
      .prepare(
        `SELECT u.id, u.username, u.full_name FROM course_enrollments e JOIN users u ON u.id = e.user_id
         WHERE e.course_id = ? ORDER BY e.enrolled_at ASC`,
      )
      .all(courseId) as Array<{ id: string; username: string; full_name: string }>
    return {
      id: course.id,
      ownerId: course.owner_id,
      title: course.title,
      description: course.description,
      createdAt: course.created_at,
      updatedAt: course.updated_at,
      materialsCount: 0,
      testsCount: testRows.length,
      studentsCount: studentRows.length,
      tags: listEntityTags(db, 'course', courseId),
      materials: listMaterials(db, courseId),
      topics: listTopics(db, courseId),
      announcements: listAnnouncements(db, courseId),
      tests: testRows.map((row) => ({
        id: row.id,
        title: row.title,
        topicId: row.topic_id ?? null,
      })),
      students: forStudent
        ? []
        : studentRows.map((row) => ({
            id: row.id,
            username: row.username,
            fullName: row.full_name,
          })),
    }
  }

  app.get(
    '/api/courses',
    { preHandler: requireRoles('admin', 'teacher', 'student') },
    async (request) => {
      const session = request.session!
      const courses =
        session.role === 'student'
          ? listEnrolledCourses(db, session.userId)
          : listCourseRows(db, session.userId, session.role === 'admin')
      const byCourse = tagsByEntity(db, 'course', courses.map((course) => course.id))
      return {
        courses: courses.map((course) => ({ ...course, tags: byCourse.get(course.id) ?? [] })),
      }
    },
  )

  app.post(
    '/api/courses',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { body: courseBodySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const body = request.body as { title: string; description?: string; tags?: string[] }
      const created = createCourse(db, session.userId, {
        title: body.title,
        description: body.description ?? '',
      })
      if (body.tags !== undefined) {
        setEntityTags(db, session.userId, 'course', created.id, body.tags)
      }
      return reply.code(201).send(courseDetails(created.id))
    },
  )

  app.get(
    '/api/courses/:id',
    {
      preHandler: requireRoles('admin', 'teacher', 'student'),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      // A student may open a course they are enrolled in, never anyone else's.
      const allowed =
        session.role === 'student'
          ? isEnrolled(db, course.id, session.userId)
          : canManage(session, course.owner_id)
      if (!allowed) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      return courseDetails(course.id, session.role === 'student')
    },
  )

  app.patch(
    '/api/courses/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema, body: courseBodySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const body = request.body as { title: string; description?: string; tags?: string[] }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      if (body.tags !== undefined) {
        setEntityTags(db, session.userId, 'course', course.id, body.tags)
      }
      const updated = updateCourse(db, course, {
        title: body.title,
        description: body.description ?? '',
      })
      return courseDetails(updated.id)
    },
  )

  app.delete(
    '/api/courses/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      deleteCourse(db, course.id)
      return reply.code(204).send()
    },
  )

  // Enroll / unenroll students by username.
  app.post(
    '/api/courses/:id/enrollments',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema, body: usernameBodySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const body = request.body as { username: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const student = findUserByUsername(db, body.username)
      if (!student || student.role !== 'student') {
        return sendError(reply, 400, 'INVALID_OPERATION', 'no such student')
      }
      if (student.status !== 'approved') {
        return sendError(reply, 400, 'INVALID_OPERATION', 'student is not approved')
      }
      try {
        enrollStudent(db, course.id, student.id)
      } catch {
        return sendError(reply, 409, 'CONFLICT', 'student already enrolled')
      }
      return reply.code(201).send(courseDetails(course.id))
    },
  )

  app.delete(
    '/api/courses/:id/enrollments/:userId',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: enrollParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string; userId: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      unenrollStudent(db, course.id, params.userId)
      return reply.code(204).send()
    },
  )

  // Attach / detach tests to a course.
  app.post(
    '/api/courses/:id/tests',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema, body: attachTestBodySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const body = request.body as { testId: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      if (!findTestRow(db, body.testId)) {
        return sendError(reply, 404, 'NOT_FOUND', 'test not found')
      }
      try {
        attachTest(db, course.id, body.testId)
      } catch {
        return sendError(reply, 409, 'CONFLICT', 'test already attached')
      }
      return reply.code(201).send(courseDetails(course.id))
    },
  )

  app.delete(
    '/api/courses/:id/tests/:testId',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: testParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string; testId: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      detachTest(db, course.id, params.testId)
      return reply.code(204).send()
    },
  )

  // ------------------------------------------------------------------ topics

  /** A new lesson, at the end of the plan. */
  app.post(
    '/api/courses/:id/topics',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema, body: topicBodySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const body = request.body as { title: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const topic = createTopic(db, course.id, { title: body.title })
      return reply.code(201).send({ topic })
    },
  )

  app.patch(
    '/api/courses/:id/topics/:topicId',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: topicParamsSchema, body: topicBodySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string; topicId: string }
      const body = request.body as { title: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const topic = findTopicRow(db, params.topicId)
      if (!topic || topic.course_id !== course.id) {
        return sendError(reply, 404, 'NOT_FOUND', 'topic not found')
      }
      return { topic: updateTopic(db, topic, { title: body.title }) }
    },
  )

  /**
   * A deleted lesson leaves its tests and materials behind. Deleting a heading a
   * teacher wrote should not delete the reading under it.
   */
  app.delete(
    '/api/courses/:id/topics/:topicId',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: topicParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string; topicId: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const topic = findTopicRow(db, params.topicId)
      if (!topic || topic.course_id !== course.id) {
        return sendError(reply, 404, 'NOT_FOUND', 'topic not found')
      }
      deleteTopic(db, topic.id)
      return reply.code(204).send()
    },
  )

  app.put(
    '/api/courses/:id/topics/order',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema, body: topicOrderSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const body = request.body as { ids: string[] }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      reorderTopics(db, course.id, body.ids)
      return { topics: listTopics(db, course.id) }
    },
  )

  /** A test into a lesson, or back out of one with `{ "topicId": null }`. */
  app.patch(
    '/api/courses/:id/tests/:testId',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: testParamsSchema, body: attachmentBodySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string; testId: string }
      const body = request.body as { topicId?: string | null }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const topicId = body.topicId ?? null
      if (topicId !== null) {
        const topic = findTopicRow(db, topicId)
        if (!topic || topic.course_id !== course.id) {
          return sendError(reply, 404, 'NOT_FOUND', 'topic not found')
        }
      }
      const attached = db
        .prepare('SELECT 1 FROM course_tests WHERE course_id = ? AND test_id = ?')
        .get(course.id, params.testId)
      if (attached === undefined) return sendError(reply, 404, 'NOT_FOUND', 'test not attached')
      setTestTopic(db, course.id, params.testId, topicId)
      return { tests: courseDetails(course.id).tests }
    },
  )

  app.patch(
    '/api/courses/:id/materials/:materialId',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: materialParamsSchema, body: attachmentBodySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string; materialId: string }
      const body = request.body as { topicId?: string | null }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const topicId = body.topicId ?? null
      if (topicId !== null) {
        const topic = findTopicRow(db, topicId)
        if (!topic || topic.course_id !== course.id) {
          return sendError(reply, 404, 'NOT_FOUND', 'topic not found')
        }
      }
      const material = findMaterialRow(db, params.materialId)
      if (!material || material.course_id !== course.id) {
        return sendError(reply, 404, 'NOT_FOUND', 'material not found')
      }
      setMaterialTopic(db, course.id, material.id, topicId)
      return { materials: listMaterials(db, course.id) }
    },
  )

  // ----------------------------------------------------------- announcements

  /**
   * What the teacher says to the class.
   *
   * The body is required and the file optional, because a reading for tomorrow
   * and a note about tomorrow both happen, and requiring the file would make the
   * second one a download rather than a sentence.
   */
  app.post(
    '/api/courses/:id/announcements',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema, body: announcementBodySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const body = request.body as { body: string; materialId?: string | null }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const materialId = body.materialId ?? null
      if (materialId !== null) {
        const material = findMaterialRow(db, materialId)
        if (!material || material.course_id !== course.id) {
          return sendError(reply, 404, 'NOT_FOUND', 'material not found')
        }
      }
      createAnnouncement(db, course.id, session.userId, { body: body.body, materialId })
      return reply.code(201).send({ announcements: listAnnouncements(db, course.id) })
    },
  )

  /** Only the author (or an admin, who manages the teacher) may take one down. */
  app.delete(
    '/api/courses/:id/announcements/:announcementId',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: announcementParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string; announcementId: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const announcement = findAnnouncementRow(db, params.announcementId)
      if (!announcement || announcement.course_id !== course.id) {
        return sendError(reply, 404, 'NOT_FOUND', 'announcement not found')
      }
      if (session.role !== 'admin' && announcement.author_id !== session.userId) {
        return sendError(reply, 403, 'FORBIDDEN', 'not the author')
      }
      deleteAnnouncement(db, announcement.id)
      return reply.code(204).send()
    },
  )

  // Material upload: raw octet-stream body, filename via ?name=<file.pdf>.
  app.post(
    '/api/courses/:id/materials',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: idParamsSchema, querystring: materialQuerySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const query = request.query as { name: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      if (!canManage(session, course.owner_id)) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const body = request.body as Buffer
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return sendError(reply, 400, 'VALIDATION', 'empty file body')
      }
      if (body.length > MAX_UPLOAD_BYTES) {
        return sendError(reply, 413, 'PAYLOAD_TOO_LARGE', 'file exceeds 100 MiB limit')
      }
      const originalName = basename(query.name || 'file.bin')
      const ext = extname(originalName).toLowerCase()
      const mimeType = MIME_BY_EXT[ext.slice(1)] ?? 'application/octet-stream'
      const fileName = `${randomUUID()}${ext}`
      writeFileSync(join(uploadsDir, fileName), body)
      const material = createMaterial(db, course.id, {
        title: originalName,
        filePath: fileName,
        mimeType,
        sizeBytes: body.length,
      })
      return reply.code(201).send(material)
    },
  )

  // Deliver a stored material file.
  app.get(
    '/api/courses/:id/materials/:materialId/file',
    {
      preHandler: requireRoles('admin', 'teacher', 'student'),
      schema: { params: materialParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string; materialId: string }
      const course = findCourseRow(db, params.id)
      if (!course) return sendError(reply, 404, 'NOT_FOUND', 'course not found')
      const allowed =
        session.role === 'student'
          ? isEnrolled(db, course.id, session.userId)
          : canManage(session, course.owner_id)
      if (!allowed) {
        return sendError(reply, 403, 'FORBIDDEN', 'insufficient role')
      }
      const material = findMaterialRow(db, params.materialId)
      if (!material || material.course_id !== course.id) {
        return sendError(reply, 404, 'NOT_FOUND', 'material not found')
      }
      const filePath = join(uploadsDir, material.file_path)
      if (!existsSync(filePath)) {
        return sendError(reply, 404, 'NOT_FOUND', 'material file missing')
      }
      // A picture is looked at, not only downloaded: `attachment` on an image
      // makes the browser save it instead of drawing it, which is the opposite of
      // what a diagram in a lesson is for. Everything else keeps its name, because
      // a file that opens is a file that runs something on the teacher's machine.
      const inline = material.mime_type.startsWith('image/') || material.mime_type === 'text/plain'
      const filename = material.title.replace(/["\\]/g, '')
      return reply
        .type(material.mime_type)
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`)
        .send(createReadStream(filePath))
    },
  )
}
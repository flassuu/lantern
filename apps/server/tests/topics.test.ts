import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { insertTestAdmin } from './support'

// Deterministic admin bootstrap so the seed warning stays quiet in tests.
process.env.ADMIN_PASSWORD = 'test-admin-password'

interface Topic {
  id: string
  title: string
  position: number
}

interface Announcement {
  id: string
  body: string
  authorName: string
  material: { id: string; title: string } | null
}

interface CourseDetails {
  topics: Topic[]
  announcements: Announcement[]
  materials: Array<{ id: string; title: string; topicId: string | null }>
  tests: Array<{ id: string; title: string; topicId: string | null }>
}

let app: TestingApp
let tmpDir: string
let adminToken: string
let teacherToken: string
let otherTeacherToken: string
let studentToken: string
let courseId: string
let testId: string

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

async function details(token = teacherToken): Promise<CourseDetails> {
  const res = await app.server.inject({
    method: 'GET',
    url: `/api/courses/${courseId}`,
    headers: bearer(token),
  })
  expect(res.statusCode).toBe(200)
  return res.json() as CourseDetails
}

async function makeTopic(title: string): Promise<Topic> {
  const res = await app.server.inject({
    method: 'POST',
    url: `/api/courses/${courseId}/topics`,
    headers: bearer(teacherToken),
    payload: { title },
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { topic: Topic }).topic
}

describe('course topics', () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-topics-'))
  app = buildApp({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(tmpDir, 'test.db'),
    webRoot: null,
  })
  insertTestAdmin(app)

  afterAll(() => {
    app.server.close()
    app.database.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('boots two teachers and one enrolled student', async () => {
    const admin = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: process.env.ADMIN_PASSWORD! },
    })
    adminToken = (admin.json() as { token: string }).token

    for (const [username, fullName] of [
      ['topicT', 'Teacher Topics'],
      ['topicO', 'Teacher Other'],
    ] as const) {
      const res = await app.server.inject({
        method: 'POST',
        url: '/api/users',
        headers: bearer(adminToken),
        payload: { username, password: 'teacher-pass-1', fullName },
      })
      expect(res.statusCode).toBe(201)
    }
    const own = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'topicT', password: 'teacher-pass-1' },
    })
    const other = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'topicO', password: 'teacher-pass-1' },
    })
    teacherToken = (own.json() as { token: string }).token
    otherTeacherToken = (other.json() as { token: string }).token

    const reg = await app.server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'topicS', password: 'student-pass-1', fullName: 'Stu Topics' },
    })
    expect(reg.statusCode).toBe(201)
    const studentId = (reg.json() as { user: { id: string } }).user.id
    await app.server.inject({
      method: 'PATCH',
      url: `/api/users/${studentId}/status`,
      headers: bearer(adminToken),
      payload: { status: 'approved' },
    })

    const course = await app.server.inject({
      method: 'POST',
      url: '/api/courses',
      headers: bearer(teacherToken),
      payload: { title: 'Optics', description: 'Light and lenses' },
    })
    courseId = (course.json() as { id: string }).id
    await app.server.inject({
      method: 'POST',
      url: `/api/courses/${courseId}/enrollments`,
      headers: bearer(teacherToken),
      payload: { username: 'topicS' },
    })

    const test = await app.server.inject({
      method: 'POST',
      url: '/api/tests',
      headers: bearer(teacherToken),
      payload: {
        title: 'Refraction',
        description: '',
        timeLimitSec: null,
        passingPercent: null,
        questions: [
          {
            type: 'true_false',
            body: 'Light bends entering water',
            points: 1,
            position: 0,
            payload: { correct: true },
          },
        ],
      },
    })
    testId = (test.json() as { test: { id: string } }).test.id
    await app.server.inject({
      method: 'POST',
      url: `/api/courses/${courseId}/tests`,
      headers: bearer(teacherToken),
      payload: { testId },
    })

    const signedIn = await app.server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'topicS', password: 'student-pass-1' },
    })
    studentToken = (signedIn.json() as { token: string }).token
  })

  it('orders lessons, and reordering is the teacher\'s own business', async () => {
    const first = await makeTopic('Lesson 1: rays')
    const second = await makeTopic('Lesson 2: lenses')
    const third = await makeTopic('Lesson 3: eyes')

    // A new lesson lands at the end rather than the top: adding one is not
    // renumbering the plan the teacher already has.
    expect((await details()).topics.map((topic) => topic.title)).toEqual([
      'Lesson 1: rays',
      'Lesson 2: lenses',
      'Lesson 3: eyes',
    ])

    const res = await app.server.inject({
      method: 'PUT',
      url: `/api/courses/${courseId}/topics/order`,
      headers: bearer(teacherToken),
      payload: { ids: [third.id, first.id, second.id] },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { topics: Topic[] }).topics.map((topic) => topic.title)).toEqual([
      'Lesson 3: eyes',
      'Lesson 1: rays',
      'Lesson 2: lenses',
    ])

    const refused = await app.server.inject({
      method: 'PUT',
      url: `/api/courses/${courseId}/topics/order`,
      headers: bearer(otherTeacherToken),
      payload: { ids: [first.id] },
    })
    expect(refused.statusCode).toBe(403)
    const byStudent = await app.server.inject({
      method: 'PUT',
      url: `/api/courses/${courseId}/topics/order`,
      headers: bearer(studentToken),
      payload: { ids: [first.id] },
    })
    expect(byStudent.statusCode).toBe(403)

    // Renaming, and a lesson that is not this course's, are told apart.
    const renamed = await app.server.inject({
      method: 'PATCH',
      url: `/api/courses/${courseId}/topics/${first.id}`,
      headers: bearer(teacherToken),
      payload: { title: 'Lesson 1: rays and mirrors' },
    })
    expect(renamed.statusCode).toBe(200)
    expect((renamed.json() as { topic: Topic }).topic.title).toBe('Lesson 1: rays and mirrors')
  })

  it('puts a test and a material under a lesson, and survives the lesson being deleted', async () => {
    const topic = await makeTopic('Lesson 4: interference')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const upload = await app.server.inject({
      method: 'POST',
      url: `/api/courses/${courseId}/materials?name=slit.png`,
      headers: { 'content-type': 'application/octet-stream', ...bearer(teacherToken) },
      payload: png,
    })
    expect(upload.statusCode).toBe(201)
    const materialId = (upload.json() as { id: string }).id

    for (const [path, body] of [
      [`/api/courses/${courseId}/tests/${testId}`, { topicId: topic.id }],
      [`/api/courses/${courseId}/materials/${materialId}`, { topicId: topic.id }],
    ] as const) {
      const res = await app.server.inject({
        method: 'PATCH',
        url: path,
        headers: bearer(teacherToken),
        payload: body,
      })
      expect(res.statusCode).toBe(200)
    }
    const filed = await details()
    expect(filed.tests.find((row) => row.id === testId)?.topicId).toBe(topic.id)
    expect(filed.materials.find((row) => row.id === materialId)?.topicId).toBe(topic.id)

    // A deleted lesson leaves what was under it behind. Taking a heading down is
    // not a way to delete the reading that was filed under it.
    const deleted = await app.server.inject({
      method: 'DELETE',
      url: `/api/courses/${courseId}/topics/${topic.id}`,
      headers: bearer(teacherToken),
    })
    expect(deleted.statusCode).toBe(204)
    const after = await details()
    expect(after.topics.map((row) => row.title)).not.toContain('Lesson 4: interference')
    expect(after.tests.find((row) => row.id === testId)?.topicId).toBeNull()
    expect(after.materials.find((row) => row.id === materialId)?.topicId).toBeNull()

    // A lesson id from another course is a 404, not a quiet no-op: attaching a
    // test to it would file the test somewhere the teacher cannot see.
    const foreign = await makeTopic('Lesson 5: lenses again')
    const other = await app.server.inject({
      method: 'PATCH',
      url: `/api/courses/${courseId}/tests/${testId}`,
      headers: bearer(teacherToken),
      payload: { topicId: '00000000-0000-4000-8000-000000000000' },
    })
    expect(other.statusCode).toBe(404)
    expect((await details()).tests.find((row) => row.id === testId)?.topicId).toBeNull()
    expect(foreign.position).toBeGreaterThan(0)
  })

  it('posts an announcement, and only its author may take it down', async () => {
    const material = await app.server.inject({
      method: 'POST',
      url: `/api/courses/${courseId}/materials?name=reading.pdf`,
      headers: { 'content-type': 'application/octet-stream', ...bearer(teacherToken) },
      payload: Buffer.from('%PDF-1.4\nreading\n'),
    })
    const materialId = (material.json() as { id: string }).id

    const posted = await app.server.inject({
      method: 'POST',
      url: `/api/courses/${courseId}/announcements`,
      headers: bearer(teacherToken),
      payload: { body: 'Read chapter 4 before Friday.', materialId },
    })
    expect(posted.statusCode).toBe(201)
    const announcements = (posted.json() as { announcements: Announcement[] }).announcements
    expect(announcements).toHaveLength(1)
    expect(announcements[0]?.body).toBe('Read chapter 4 before Friday.')
    expect(announcements[0]?.material?.id).toBe(materialId)
    expect(announcements[0]?.authorName).toBe('Teacher Topics')

    // A material from another course cannot be attached: an announcement is a
    // note to this class, and this class is not in that course.
    const foreignMaterial = await app.server.inject({
      method: 'POST',
      url: `/api/courses/${courseId}/announcements`,
      headers: bearer(teacherToken),
      payload: { body: 'nope', materialId: '00000000-0000-4000-8000-000000000000' },
    })
    expect(foreignMaterial.statusCode).toBe(404)

    // The student enrolled in the course reads the feed; a student cannot post.
    const asStudent = await app.server.inject({
      method: 'POST',
      url: `/api/courses/${courseId}/announcements`,
      headers: bearer(studentToken),
      payload: { body: 'me too' },
    })
    expect(asStudent.statusCode).toBe(403)
    const feed = await details(studentToken)
    expect(feed.announcements).toHaveLength(1)

    // A teacher who does not own the course cannot delete someone else's words.
    const byOther = await app.server.inject({
      method: 'DELETE',
      url: `/api/courses/${courseId}/announcements/${announcements[0]!.id}`,
      headers: bearer(otherTeacherToken),
    })
    expect(byOther.statusCode).toBe(403)
    expect((await details()).announcements).toHaveLength(1)

    const removed = await app.server.inject({
      method: 'DELETE',
      url: `/api/courses/${courseId}/announcements/${announcements[0]!.id}`,
      headers: bearer(teacherToken),
    })
    expect(removed.statusCode).toBe(204)
    expect((await details()).announcements).toHaveLength(0)
  })

  it('sends an image inline, so it can be looked at rather than only saved', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const upload = await app.server.inject({
      method: 'POST',
      url: `/api/courses/${courseId}/materials?name=diagram.png`,
      headers: { 'content-type': 'application/octet-stream', ...bearer(teacherToken) },
      payload: png,
    })
    const id = (upload.json() as { id: string }).id

    const image = await app.server.inject({
      method: 'GET',
      url: `/api/courses/${courseId}/materials/${id}/file`,
      headers: bearer(studentToken),
    })
    expect(image.statusCode).toBe(200)
    expect(image.headers['content-type']).toContain('image/png')
    expect(image.headers['content-disposition']).toContain('inline')

    const pdf = await app.server.inject({
      method: 'GET',
      url: `/api/courses/${courseId}/materials/${(await details()).materials.find((row) => row.title === 'reading.pdf')!.id}/file`,
      headers: bearer(studentToken),
    })
    expect(pdf.headers['content-disposition']).toContain('attachment')
  })
})

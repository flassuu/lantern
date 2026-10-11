import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { bearer, insertTestAdmin, signInAs } from './support'

process.env.TEACHER_PASSWORD = 'teacher-pass-1'
process.env.ADMIN_PASSWORD = 'test-admin-password'

let app: TestingApp
let tmpDir: string
let teacher: string
let otherTeacher: string
let student: string

/** The eight bytes every PNG starts with; enough for the server to recognise one. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
])

const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(32, 2)])

interface Asset {
  id: string
  title: string
  mimeType: string
  sizeBytes: number
}

async function upload(token: string, name: string, body = PNG): Promise<{ status: number; asset?: Asset }> {
  const res = await app.server.inject({
    method: 'POST',
    url: `/api/assets?name=${encodeURIComponent(name)}`,
    headers: { ...bearer(token), 'content-type': 'application/octet-stream' },
    payload: body,
  })
  return { status: res.statusCode, asset: (res.json() as { asset?: Asset }).asset }
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-assets-'))
  app = buildApp({ host: '127.0.0.1', port: 0, dbPath: join(tmpDir, 'test.db'), webRoot: null })
  insertTestAdmin(app)
  await app.server.ready()
  teacher = await signInAs(app, 'teacher', 'teacher-pass-1')
  const admin = await signInAs(app, 'admin', process.env.ADMIN_PASSWORD!)
  await app.server.inject({
    method: 'POST',
    url: '/api/users',
    headers: bearer(admin),
    payload: { username: 'teacher2', password: 'teacher-pass-1', role: 'teacher', fullName: 'Second' },
  })
  otherTeacher = await signInAs(app, 'teacher2', 'teacher-pass-1')
  const room = await app.server.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: bearer(teacher),
    payload: { name: 'Assets room', courseIds: [] },
  })
  const key = (room.json() as { room: { key: string } }).room.key
  await app.server.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'pupil', password: 'student-pass-1', fullName: 'Pupil', roomKey: key },
  })
  student = await signInAs(app, 'pupil', 'student-pass-1')
})

afterAll(() => {
  app.server.close()
  app.database.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('images a question points at', () => {
  it('takes a picture, serves it to the student holding the paper, and refuses a stranger', async () => {
    const uploaded = await upload(teacher, 'diagram.png')
    expect(uploaded.status).toBe(201)
    const asset = uploaded.asset!
    expect(asset.mimeType).toBe('image/png')
    expect(asset.sizeBytes).toBe(PNG.length)

    // The student can see it: the id travelled inside their paper.
    const forStudent = await app.server.inject({
      method: 'GET',
      url: `/api/assets/${asset.id}`,
      headers: bearer(student),
    })
    expect(forStudent.statusCode).toBe(200)
    expect(forStudent.headers['content-type']).toContain('image/png')
    expect(forStudent.body.length).toBe(PNG.length)

    // Another teacher may read it but may not delete it.
    const foreignDelete = await app.server.inject({
      method: 'DELETE',
      url: `/api/assets/${asset.id}`,
      headers: bearer(otherTeacher),
    })
    expect(foreignDelete.statusCode).toBe(404)

    const ownDelete = await app.server.inject({
      method: 'DELETE',
      url: `/api/assets/${asset.id}`,
      headers: bearer(teacher),
    })
    expect(ownDelete.statusCode).toBe(204)
    const gone = await app.server.inject({
      method: 'GET',
      url: `/api/assets/${asset.id}`,
      headers: bearer(teacher),
    })
    expect(gone.statusCode).toBe(404)
  })

  it('refuses what is not a picture, and bounds what is', async () => {
    const text = await upload(teacher, 'notes.txt', Buffer.from('just words'))
    expect(text.status).toBe(415)

    // A GIF kept its animation because the server believed the bytes.
    const gif = await upload(teacher, 'reaction.gif', GIF)
    expect(gif.asset?.mimeType).toBe('image/gif')

    // A student may not upload at all.
    const byStudent = await upload(student, 'cheat.png')
    expect(byStudent.status).toBe(403)

    const huge = await upload(teacher, 'huge.png', Buffer.alloc(9 * 1024 * 1024))
    expect(huge.status).toBe(413)
  })
})

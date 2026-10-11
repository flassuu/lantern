import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { insertTestAdmin } from './support'
import { CODE_ALPHABET, CODE_LENGTH, normalizeCode } from '../src/lib/codes'
import { SCHEMA_VERSION } from '../src/lib/db'

// Deterministic admin bootstrap so the seed warning stays quiet in tests.
process.env.ADMIN_PASSWORD = 'test-admin-password'

interface ErrorBody {
  error: { code: string; message: string }
}

interface RoomBody {
  room: {
    id: string
    name: string
    key: string
    status: 'active' | 'revoked'
    courseIds: string[]
    membersCount: number
  }
}

interface ListBody {
  rooms: RoomBody['room'][]
}

let app: TestingApp
let tmpDir: string
let adminToken: string
let teacherA: string
let teacherB: string

async function login(username: string, password: string) {
  return app.server.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  })
}

async function tokenOf(username: string, password: string): Promise<string> {
  const res = await login(username, password)
  expect(res.statusCode).toBe(200)
  return (res.json() as { token: string }).token
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

async function makeTeacher(username: string): Promise<string> {
  await app.server.inject({
    method: 'POST',
    url: '/api/users',
    headers: bearer(adminToken),
    payload: {
      username,
      password: 'teacher-pass-1',
      fullName: username === 'teacherA' ? 'Teacher A' : 'Teacher B',
    },
  })
  return tokenOf(username, 'teacher-pass-1')
}

async function createRoom(token: string, name: string, courseIds: string[] = []) {
  return app.server.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: bearer(token),
    payload: { name, courseIds },
  })
}

async function registerStudent(
  username: string,
  roomKey?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload: Record<string, string> = {
    username,
    password: 'student-pass-1',
    fullName: `Student ${username}`,
  }
  if (roomKey !== undefined) payload.roomKey = roomKey
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload,
  })
  return { status: res.statusCode, body: res.json() as Record<string, unknown> }
}

/** Approves a registered student and returns their token. */
async function approve(username: string): Promise<string> {
  const users = await app.server.inject({
    method: 'GET',
    url: '/api/users',
    headers: bearer(adminToken),
  })
  const list = (users.json() as { users: Array<{ id: string; username: string }> }).users
  const target = list.find((user) => user.username === username)
  await app.server.inject({
    method: 'PATCH',
    url: `/api/users/${target!.id}/status`,
    headers: bearer(adminToken),
    payload: { status: 'approved' },
  })
  return tokenOf(username, 'student-pass-1')
}

describe('room keys', () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-rooms-'))
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

  it('runs the new migration', () => {
    expect(SCHEMA_VERSION).toBe(10)
  })

  it('generates keys from the join-code alphabet, with no 0/O or 1/I', async () => {
    adminToken = await tokenOf('admin', process.env.ADMIN_PASSWORD!)
    teacherA = await makeTeacher('teacherA')
    teacherB = await makeTeacher('teacherB')

    const keys: string[] = []
    for (let index = 0; index < 12; index += 1) {
      const res = await createRoom(teacherA, `Room ${index}`)
      const key = (res.json() as RoomBody).room.key
      expect(key).toHaveLength(CODE_LENGTH)
      for (const glyph of key) expect(CODE_ALPHABET).toContain(glyph)
      expect(key).not.toMatch(/[01OI]/)
      keys.push(key)
    }
    // Uniqueness is a property of the column, but a collision would mean two
    // rooms share a door; 12 random draws must not collide.
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('accepts a key however a student types it', () => {
    // Lower case, spaces and a dash: the three things a typed key comes with.
    // (Digits 0 and 1 are not in the alphabet, so they cannot appear here.)
    expect(normalizeCode('abc234')).toBe('ABC234')
    expect(normalizeCode(' abc 234 ')).toBe('ABC234')
    expect(normalizeCode('ABC-234')).toBe('ABC234')
    expect(normalizeCode('hkq 456')).toBe('HKQ456')
  })

  it('refuses input that is not a code, so "not typed" and "not valid" look the same', () => {
    expect(normalizeCode('ABC12')).toBe('')
    expect(normalizeCode('ABC1234')).toBe('')
    expect(normalizeCode('ABC12O')).toBe('')
    expect(normalizeCode('abc123')).toBe('')
    expect(normalizeCode('ABC 12!')).toBe('')
    expect(normalizeCode('')).toBe('')
    expect(normalizeCode(null)).toBe('')
  })

  it('lists only the teacher\'s own rooms', async () => {
    const mine = await app.server.inject({
      method: 'GET',
      url: '/api/rooms',
      headers: bearer(teacherB),
    })
    expect(mine.statusCode).toBe(200)
    expect((mine.json() as ListBody).rooms).toHaveLength(0)

    const all = await app.server.inject({
      method: 'GET',
      url: '/api/rooms',
      headers: bearer(adminToken),
    })
    expect((all.json() as ListBody).rooms.length).toBe(12)
  })

  it('does not let a teacher see, rename or delete another teacher\'s room', async () => {
    const created = await createRoom(teacherA, 'Physics 9B')
    const id = (created.json() as RoomBody).room.id

    for (const call of [
      app.server.inject({
        method: 'GET',
        url: `/api/rooms/${id}`,
        headers: bearer(teacherB),
      }),
      app.server.inject({
        method: 'PATCH',
        url: `/api/rooms/${id}`,
        headers: bearer(teacherB),
        payload: { name: 'Stolen' },
      }),
      app.server.inject({
        method: 'POST',
        url: `/api/rooms/${id}/revoke`,
        headers: bearer(teacherB),
      }),
      app.server.inject({
        method: 'POST',
        url: `/api/rooms/${id}/key`,
        headers: bearer(teacherB),
      }),
      app.server.inject({
        method: 'DELETE',
        url: `/api/rooms/${id}`,
        headers: bearer(teacherB),
      }),
    ]) {
      expect((await call).statusCode).toBe(403)
    }

    // ...and the room is untouched.
    const check = await app.server.inject({
      method: 'GET',
      url: `/api/rooms/${id}`,
      headers: bearer(teacherA),
    })
    const body = check.json() as { room: RoomBody['room'] }
    expect(body.room.name).toBe('Physics 9B')
    expect(body.room.status).toBe('active')
  })

  it('does not let a student touch rooms at all', async () => {
    const created = await createRoom(teacherA, 'History 10A')
    const id = (created.json() as RoomBody).room.id
    await registerStudent('stuKeys')
    const studentToken = await approve('stuKeys')

    const list = await app.server.inject({
      method: 'GET',
      url: '/api/rooms',
      headers: bearer(studentToken),
    })
    expect(list.statusCode).toBe(403)

    const create = await app.server.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: bearer(studentToken),
      payload: { name: 'Mine now' },
    })
    expect(create.statusCode).toBe(403)
    expect(id).toHaveLength(36)
  })

  it('previews a key to anyone, so a student can see who is waiting', async () => {
    const created = await createRoom(teacherA, 'Biology 8B')
    const key = (created.json() as RoomBody).room.key

    const res = await app.server.inject({
      method: 'GET',
      url: `/api/rooms/preview?key=${key}`,
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { preview: Record<string, string> }).preview).toEqual({
      roomName: 'Biology 8B',
      teacherName: 'Teacher A',
    })
  })

  it('answers a wrong key and a revoked key the same way', async () => {
    const created = await createRoom(teacherA, 'Geography 7A')
    const id = (created.json() as RoomBody).room.id
    const key = (created.json() as RoomBody).room.key

    const wrong = await app.server.inject({
      method: 'GET',
      url: '/api/rooms/preview?key=ZZZZZZ',
    })
    expect(wrong.statusCode).toBe(404)

    await app.server.inject({
      method: 'POST',
      url: `/api/rooms/${id}/revoke`,
      headers: bearer(teacherA),
    })
    const revoked = await app.server.inject({
      method: 'GET',
      url: `/api/rooms/preview?key=${key}`,
    })
    expect(revoked.statusCode).toBe(404)
    expect((revoked.json() as ErrorBody).error.message).toBe(
      (wrong.json() as ErrorBody).error.message,
    )
  })

  it('registers a student straight into the room, without an admin', async () => {
    const created = await createRoom(teacherA, 'Math 9A')
    const key = (created.json() as RoomBody).room.key

    const { status, body } = await registerStudent('stuMath', key.toLowerCase())
    expect(status).toBe(201)
    expect((body.user as { role: string; status: string }).status).toBe('approved')
    expect(body.viaRoom).toEqual({ roomName: 'Math 9A', teacherName: 'Teacher A' })

    // The account can sign in immediately: that is the whole feature.
    expect((await login('stuMath', 'student-pass-1')).statusCode).toBe(200)
  })

  it('never lets a key produce anything but a student', async () => {
    const created = await createRoom(teacherA, 'Math 9B')
    const key = (created.json() as RoomBody).room.key
    const { body } = await registerStudent('stuRole', key)
    expect((body.user as { role: string }).role).toBe('student')

    // And no field in the request can change that.
    const forced = await app.server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'stuRole2',
        password: 'student-pass-1',
        fullName: 'Forced',
        roomKey: key,
        role: 'admin',
        status: 'approved',
      },
    })
    expect(forced.statusCode).toBe(201)
    expect(
      ((forced.json() as { user: Record<string, string> }).user.role as string),
    ).toBe('student')
  })

  it('creates nothing when the key is wrong: a 400, not a half-registered account', async () => {
    const { status, body } = await registerStudent('stuBadKey', 'ZZZZZZ')
    expect(status).toBe(400)
    expect((body.error as { code: string }).code).toBe('INVALID_ROOM_KEY')
    // No account exists, so the name is still free.
    expect((await login('stuBadKey', 'student-pass-1')).statusCode).toBe(401)
    const again = await registerStudent('stuBadKey')
    expect(again.status).toBe(201)
    expect((again.body.user as { status: string }).status).toBe('pending')
  })

  it('leaves registration unchanged when no key is typed', async () => {
    const { status, body } = await registerStudent('stuPlain')
    expect(status).toBe(201)
    expect((body.user as { status: string }).status).toBe('pending')
    expect(body.viaRoom).toBeNull()
    // Pending means pending: no sign-in until an admin approves.
    const attempt = await login('stuPlain', 'student-pass-1')
    expect(attempt.statusCode).toBe(403)
    expect((attempt.json() as ErrorBody).error.code).toBe('PENDING_APPROVAL')
    await approve('stuPlain')
  })

  it('counts the students who came through a key', async () => {
    const created = await createRoom(teacherA, 'Physics 9C')
    const id = (created.json() as RoomBody).room.id
    const key = (created.json() as RoomBody).room.key

    await registerStudent('stuPhys1', key)
    await registerStudent('stuPhys2', ` ${key.toLowerCase()} `)

    const detail = await app.server.inject({
      method: 'GET',
      url: `/api/rooms/${id}`,
      headers: bearer(teacherA),
    })
    const body = detail.json() as {
      room: RoomBody['room']
      members: Array<{ username: string }>
    }
    expect(body.room.membersCount).toBe(2)
    expect(body.members.map((m) => m.username)).toEqual(['stuPhys1', 'stuPhys2'])
  })

  it('enrols every member in every linked course, whichever way the link was made', async () => {
    const first = await app.server.inject({
      method: 'POST',
      url: '/api/courses',
      headers: bearer(teacherA),
      payload: { title: 'Algebra 9' },
    })
    const second = await app.server.inject({
      method: 'POST',
      url: '/api/courses',
      headers: bearer(teacherA),
      payload: { title: 'Geometry 9' },
    })
    const firstId = (first.json() as { id: string }).id
    const secondId = (second.json() as { id: string }).id

    // One course when the room is created; the second is attached afterwards.
    const created = await createRoom(teacherA, 'Algebra group', [firstId])
    const roomId = (created.json() as RoomBody).room.id
    const key = (created.json() as RoomBody).room.key

    const { status, body } = await registerStudent('stuAlg', key)
    expect(status).toBe(201)
    const studentId = (body.user as { id: string }).id

    async function coursesOf(username: string): Promise<string[]> {
      const token = await tokenOf(username, 'student-pass-1')
      const res = await app.server.inject({
        method: 'GET',
        url: '/api/courses',
        headers: bearer(token),
      })
      return (res.json() as { courses: Array<{ id: string }> }).courses.map((c) => c.id)
    }

    expect(await coursesOf('stuAlg')).toEqual([firstId])

    // A course attached after the students arrived still catches them up.
    const linked = await app.server.inject({
      method: 'PATCH',
      url: `/api/rooms/${roomId}`,
      headers: bearer(teacherA),
      payload: { courseIds: [firstId, secondId] },
    })
    expect(linked.statusCode).toBe(200)
    expect(await coursesOf('stuAlg')).toEqual(expect.arrayContaining([firstId, secondId]))

    // And a student who arrives after both links lands in both of them.
    await registerStudent('stuGeo', key)
    expect(await coursesOf('stuGeo')).toEqual(expect.arrayContaining([firstId, secondId]))

    // Catching up must not double anyone: the roll still lists them once, and
    // enrolling a member by hand afterwards is refused as a duplicate.
    const detail = await app.server.inject({
      method: 'GET',
      url: `/api/courses/${firstId}`,
      headers: bearer(teacherA),
    })
    const students = (detail.json() as { students: Array<{ id: string }> }).students
    expect(students.filter((s) => s.id === studentId)).toHaveLength(1)

    const enroll = await app.server.inject({
      method: 'POST',
      url: `/api/courses/${firstId}/enrollments`,
      headers: bearer(teacherA),
      payload: { username: 'stuAlg' },
    })
    expect(enroll.statusCode).toBe(409)
  })

  it('refuses a course the teacher does not own', async () => {
    const course = await app.server.inject({
      method: 'POST',
      url: '/api/courses',
      headers: bearer(teacherB),
      payload: { title: 'Biology 11' },
    })
    const courseId = (course.json() as { id: string }).id

    const res = await createRoom(teacherA, 'Biology group', [courseId])
    expect(res.statusCode).toBe(400)
    expect((res.json() as ErrorBody).error.code).toBe('VALIDATION')
  })

  it('refuses a course that does not exist', async () => {
    const res = await createRoom(teacherA, 'Ghost group', [
      '00000000-0000-4000-8000-000000000000',
    ])
    expect(res.statusCode).toBe(400)
  })

  it('hands out a new key and retires the old one', async () => {
    const created = await createRoom(teacherA, 'Chemistry 10B')
    const id = (created.json() as RoomBody).room.id
    const oldKey = (created.json() as RoomBody).room.key

    const res = await app.server.inject({
      method: 'POST',
      url: `/api/rooms/${id}/key`,
      headers: bearer(teacherA),
    })
    const body = res.json() as { key: string; room: RoomBody['room'] }
    expect(body.key).not.toBe(oldKey)
    expect(body.room.key).toBe(body.key)

    // The old poster on the wall stops working; the new one works.
    const old = await registerStudent('stuOldKey', oldKey)
    expect(old.status).toBe(400)
    const fresh = await registerStudent('stuNewKey', body.key)
    expect(fresh.status).toBe(201)
  })

  it('renames a room without touching its key or its students', async () => {
    const created = await createRoom(teacherA, 'Old name')
    const id = (created.json() as RoomBody).room.id
    const key = (created.json() as RoomBody).room.key
    await registerStudent('stuRename', key)

    const res = await app.server.inject({
      method: 'PATCH',
      url: `/api/rooms/${id}`,
      headers: bearer(teacherA),
      payload: { name: 'New name' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { room: RoomBody['room'] }
    expect(body.room.name).toBe('New name')
    expect(body.room.key).toBe(key)
    expect(body.room.membersCount).toBe(1)
  })

  it('refuses an empty name, in either place a name can be set', async () => {
    const created = await createRoom(teacherA, 'Named')
    const id = (created.json() as RoomBody).room.id

    const create = await app.server.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: bearer(teacherA),
      payload: { name: '   ' },
    })
    expect(create.statusCode).toBe(400)

    const rename = await app.server.inject({
      method: 'PATCH',
      url: `/api/rooms/${id}`,
      headers: bearer(teacherA),
      payload: { name: '  ' },
    })
    expect(rename.statusCode).toBe(400)
  })

  it('deletes a room and forgets its members, but keeps the students', async () => {
    const created = await createRoom(teacherA, 'Temporary')
    const id = (created.json() as RoomBody).room.id
    const key = (created.json() as RoomBody).room.key
    await registerStudent('stuTemp', key)

    const res = await app.server.inject({
      method: 'DELETE',
      url: `/api/rooms/${id}`,
      headers: bearer(teacherA),
    })
    expect(res.statusCode).toBe(204)

    const preview = await app.server.inject({
      method: 'GET',
      url: `/api/rooms/preview?key=${key}`,
    })
    expect(preview.statusCode).toBe(404)

    // The student is still a real, working account.
    expect((await login('stuTemp', 'student-pass-1')).statusCode).toBe(200)
  })

  it('answers 404 for a room that never existed', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: '/api/rooms/00000000-0000-4000-8000-000000000000',
      headers: bearer(teacherA),
    })
    expect(res.statusCode).toBe(404)
  })
})
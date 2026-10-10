import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { insertTeacher, insertTestAdmin, signInAs, bearer } from './support'

// Deterministic admin bootstrap so the seed warning stays quiet in tests, and a
// known password for the teacher first boot seeds.
process.env.ADMIN_PASSWORD = 'test-admin-password'
process.env.TEACHER_PASSWORD = 'teacher-pass-1'

interface TagBody {
  tags: Array<{ id: string; name: string }>
}

let app: TestingApp
let tmpDir: string
let adminToken: string
let teacherA: string
let teacherB: string

async function makeTest(token: string, title: string, extra: Record<string, unknown> = {}) {
  return app.server.inject({
    method: 'POST',
    url: '/api/tests',
    headers: bearer(token),
    payload: {
      title,
      questions: [
        {
          type: 'true_false',
          body: 'Two plus two is four.',
          points: 1,
          position: 0,
          payload: { correct: true },
        },
      ],
      ...extra,
    },
  })
}

async function makeRoom(token: string, name: string) {
  return app.server.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: bearer(token),
    payload: { name, courseIds: [] },
  })
}

/** Puts labels on something: the single call the UI makes. */
async function tag(entity: string, id: string, names: string[], token: string) {
  return app.server.inject({
    method: 'PUT',
    url: `/api/tags/${entity}/${id}`,
    headers: bearer(token),
    payload: { names },
  })
}

async function sessionList(token: string, query = '') {
  return app.server.inject({
    method: 'GET',
    url: `/api/sessions${query}`,
    headers: bearer(token),
  })
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-tags-'))
  app = buildApp({ host: '127.0.0.1', port: 0, dbPath: join(tmpDir, 'test.db'), webRoot: null })
  insertTestAdmin(app)
  adminToken = await signInAs(app, 'admin', process.env.ADMIN_PASSWORD!)
  insertTeacher(app, 'teacherB', 'teacher-pass-1')
  teacherA = await signInAs(app, 'teacher', 'teacher-pass-1')
  teacherB = await signInAs(app, 'teacherB', 'teacher-pass-1')
})

afterAll(() => {
  app.server.close()
  app.database.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('tags', () => {
  it('are the teacher\'s own vocabulary, and one label is one tag', async () => {
    const first = await app.server.inject({
      method: 'POST',
      url: '/api/tags',
      headers: bearer(teacherA),
      payload: { name: 'Algebra' },
    })
    expect(first.statusCode).toBe(201)

    // Same word in another case is the same label, not a second one.
    const again = await app.server.inject({
      method: 'POST',
      url: '/api/tags',
      headers: bearer(teacherA),
      payload: { name: '  algebra ' },
    })
    expect(again.statusCode).toBe(201)
    expect((again.json() as TagBody).tags ?? []).toEqual([])
    const firstTag = (first.json() as { tag: { id: string } }).tag
    const secondTag = (again.json() as { tag: { id: string } }).tag
    expect(secondTag.id).toBe(firstTag.id)

    // And another teacher's vocabulary is not shared: same word, their own tag.
    const other = await app.server.inject({
      method: 'POST',
      url: '/api/tags',
      headers: bearer(teacherB),
      payload: { name: 'Algebra' },
    })
    const otherTag = (other.json() as { tag: { id: string } }).tag
    expect(otherTag.id).not.toBe(firstTag.id)

    const list = await app.server.inject({
      method: 'GET',
      url: '/api/tags',
      headers: bearer(teacherA),
    })
    const tags = (list.json() as TagBody).tags
    expect(tags.map((entry) => entry.name)).toEqual(['Algebra'])
  })

  it('attach to a test, and come back with it', async () => {
    const created = await makeTest(teacherA, 'Fractions')
    const testId = (created.json() as { test: { id: string } }).test.id

    const linked = await tag('test', testId, ['Algebra', 'Year 9'], teacherA)
    expect(linked.statusCode).toBe(200)
    expect((linked.json() as TagBody).tags.map((entry) => entry.name)).toEqual([
      'Algebra',
      'Year 9',
    ])

    const read = await app.server.inject({
      method: 'GET',
      url: `/api/tests/${testId}`,
      headers: bearer(teacherA),
    })
    expect((read.json() as { test: { tags: Array<{ name: string }> } }).test.tags).toHaveLength(2)
  })

  it('are replaced, not accumulated: dropping a name drops the link', async () => {
    const created = await makeTest(teacherA, 'Geometry')
    const testId = (created.json() as { test: { id: string } }).test.id
    await tag('test', testId, ['Algebra', 'Geometry'], teacherA)
    const second = await tag('test', testId, ['Geometry'], teacherA)
    expect((second.json() as TagBody).tags.map((entry) => entry.name)).toEqual(['Geometry'])

    // The label itself survives on its own, for the next thing to be labelled.
    const list = await app.server.inject({
      method: 'GET',
      url: '/api/tags',
      headers: bearer(teacherA),
    })
    expect((list.json() as TagBody).tags.map((entry) => entry.name)).toContain('Algebra')
  })

  it('travel with a duplicate, because it is the same paper', async () => {
    const created = await makeTest(teacherA, 'Fractions')
    const testId = (created.json() as { test: { id: string } }).test.id
    await tag('test', testId, ['Algebra'], teacherA)

    const copy = await app.server.inject({
      method: 'POST',
      url: `/api/tests/${testId}/duplicate`,
      headers: bearer(teacherA),
    })
    const copyId = (copy.json() as { test: { id: string; tags: Array<{ name: string }> } }).test
    expect(copyId.tags.map((entry) => entry.name)).toEqual(['Algebra'])
  })

  it('cannot be put on somebody else\'s test', async () => {
    const created = await makeTest(teacherA, 'Private paper')
    const testId = (created.json() as { test: { id: string } }).test.id

    const denied = await tag('test', testId, ['Mine'], teacherB)
    expect(denied.statusCode).toBe(403)
    // And nothing was half-written on the way out.
    const read = await app.server.inject({
      method: 'GET',
      url: `/api/tests/${testId}`,
      headers: bearer(teacherA),
    })
    expect((read.json() as { test: { tags: unknown[] } }).test.tags).toHaveLength(0)
  })

  it('answer 404 for a thing that is not there, and 400 for a kind that is not', async () => {
    const missing = await tag('test', '00000000-0000-4000-8000-000000000000', ['x'], teacherA)
    expect(missing.statusCode).toBe(404)
    const wrongKind = await tag('unicorn', 'whatever', ['x'], teacherA)
    expect(wrongKind.statusCode).toBe(400)
  })

  it('ride on a course', async () => {
    const course = await app.server.inject({
      method: 'POST',
      url: '/api/courses',
      headers: bearer(teacherA),
      payload: { title: 'Algebra 9', tags: ['Subject'] },
    })
    expect(course.statusCode).toBe(201)
    expect((course.json() as { tags: Array<{ name: string }> }).tags.map((entry) => entry.name)).toEqual([
      'Subject',
    ])
  })
})

describe('sessions carry a name, a room and labels', () => {
  let roomId = ''
  let testId = ''

  it('takes all three when it is started', async () => {
    const room = await makeRoom(teacherA, 'Class 9A')
    roomId = (room.json() as { room: { id: string } }).room.id
    const created = await makeTest(teacherA, 'Fractions', { roomId })
    testId = (created.json() as { test: { id: string } }).test.id

    const session = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherA),
      payload: { testId, name: 'Monday revision', tags: ['Algebra'] },
    })
    expect(session.statusCode).toBe(201)
    const body = session.json() as { session: { name: string; roomId: string } }
    expect(body.session.name).toBe('Monday revision')
    // No room given: the run inherits the test's own group.
    expect(body.session.roomId).toBe(roomId)
  })

  it('lets the teacher point a run at a different group', async () => {
    const other = await makeRoom(teacherA, 'Class 9B')
    const otherId = (other.json() as { room: { id: string } }).room.id
    const session = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherA),
      payload: { testId, roomId: otherId },
    })
    expect((session.json() as { session: { roomId: string } }).session.roomId).toBe(otherId)
  })

  it('refuses a room that is not the teacher\'s', async () => {
    const foreign = await makeRoom(teacherB, 'Class 11Z')
    const foreignId = (foreign.json() as { room: { id: string } }).room.id
    const session = await app.server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: bearer(teacherA),
      payload: { testId, roomId: foreignId },
    })
    expect(session.statusCode).toBe(403)
  })

  it('can be found by room, by status, by word and by label', async () => {
    const all = await sessionList(teacherA)
    const sessions = (all.json() as { sessions: Array<{ id: string; title: string }> }).sessions
    // Two runs so far: the named one, and the one pointed at another group. The
    // third create in this file is expected to be refused, so it leaves nothing.
    expect(sessions).toHaveLength(2)

    const byRoom = await sessionList(teacherA, `?room=${roomId}`)
    const roomSessions = (byRoom.json() as { sessions: Array<{ roomId: string }> }).sessions
    expect(roomSessions.every((entry) => entry.roomId === roomId)).toBe(true)
    expect(roomSessions.length).toBeGreaterThanOrEqual(1)

    const byWord = await sessionList(teacherA, '?q=revision')
    expect((byWord.json() as { sessions: unknown[] }).sessions).toHaveLength(1)

    const byStatus = await sessionList(teacherA, '?status=finished')
    expect((byStatus.json() as { sessions: unknown[] }).sessions).toHaveLength(0)

    const byTag = await app.server.inject({
      method: 'GET',
      url: '/api/tags',
      headers: bearer(teacherA),
    })
    const algebra = (byTag.json() as TagBody).tags.find((entry) => entry.name === 'Algebra')
    const tagged = await sessionList(teacherA, `?tag=${algebra!.id}`)
    expect((tagged.json() as { sessions: unknown[] }).sessions).toHaveLength(1)

    // A label nobody uses matches nothing rather than everything.
    const unused = await sessionList(
      teacherA,
      '?tag=00000000-0000-4000-8000-000000000000',
    )
    expect((unused.json() as { sessions: unknown[] }).sessions).toHaveLength(0)
  })

  it('never shows another teacher\'s sessions', async () => {
    const mine = await sessionList(teacherA)
    const theirs = await sessionList(teacherB)
    expect((theirs.json() as { sessions: unknown[] }).sessions).toHaveLength(0)
    expect((mine.json() as { sessions: unknown[] }).sessions.length).toBeGreaterThan(0)
    // An admin sees the school.
    const asAdmin = await sessionList(adminToken)
    expect((asAdmin.json() as { sessions: unknown[] }).sessions.length).toBeGreaterThan(0)
  })
})
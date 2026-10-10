import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, SCHEMA_VERSION, type Database } from '../src/lib/db'
import { createCourse, isEnrolled } from '../src/lib/courses'
import { addRoomMember, createRoom, getRoom, listRoomMembers } from '../src/lib/rooms'
import { createUser } from '../src/lib/users'

/**
 * Migration v6 on a database that already has something in it.
 *
 * A migration is only ever run against a file somebody has been using for a
 * while, so the interesting case is not an empty one: rooms with members, a
 * course attached to a room, a student already enrolled. The test builds that
 * world at the current schema, rewinds the file to the v5 shape by hand, and
 * opens it again — which runs the real migration statements over real rows.
 *
 * The rewind is written out rather than generated because it is the point: it is
 * what a v5 file looks like to the code that has to upgrade it.
 */
const REWIND_TO_V5 = `
  ALTER TABLE rooms ADD COLUMN course_id TEXT REFERENCES courses(id) ON DELETE SET NULL;
  UPDATE rooms
     SET course_id = (SELECT course_id FROM course_rooms WHERE room_id = rooms.id LIMIT 1);
  DROP INDEX IF EXISTS idx_room_members_room;
  CREATE INDEX IF NOT EXISTS idx_classroom_members_class ON room_members(room_id);
  ALTER TABLE room_members RENAME COLUMN room_id TO classroom_id;
  ALTER TABLE room_members RENAME TO classroom_members;
  DROP INDEX IF EXISTS idx_rooms_owner;
  CREATE INDEX IF NOT EXISTS idx_classrooms_owner ON rooms(owner_id);
  ALTER TABLE rooms RENAME TO classrooms;
  DROP TABLE IF EXISTS course_rooms;
  DROP TABLE IF EXISTS entity_tags;
  DROP TABLE IF EXISTS tags;
  ALTER TABLE tests DROP COLUMN room_id;
  ALTER TABLE live_sessions DROP COLUMN room_id;
  ALTER TABLE live_sessions DROP COLUMN name;
  -- v8's columns too: they are plain ALTERs, so re-running v8 over a file that
  -- still has them is a duplicate-column error rather than a no-op.
  ALTER TABLE tests DROP COLUMN settings;
  ALTER TABLE participations DROP COLUMN option_order;
  UPDATE app_meta SET value = '5' WHERE key = 'schema_version';
`

describe('migration v6', () => {
  let tmpDir: string
  let dbPath: string
  let db: Database
  let teacherId: string
  let studentId: string
  let courseId: string
  let roomId: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'testsys-v6-'))
    dbPath = join(tmpDir, 'app.db')
    db = openDatabase(dbPath)
    const raw = db.raw

    const teacher = createUser(raw, {
      role: 'teacher',
      status: 'approved',
      username: 'teacherA',
      password: 'teacher-pass-1',
      fullName: 'Teacher A',
    })
    teacherId = teacher.id
    const student = createUser(raw, {
      role: 'student',
      status: 'approved',
      username: 'stuOne',
      password: 'student-pass-1',
      fullName: 'Student One',
    })
    studentId = student.id
    courseId = createCourse(raw, teacherId, { title: 'Algebra 9', description: '' }).id
    const room = createRoom(raw, { ownerId: teacherId, name: 'Class 9A', courseIds: [courseId] })
    roomId = room.id
    addRoomMember(raw, room.id, studentId)
    raw.prepare(
      `INSERT INTO tests (id, owner_id, title, description, created_at, updated_at)
       VALUES ('t-1', ?, 'Fractions', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(teacherId)

    // Rewind the file to the v5 shape, the way an old install would look.
    raw.exec('PRAGMA foreign_keys = OFF')
    raw.exec(REWIND_TO_V5)
    db.close()

    db = openDatabase(dbPath)
  })

  afterAll(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs to the current version', () => {
    expect(SCHEMA_VERSION).toBe(8)
    const version = db.raw
      .prepare("SELECT value FROM app_meta WHERE key = 'schema_version'")
      .get() as { value: string }
    expect(version.value).toBe('8')
  })

  it('has rooms where classrooms used to be, with their keys intact', () => {
    const tables = (
      db.raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(tables).toContain('rooms')
    expect(tables).toContain('room_members')
    expect(tables).not.toContain('classrooms')
    expect(tables).not.toContain('classroom_members')

    const row = db.raw.prepare('SELECT name, key, status FROM rooms WHERE id = ?').get(roomId)
    expect(row).toEqual({ name: 'Class 9A', key: expect.any(String), status: 'active' })
  })

  it('keeps the members who came through the key', () => {
    const members = listRoomMembers(db.raw, roomId)
    expect(members).toHaveLength(1)
    expect(members[0]?.userId).toBe(studentId)
  })

  it('turns the one optional course into one link of many', () => {
    const room = getRoom(db.raw, roomId)
    expect(room?.courseIds).toEqual([courseId])

    const second = createCourse(db.raw, teacherId, { title: 'Geometry 9', description: '' })
    db.raw.prepare(
      'INSERT INTO course_rooms (course_id, room_id, created_at) VALUES (?, ?, ?)',
    ).run(second.id, roomId, '2026-01-01T00:00:00.000Z')
    const updated = getRoom(db.raw, roomId)
    expect(updated?.courseIds).toEqual(expect.arrayContaining([courseId, second.id]))
    // And the member is still enrolled in the course the room carried over.
    expect(isEnrolled(db.raw, courseId, studentId)).toBe(true)
  })

  it('gives tests and sessions a room and a name, without touching their data', () => {
    const columns = (
      db.raw.prepare('PRAGMA table_info(live_sessions)').all() as Array<{ name: string }>
    ).map((column) => column.name)
    expect(columns).toContain('room_id')
    expect(columns).toContain('name')

    const test = db.raw
      .prepare('SELECT title, room_id FROM tests WHERE id = ?')
      .get('t-1') as { title: string; room_id: string | null }
    expect(test.title).toBe('Fractions')
    expect(test.room_id).toBeNull()

    db.raw.prepare('UPDATE tests SET room_id = ? WHERE id = ?').run(roomId, 't-1')
    expect((db.raw.prepare('SELECT room_id FROM tests WHERE id = ?').get('t-1') as {
      room_id: string
    }).room_id).toBe(roomId)
  })

  it('adds tags that belong to a teacher and hang off an entity', () => {
    db.raw.prepare(
      "INSERT INTO tags (id, owner_id, name, created_at) VALUES ('tag-1', ?, 'Algebra', '2026-01-01T00:00:00.000Z')",
    ).run(teacherId)
    db.raw.prepare(
      `INSERT INTO entity_tags (id, tag_id, entity_type, entity_id, created_at)
       VALUES ('et-1', 'tag-1', 'test', 't-1', '2026-01-01T00:00:00.000Z')`,
    ).run()
    const linked = db.raw
      .prepare("SELECT tag_id FROM entity_tags WHERE entity_type = 'test' AND entity_id = 't-1'")
      .all() as Array<{ tag_id: string }>
    expect(linked).toEqual([{ tag_id: 'tag-1' }])

    // Same label, different case, is the same tag: an index says so.
    let duplicate = false
    try {
      db.raw.prepare(
        "INSERT INTO tags (id, owner_id, name, created_at) VALUES ('tag-2', ?, 'algebra', '2026-01-01T00:00:00.000Z')",
      ).run(teacherId)
    } catch {
      duplicate = true
    }
    expect(duplicate).toBe(true)
  })

  it('runs again on an already-migrated file without complaint', () => {
    const raw = new DatabaseSync(dbPath)
    const before = (
      raw.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get() as {
        value: string
      }
    ).value
    raw.close()
    const reopened = openDatabase(dbPath)
    const after = (
      reopened.raw.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get() as {
        value: string
      }
    ).value
    reopened.close()
    expect(after).toBe(before)
  })
})
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { randomCode } from './codes'
import { nowIso } from './db'

export type RoomStatus = 'active' | 'revoked'

export interface RoomRow {
  id: string
  owner_id: string
  name: string
  key: string
  status: RoomStatus
  created_at: string
  revoked_at: string | null
}

export interface RoomMemberRow {
  id: string
  room_id: string
  user_id: string
  joined_at: string
}

export interface Room {
  id: string
  ownerId: string
  name: string
  key: string
  status: RoomStatus
  /** Every course this room's students are enrolled in — a room can take several
   *  subjects, so this is a list and has been since v0.6.1. */
  courseIds: string[]
  createdAt: string
  revokedAt: string | null
  membersCount: number
}

/** A course a room is attached to, for the pickers. */
export interface RoomCourse {
  id: string
  title: string
}

/** A student who arrived through a room key. */
export interface RoomMember {
  userId: string
  username: string
  fullName: string
  status: string
  joinedAt: string
}

/**
 * What a student is told about a key before typing it into a form: that it is
 * real and who gave it. Deliberately not more - a key holder learns the room
 * name and the teacher's name, nothing else.
 */
export interface RoomPreview {
  roomName: string
  teacherName: string
}

function toRoom(db: DatabaseSync, row: RoomRow, membersCount: number): Room {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    key: row.key,
    status: row.status,
    courseIds: listRoomCourseIds(db, row.id),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    membersCount,
  }
}

/**
 * A key nobody has: 6 characters out of 32, which is about a billion
 * combinations. The uniqueness retry covers the birthday collision anyway,
 * because "two rooms share a key" is the one failure a teacher cannot fix.
 */
function allocateKey(db: DatabaseSync): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = randomCode()
    const taken = db.prepare('SELECT 1 FROM rooms WHERE key = ?').get(code)
    if (!taken) return code
  }
  throw new Error('could not allocate a unique room key')
}

export function createRoom(
  db: DatabaseSync,
  input: { ownerId: string; name: string; courseIds?: string[] },
): Room {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO rooms (id, owner_id, name, key, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
  ).run(id, input.ownerId, input.name, allocateKey(db), nowIso())
  if (input.courseIds && input.courseIds.length > 0) {
    setRoomCourses(db, id, input.courseIds)
  }
  return toRoom(db, findRoomById(db, id) as RoomRow, 0)
}

export function findRoomById(db: DatabaseSync, id: string): RoomRow | null {
  const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id)
  // Whole-row cast: node:sqlite types every column as SQLOutputValue, the same
  // way sessions.ts reads its rows.
  return (row as unknown as RoomRow | undefined) ?? null
}

/**
 * A key that opens a door, if it does. Revoked keys are treated as unknown on
 * purpose: telling a student "this room was closed" confirms the room exists.
 */
export function findActiveRoomByKey(db: DatabaseSync, key: string): RoomRow | null {
  const row = db.prepare("SELECT * FROM rooms WHERE key = ? AND status = 'active'").get(key)
  return (row as unknown as RoomRow | undefined) ?? null
}

function memberCount(db: DatabaseSync, roomId: string): number {
  const count = db.prepare('SELECT COUNT(*) AS total FROM room_members WHERE room_id = ?').get(roomId)
  return (count as { total: number }).total
}

/** One room with its member count - what every mutating handler returns. */
export function getRoom(db: DatabaseSync, id: string): Room | null {
  const row = findRoomById(db, id)
  if (!row) return null
  return toRoom(db, row, memberCount(db, row.id))
}

export function listRooms(db: DatabaseSync, ownerId: string | null): Room[] {
  const rows = (
    ownerId
      ? db.prepare('SELECT * FROM rooms WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId)
      : db.prepare('SELECT * FROM rooms ORDER BY created_at DESC').all()
  ) as unknown as RoomRow[]
  return rows.map((row) => toRoom(db, row, memberCount(db, row.id)))
}

export function renameRoom(db: DatabaseSync, id: string, name: string): void {
  db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(name, id)
}

export function listRoomCourseIds(db: DatabaseSync, roomId: string): string[] {
  const rows = db
    .prepare('SELECT course_id FROM course_rooms WHERE room_id = ? ORDER BY created_at')
    .all(roomId) as Array<{ course_id: string }>
  return rows.map((row) => row.course_id)
}

export function listRoomCourses(db: DatabaseSync, roomId: string): RoomCourse[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.title FROM course_rooms r
         JOIN courses c ON c.id = r.course_id
        WHERE r.room_id = ?
        ORDER BY c.title`,
    )
    .all(roomId) as unknown as RoomCourse[]
  return rows
}

/**
 * Enrols every member of the room in every course it is attached to.
 *
 * Idempotent, and called from both directions on purpose: linking a course to a
 * room catches up the students who are already here, and adding a student
 * catches up the courses that are already linked. Whichever happens last, the
 * two end up in step — which is the only reason a teacher never has to think
 * about it.
 */
export function enrolRoomMembersInCourses(db: DatabaseSync, roomId: string): void {
  const enrol = db.prepare(
    `INSERT INTO course_enrollments (id, course_id, user_id, enrolled_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(course_id, user_id) DO NOTHING`,
  )
  const timestamp = nowIso()
  const links = db
    .prepare('SELECT course_id FROM course_rooms WHERE room_id = ?')
    .all(roomId) as Array<{ course_id: string }>
  if (links.length === 0) return
  const members = db
    .prepare('SELECT user_id FROM room_members WHERE room_id = ?')
    .all(roomId) as Array<{ user_id: string }>
  for (const link of links) {
    for (const member of members) {
      enrol.run(randomUUID(), link.course_id, member.user_id, timestamp)
    }
  }
}

/** Replaces the room's courses, then catches the members up on what changed. */
export function setRoomCourses(db: DatabaseSync, roomId: string, courseIds: string[]): void {
  db.prepare('DELETE FROM course_rooms WHERE room_id = ?').run(roomId)
  const insert = db.prepare(
    'INSERT OR IGNORE INTO course_rooms (course_id, room_id, created_at) VALUES (?, ?, ?)',
  )
  for (const courseId of courseIds) {
    insert.run(courseId, roomId, nowIso())
  }
  enrolRoomMembersInCourses(db, roomId)
}

export function revokeRoom(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE rooms SET status = 'revoked', revoked_at = ? WHERE id = ?").run(nowIso(), id)
}

export function regenerateRoomKey(db: DatabaseSync, id: string): string {
  const key = allocateKey(db)
  db.prepare('UPDATE rooms SET key = ? WHERE id = ?').run(key, id)
  return key
}

export function deleteRoom(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id)
}

/**
 * Records that a student arrived through this room, and enrols them in the
 * courses it is attached to. Idempotent: registering twice from the same device
 * is a normal thing to do, and a second row would make the member count lie.
 */
export function addRoomMember(db: DatabaseSync, roomId: string, userId: string): void {
  db.prepare(
    `INSERT INTO room_members (id, room_id, user_id, joined_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(room_id, user_id) DO NOTHING`,
  ).run(randomUUID(), roomId, userId, nowIso())
  enrolRoomMembersInCourses(db, roomId)
}

export function listRoomMembers(db: DatabaseSync, roomId: string): RoomMember[] {
  const rows = db
    .prepare(
      `SELECT m.user_id, m.joined_at, u.username, u.full_name, u.status
       FROM room_members m JOIN users u ON u.id = m.user_id
       WHERE m.room_id = ?
       ORDER BY m.joined_at ASC`,
    )
    .all(roomId) as Array<{
    user_id: string
    username: string
    full_name: string
    status: string
    joined_at: string
  }>
  return rows.map((row) => ({
    userId: row.user_id,
    username: row.username,
    fullName: row.full_name,
    status: row.status,
    joinedAt: row.joined_at,
  }))
}

/** The rooms a student is a member of - the classroom side of the student home. */
export function listRoomsForUser(db: DatabaseSync, userId: string): Room[] {
  const rows = db
    .prepare(
      `SELECT r.* FROM rooms r
         JOIN room_members m ON m.room_id = r.id
        WHERE m.user_id = ?
        ORDER BY r.created_at DESC`,
    )
    .all(userId) as unknown as RoomRow[]
  return rows.map((row) => toRoom(db, row, memberCount(db, row.id)))
}

export function toRoomPreview(db: DatabaseSync, row: RoomRow): RoomPreview {
  const teacher = db
    .prepare('SELECT full_name FROM users WHERE id = ?')
    .get(row.owner_id) as { full_name: string } | undefined
  return { roomName: row.name, teacherName: teacher?.full_name ?? '' }
}
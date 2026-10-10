import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from './db'
import type { Tag } from './tags'

export interface CourseRow {
  id: string
  owner_id: string
  title: string
  description: string
  created_at: string
  updated_at: string
}

export interface Course {
  id: string
  ownerId: string
  title: string
  description: string
  materialsCount: number
  testsCount: number
  studentsCount: number
  createdAt: string
  updatedAt: string
}

export interface CourseWithRelations extends Course {
  materials: Material[]
  tests: Array<{ id: string; title: string }>
  students: Array<{ id: string; username: string; fullName: string }>
  /** The teacher's own labels; a course carries them wherever it goes. */
  tags: Tag[]
}

export interface MaterialRow {
  id: string
  course_id: string
  title: string
  file_path: string
  mime_type: string
  size_bytes: number
  created_at: string
}

export interface Material {
  id: string
  courseId: string
  title: string
  mimeType: string
  sizeBytes: number
  createdAt: string
}

interface CourseWithCountsRow extends CourseRow {
  materials_count: number
  tests_count: number
  students_count: number
}

export function toCourse(row: CourseWithCountsRow): Course {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description,
    materialsCount: row.materials_count,
    testsCount: row.tests_count,
    studentsCount: row.students_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function findCourseRow(db: DatabaseSync, id: string): CourseRow | null {
  const row = db.prepare('SELECT * FROM courses WHERE id = ?').get(id)
  return (row as CourseRow | undefined) ?? null
}

export function listCourseRows(
  db: DatabaseSync,
  ownerId: string,
  isAdmin: boolean,
): Course[] {
  const sub = `
    (SELECT COUNT(*) FROM course_enrollments e WHERE e.course_id = c.id) AS students_count,
    (SELECT COUNT(*) FROM course_tests t WHERE t.course_id = c.id) AS tests_count,
    (SELECT COUNT(*) FROM materials m WHERE m.course_id = c.id) AS materials_count`
  const base = `SELECT c.*, ${sub} FROM courses c`
  const sql = isAdmin
    ? `${base} ORDER BY c.created_at DESC`
    : `${base} WHERE c.owner_id = ? ORDER BY c.created_at DESC`
  const rows = (isAdmin
    ? db.prepare(sql).all()
    : db.prepare(sql).all(ownerId)) as unknown as CourseWithCountsRow[]
  return rows.map(toCourse)
}

/**
 * The courses a student is enrolled in. Students see only what a teacher put
 * them into; the roster of other students is never exposed.
 */
export function listEnrolledCourses(db: DatabaseSync, userId: string): Course[] {
  const sub = `
    (SELECT COUNT(*) FROM course_enrollments e2 WHERE e2.course_id = c.id) AS students_count,
    (SELECT COUNT(*) FROM course_tests t WHERE t.course_id = c.id) AS tests_count,
    (SELECT COUNT(*) FROM materials m WHERE m.course_id = c.id) AS materials_count`
  const rows = db
    .prepare(
      `SELECT c.*, ${sub}
         FROM courses c
         JOIN course_enrollments e ON e.course_id = c.id AND e.user_id = ?
        ORDER BY c.created_at DESC`,
    )
    .all(userId) as unknown as CourseWithCountsRow[]
  return rows.map(toCourse)
}

export function isEnrolled(db: DatabaseSync, courseId: string, userId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM course_enrollments WHERE course_id = ? AND user_id = ?')
    .get(courseId, userId)
  return row !== undefined
}

export function listMaterials(db: DatabaseSync, courseId: string): Material[] {
  const rows = db
    .prepare('SELECT * FROM materials WHERE course_id = ? ORDER BY created_at DESC')
    .all(courseId) as unknown as MaterialRow[]
  return rows.map((row) => ({
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  }))
}

export function createCourse(
  db: DatabaseSync,
  ownerId: string,
  input: { title: string; description: string },
): CourseRow {
  const id = randomUUID()
  const now = nowIso()
  db.prepare(
    `INSERT INTO courses (id, owner_id, title, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, ownerId, input.title.trim(), input.description.trim(), now, now)
  return findCourseRow(db, id) as CourseRow
}

export function updateCourse(
  db: DatabaseSync,
  course: CourseRow,
  input: { title: string; description: string },
): CourseRow {
  db.prepare(
    'UPDATE courses SET title = ?, description = ?, updated_at = ? WHERE id = ?',
  ).run(input.title.trim(), input.description.trim(), nowIso(), course.id)
  return findCourseRow(db, course.id) as CourseRow
}

export function deleteCourse(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM courses WHERE id = ?').run(id)
}

export function enrollStudent(db: DatabaseSync, courseId: string, userId: string): void {
  db.prepare(
    'INSERT INTO course_enrollments (id, course_id, user_id, enrolled_at) VALUES (?, ?, ?, ?)',
  ).run(randomUUID(), courseId, userId, nowIso())
}

export function unenrollStudent(db: DatabaseSync, courseId: string, userId: string): void {
  db.prepare(
    'DELETE FROM course_enrollments WHERE course_id = ? AND user_id = ?',
  ).run(courseId, userId)
}

export function attachTest(db: DatabaseSync, courseId: string, testId: string): void {
  db.prepare(
    'INSERT INTO course_tests (id, course_id, test_id, added_at) VALUES (?, ?, ?, ?)',
  ).run(randomUUID(), courseId, testId, nowIso())
}

export function detachTest(db: DatabaseSync, courseId: string, testId: string): void {
  db.prepare('DELETE FROM course_tests WHERE course_id = ? AND test_id = ?').run(
    courseId,
    testId,
  )
}

export function createMaterial(
  db: DatabaseSync,
  courseId: string,
  input: { title: string; filePath: string; mimeType: string; sizeBytes: number },
): Material {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO materials (id, course_id, title, file_path, mime_type, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    courseId,
    input.title.trim(),
    input.filePath,
    input.mimeType,
    input.sizeBytes,
    nowIso(),
  )
  const row = db
    .prepare('SELECT * FROM materials WHERE id = ?')
    .get(id) as MaterialRow | undefined
  // The row must exist: we just inserted it.
  return {
    id: row!.id,
    courseId: row!.course_id,
    title: row!.title,
    mimeType: row!.mime_type,
    sizeBytes: row!.size_bytes,
    createdAt: row!.created_at,
  }
}

export function findMaterialRow(
  db: DatabaseSync,
  id: string,
): MaterialRow | null {
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(id)
  return (row as MaterialRow | undefined) ?? null
}

export function deleteMaterial(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM materials WHERE id = ?').run(id)
}
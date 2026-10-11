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
  /** The lessons, in the order the teacher put them in. */
  topics: Topic[]
  /** What the teacher said to the class, newest first. */
  announcements: Announcement[]
  tests: Array<{ id: string; title: string; topicId: string | null }>
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
  topic_id: string | null
  created_at: string
}

export interface Material {
  id: string
  courseId: string
  title: string
  mimeType: string
  sizeBytes: number
  /** The lesson it sits under, or null when it is not part of one. */
  topicId: string | null
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
    topicId: row.topic_id ?? null,
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
    topicId: row!.topic_id ?? null,
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
// ------------------------------------------------------------------- topics

/**
 * A lesson inside a course: an ordered heading that a test or a material can
 * be put under, so a course reads as a plan rather than as whatever was uploaded
 * last.
 *
 * Nothing requires a topic. A test added on Friday and a lesson planned for
 * Monday are both real, and neither has to pretend to be the other - which is
 * why `topic_id` on both tables is nullable and a deleted topic leaves its
 * contents behind rather than taking them with it.
 */
export interface TopicRow {
  id: string
  course_id: string
  title: string
  position: number
  created_at: string
}

export interface Topic {
  id: string
  courseId: string
  title: string
  position: number
  createdAt: string
}

export function toTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    position: row.position,
    createdAt: row.created_at,
  }
}

export function findTopicRow(db: DatabaseSync, id: string): TopicRow | null {
  const row = db.prepare('SELECT * FROM course_topics WHERE id = ?').get(id)
  return (row as TopicRow | undefined) ?? null
}

/** The course's lessons in the order the teacher put them in. */
export function listTopics(db: DatabaseSync, courseId: string): Topic[] {
  const rows = db
    .prepare(
      'SELECT * FROM course_topics WHERE course_id = ? ORDER BY position ASC, created_at ASC',
    )
    .all(courseId) as unknown as TopicRow[]
  return rows.map(toTopic)
}

export function createTopic(
  db: DatabaseSync,
  courseId: string,
  input: { title: string },
): Topic {
  const id = randomUUID()
  // A new lesson goes to the end rather than the top: the teacher is adding it
  // now, and pushing their existing plan down a lesson is not what "add" means.
  const next = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM course_topics WHERE course_id = ?')
    .get(courseId) as { next: number }
  db.prepare(
    'INSERT INTO course_topics (id, course_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, courseId, input.title.trim(), next.next, nowIso())
  return toTopic(findTopicRow(db, id) as TopicRow)
}

export function updateTopic(
  db: DatabaseSync,
  topic: TopicRow,
  input: { title: string },
): Topic {
  db.prepare('UPDATE course_topics SET title = ? WHERE id = ?').run(
    input.title.trim(),
    topic.id,
  )
  return toTopic(findTopicRow(db, topic.id) as TopicRow)
}

/**
 * Puts the course's lessons in the order given.
 *
 * Written as one statement over the given ids rather than a swap per pair: two
 * lessons swapping places is a coincidence, and a drag across six of them is not.
 * Ids that are not in this course are ignored rather than obeyed - a body from
 * another tenant must not be able to renumber this one.
 */
export function reorderTopics(db: DatabaseSync, courseId: string, ids: string[]): void {
  const owned = new Set(listTopics(db, courseId).map((topic) => topic.id))
  const update = db.prepare('UPDATE course_topics SET position = ? WHERE id = ? AND course_id = ?')
  ids.forEach((id, position) => {
    if (owned.has(id)) update.run(position, id, courseId)
  })
}

export function deleteTopic(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM course_topics WHERE id = ?').run(id)
}

/** Moves a test into a lesson, or out of every lesson when `topicId` is null. */
export function setTestTopic(
  db: DatabaseSync,
  courseId: string,
  testId: string,
  topicId: string | null,
): void {
  db.prepare('UPDATE course_tests SET topic_id = ? WHERE course_id = ? AND test_id = ?').run(
    topicId,
    courseId,
    testId,
  )
}

/** The same for a material. */
export function setMaterialTopic(
  db: DatabaseSync,
  courseId: string,
  materialId: string,
  topicId: string | null,
): void {
  db.prepare('UPDATE materials SET topic_id = ? WHERE course_id = ? AND id = ?').run(
    topicId,
    courseId,
    materialId,
  )
}

// ------------------------------------------------------------- announcements

/**
 * What the teacher says to the class about a course.
 *
 * An announcement may carry a material, which is how a reading or a correction
 * sheet gets out; the body alone is enough for the common case, so the file is
 * optional rather than required. Only the author may take one down - an admin
 * can, because an admin manages the teacher too, but a second teacher who
 * happens to see the course cannot delete someone else's words to their class.
 */
export interface AnnouncementRow {
  id: string
  course_id: string
  author_id: string
  body: string
  material_id: string | null
  created_at: string
}

export interface Announcement {
  id: string
  courseId: string
  authorId: string
  authorName: string
  body: string
  material: Material | null
  createdAt: string
}

function toAnnouncement(row: AnnouncementRow, authorName: string): Announcement {
  return {
    id: row.id,
    courseId: row.course_id,
    authorId: row.author_id,
    authorName,
    body: row.body,
    material: null,
    createdAt: row.created_at,
  }
}

export function findAnnouncementRow(
  db: DatabaseSync,
  id: string,
): AnnouncementRow | null {
  const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id)
  return (row as AnnouncementRow | undefined) ?? null
}

/** Newest first: the thing a student needs today is at the top. */
export function listAnnouncements(db: DatabaseSync, courseId: string): Announcement[] {
  const rows = db
    .prepare(
      `SELECT a.*, u.full_name FROM announcements a JOIN users u ON u.id = a.author_id
        WHERE a.course_id = ? ORDER BY a.created_at DESC, a.id DESC`,
    )
    .all(courseId) as unknown as Array<AnnouncementRow & { full_name: string }>
  const materials = new Map(listMaterials(db, courseId).map((material) => [material.id, material]))
  return rows.map((row) => {
    const announcement = toAnnouncement(row, row.full_name)
    if (row.material_id === null) return announcement
    return {
      ...announcement,
      material: materials.get(row.material_id) ?? null,
    }
  })
}

export function createAnnouncement(
  db: DatabaseSync,
  courseId: string,
  authorId: string,
  input: { body: string; materialId: string | null },
): AnnouncementRow {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO announcements (id, course_id, author_id, body, material_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, courseId, authorId, input.body.trim(), input.materialId, nowIso())
  return findAnnouncementRow(db, id) as AnnouncementRow
}

export function deleteAnnouncement(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(id)
}

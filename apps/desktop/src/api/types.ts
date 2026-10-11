import type { TestSettings } from './normalize'

export type { TestSettings } from './normalize'
export type UserRole = 'admin' | 'teacher' | 'student'
export type UserStatus = 'pending' | 'approved' | 'blocked'

export interface PublicUser {
  id: string
  role: UserRole
  status: UserStatus
  username: string
  fullName: string
  createdAt: string
  updatedAt: string
}

export const ROLE_ORDER: UserRole[] = ['student', 'teacher', 'admin']

export type QuestionType =
  | 'single_choice'
  | 'multiple_choice'
  | 'true_false'
  | 'short_answer'
  | 'matching'

export const QUESTION_TYPES: QuestionType[] = [
  'single_choice',
  'multiple_choice',
  'true_false',
  'short_answer',
  'matching',
]

export interface ChoiceOption {
  key: string
  text: string
}

export interface QuestionInput {
  type: QuestionType
  body: string
  points: number
  position: number
  payload: Record<string, unknown>
}

export interface Question {
  id: string
  type: QuestionType
  body: string
  points: number
  position: number
  payload: Record<string, unknown>
}

export interface TestSummary {
  id: string
  ownerId: string
  title: string
  description: string
  timeLimitSec: number | null
  passingPercent: number | null
  /** The group this test was written for, or null when it is not tied to one. */
  roomId: string | null
  settings: TestSettings
  questionCount: number
  tags: Tag[]
  createdAt: string
  updatedAt: string
}

export interface TestDetails extends Omit<TestSummary, 'questionCount'> {
  questions: Question[]
}

export interface TestInput {
  title: string
  description?: string
  timeLimitSec?: number | null
  passingPercent?: number | null
  roomId?: string | null
  tags?: string[]
  settings?: Partial<TestSettings>
  questions?: QuestionInput[]
}

/**
 * A free label the teacher puts on tests, sessions and courses: "algebra",
 * "photosynthesis", "chapter 4". What class something belongs to is a room, not
 * a label — see `Room.roomId` on the things that carry one.
 */
export interface Tag {
  id: string
  ownerId: string
  name: string
  createdAt: string
}

export interface CourseSummary {
  id: string
  ownerId: string
  title: string
  description: string
  materialsCount: number
  testsCount: number
  studentsCount: number
  tags: Tag[]
  createdAt: string
  updatedAt: string
}

export interface CourseTopic {
  id: string
  title: string
  position: number
}

export interface Announcement {
  id: string
  authorId: string
  authorName: string
  body: string
  /** The reading or sheet that went out with it, when one did. */
  material: Material | null
  createdAt: string
}

export interface CourseDetails extends CourseSummary {
  materials: Material[]
  /** The lessons, in the order the teacher put them in. */
  topics: CourseTopic[]
  /** What the teacher said to the class, newest first. */
  announcements: Announcement[]
  tests: Array<{ id: string; title: string; topicId: string | null }>
  students: Array<{ id: string; username: string; fullName: string }>
}

export interface CourseInput {
  title: string
  description?: string
  tags?: string[]
}

export interface Material {
  id: string
  courseId: string
  title: string
  mimeType: string
  sizeBytes: number
  /** The lesson it is filed under, or null when it is not part of one. */
  topicId: string | null
  createdAt: string
}

/** One cell of the journal: a student's last attempt at one test. */
export interface JournalCell {
  /** The last percent, or null when the student never attempted this test. */
  percent: number | null
  attempts: number
  lastSubmittedAt: string | null
  /** The run the last attempt was made in; null when there is no attempt. */
  sessionId: string | null
}

export interface JournalStudent {
  userId: string
  username: string
  fullName: string
}

/** Students against tests: what a teacher wants before a lesson, not after. */
export interface Journal {
  scope: 'room' | 'course'
  title: string
  tests: Array<{ id: string; title: string }>
  students: JournalStudent[]
  /** One row of cells per student, in the same order as `students`. */
  cells: JournalCell[][]
}

export interface ParticipationEntry {
  courseId: string
  courseTitle: string
  studentId: string
  username: string
  fullName: string
  status: UserStatus
  enrolledAt: string
}

export interface TableCounts {
  users: number
  admins: number
  teachers: number
  students: number
  pendingUsers: number
  approvedUsers: number
  blockedUsers: number
  tests: number
  questions: number
  courses: number
  enrollments: number
  materials: number
}

export interface SystemStats {
  version: string
  uptimeMs: number
  schemaVersion: number
  database: 'ok' | 'error'
  counts: TableCounts
}

export interface ServerSettings {
  /** The address students are told to open, or null when not configured. */
  publicBaseUrl: string | null
  /** Addresses this machine answers on, for the admin to pick from. */
  suggestions: string[]
}

/**
 * A room is *who*: a group of students with a key that lets them register
 * without an administrator in the room. A course is *what*: a programme with
 * topics, materials and tests. The two are linked many-to-many, and a room can
 * have any number of courses.
 */
export interface Room {
  id: string
  ownerId: string
  name: string
  /** Six characters from the join-code alphabet, read aloud without 0/O or 1/I. */
  key: string
  status: 'active' | 'revoked'
  /** Every course this room's students are enrolled in. */
  courseIds: string[]
  createdAt: string
  revokedAt: string | null
  membersCount: number
}

export interface RoomMember {
  userId: string
  username: string
  fullName: string
  status: 'pending' | 'approved' | 'blocked'
  joinedAt: string
}

/** A course a room is attached to, for the picker. */
export interface RoomCourse {
  id: string
  title: string
}

export interface RoomDetail {
  room: Room
  members: RoomMember[]
  courses: RoomCourse[]
}

/** What a room key leads to, shown on the sign-up form before an account exists. */
export interface RoomPreview {
  roomName: string
  teacherName: string
}

export interface CreateRoom {
  name: string
  courseIds?: string[]
}

/** One line of the server log, as the console and the web admin both read it. */
export interface LogEntry {
  /** Monotonic per server process; `?since=` and the live tail both use it. */
  seq: number
  at: string
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  msg: string
  /** Whatever else the record carried: a request, an error, a class key. */
  fields: Record<string, unknown>
}


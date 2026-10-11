import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { deflateSync } from 'node:zlib'
import { createAsset } from './assets'
import {
  attachTest,
  createAnnouncement,
  createCourse,
  createMaterial,
  createTopic,
  setMaterialTopic,
  setTestTopic,
} from './courses'
import { addRoomMember, createRoom } from './rooms'
import { scoreSubmission, type ScoredQuestion } from './scoring'
import {
  createSession,
  joinSession,
  saveSubmission,
  setSessionStatus,
  startSession,
} from './sessions'
import { createTest, listQuestions, type QuestionInput } from './tests'
import { createUser, findUserByUsername } from './users'

/**
 * Demo data, so a fresh install can be shown without typing anything.
 *
 * It is a *flag* and a command, never something that happens on its own: real
 * work must not be seeded over, and a teacher who starts the server does not
 * expect invented courses. `seedDemo` therefore refuses a database that already
 * holds a course, a test or a room, and leaves a marker so a second call is a
 * no-op rather than a second copy.
 *
 * Everything goes through the same library functions the API calls, so the demo
 * cannot drift from the product: the run below is created, started, answered and
 * finished by the same code a real class uses. What it teaches the screenshots is
 * the point - a course with lessons, a picture in a question, and a journal with
 * numbers in it rather than a wall of dashes.
 */

export const DEMO_MARKER = 'demo_seeded'

/** Students share one password; the teacher's is the one they already have. */
export const DEMO_STUDENT_PASSWORD = 'demo-pass-1'

export interface DemoSeedOptions {
  /** Where uploads live: `<dataDir>/uploads`, the same directory the server uses. */
  uploadsDir: string
}

export interface DemoSeedResult {
  seeded: boolean
  /** Why nothing happened, when nothing did. */
  reason?: string
  /** The teacher's password is only known when the seed created the account. */
  teacher?: { username: string; password?: string }
  students?: Array<{ username: string; password: string }>
  courseId?: string
  roomId?: string
  roomKey?: string
  counts?: { tests: number; lessons: number; materials: number; journalCells: number }
}

/** Whether this database already carries the demo. */
export function isDemoSeeded(db: DatabaseSync): boolean {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(DEMO_MARKER) as
    | { value: string }
    | undefined
  return row !== undefined
}

/**
 * Why the demo would not be seeded, or null when it would.
 *
 * "Not empty" is the important one: the demo is a first-run experience, and a
 * database with one real course in it is somebody's work.
 */
export function demoRefusalReason(db: DatabaseSync): string | null {
  if (isDemoSeeded(db)) return 'the demo data is already here'
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM courses) AS courses,
              (SELECT COUNT(*) FROM tests) AS tests,
              (SELECT COUNT(*) FROM rooms) AS rooms`,
    )
    .get() as { courses: number; tests: number; rooms: number }
  if (counts.courses > 0 || counts.tests > 0 || counts.rooms > 0) {
    return 'this database already holds courses, tests or rooms'
  }
  return null
}

/** One student of the demo class, as they are created. */
const STUDENTS = [
  { username: 'demo_alina', fullName: 'Alina Kovalenko' },
  { username: 'demo_bohdan', fullName: 'Bohdan Melnyk' },
  { username: 'demo_iryna', fullName: 'Iryna Shevchenko' },
  { username: 'demo_marko', fullName: 'Marko Tkachenko' },
] as const

/**
 * The pictures and the questions they belong to.
 *
 * The questions are written as the editor would write them - keyed options and a
 * correct key - because the seed goes in through `createTest`, which is the same
 * door the API uses.
 */
const QUESTIONS: Record<string, (media: { assetId: string } | null) => QuestionInput[]> = {
  refraction: (media) => [
    {
      type: 'single_choice',
      body: 'A ray enters glass from air. Which way does it bend?',
      points: 1,
      position: 0,
      // The picture lives on the question, not in its text: a diagram is looked
      // at next to the reading, which is what 6.6 was for.
      payload: {
        ...(media ? { media } : {}),
        options: [
          { key: 'a', text: 'Towards the normal' },
          { key: 'b', text: 'Away from the normal' },
        ],
        correct: 'a',
      },
    },
    {
      type: 'single_choice',
      body: 'What happens to the speed of light in a denser medium?',
      points: 1,
      position: 1,
      payload: {
        options: [
          { key: 'a', text: 'It slows down' },
          { key: 'b', text: 'It speeds up' },
        ],
        correct: 'a',
      },
    },
  ],
  lenses: () => [
    {
      type: 'true_false',
      body: 'A convex lens brings parallel rays together.',
      points: 1,
      position: 0,
      payload: { correct: true },
    },
    {
      type: 'true_false',
      body: 'A concave lens can form a real image on a screen.',
      points: 1,
      position: 1,
      payload: { correct: false },
    },
    {
      type: 'true_false',
      body: 'The focal length is measured from the lens to the focus.',
      points: 1,
      position: 2,
      payload: { correct: true },
    },
  ],
  mirrors: () => [
    {
      type: 'multiple_choice',
      body: 'Which of these are properties of a plane mirror image?',
      points: 2,
      position: 0,
      payload: {
        options: [
          { key: 'a', text: 'Same size' },
          { key: 'b', text: 'Upside down' },
          { key: 'c', text: 'As far behind as in front' },
          { key: 'd', text: 'Magnified' },
        ],
        correct: ['a', 'c'],
      },
    },
    {
      type: 'multiple_choice',
      body: 'Which surfaces reflect light regularly?',
      points: 2,
      position: 1,
      payload: {
        options: [
          { key: 'a', text: 'Polished metal' },
          { key: 'b', text: 'Rough paper' },
          { key: 'c', text: 'Still water' },
          { key: 'd', text: 'Wool' },
        ],
        correct: ['a', 'c'],
      },
    },
  ],
  diagrams: () => [
    {
      type: 'matching',
      body: 'Match the part of the diagram to what it does.',
      points: 2,
      position: 0,
      payload: {
        pairs: [
          { left: 'Normal', right: 'Perpendicular to the surface' },
          { left: 'Incident ray', right: 'Arrives at the surface' },
        ],
      },
    },
  ],
  shortAnswers: () => [
    {
      type: 'short_answer',
      body: 'What is the law that says the angle of reflection equals the angle of incidence?',
      points: 1,
      position: 0,
      payload: { accepted: ['the law of reflection', 'reflection law'] },
    },
    {
      type: 'short_answer',
      body: 'Name the point where parallel rays meet after a convex lens.',
      points: 1,
      position: 1,
      payload: { accepted: ['focus', 'focal point'] },
    },
  ],
}

/** The answers the demo students give to the exit ticket, in order. */
const SUBMISSIONS: Array<{ username: string; answers: Array<string | null>; seconds: number[] }> = [
  // Alina got both right, and took her time on the diagram.
  { username: 'demo_alina', answers: ['a', 'a'], seconds: [38, 21] },
  // Bohdan rushed the first one and got it wrong - the second cell of the
  // journal is why a cell is a score and not a pat on the head.
  { username: 'demo_bohdan', answers: ['b', 'a'], seconds: [9, 14] },
  { username: 'demo_iryna', answers: ['a', null], seconds: [52, 0] },
]

/**
 * Seeds the demo, or explains why it did not.
 *
 * A single transaction: a demo that half-arrived would be worse than none, since
 * it would leave a database that refuses to seed again and has nothing to show.
 */
export function seedDemo(db: DatabaseSync, options: DemoSeedOptions): DemoSeedResult {
  const refusal = demoRefusalReason(db)
  if (refusal !== null) return { seeded: false, reason: refusal }

  mkdirSync(options.uploadsDir, { recursive: true })

  db.exec('BEGIN')
  try {
    const result = build(db, options)
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(DEMO_MARKER, new Date().toISOString())
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function build(db: DatabaseSync, options: DemoSeedOptions): DemoSeedResult {
  // The built-in teacher, or one made here if the console was never used to set
  // a password. The demo does not invent an admin: the project seeds a teacher
  // on purpose.
  const existingTeacher = findUserByUsername(db, 'teacher')
  const teacherPassword = process.env.TEACHER_PASSWORD ?? 'teacher'
  const teacher =
    existingTeacher ??
    createUser(db, {
      role: 'teacher',
      status: 'approved',
      username: 'teacher',
      password: teacherPassword,
      fullName: 'Demo Teacher',
    })

  const students = STUDENTS.map((student) =>
    createUser(db, {
      role: 'student',
      status: 'approved',
      username: student.username,
      password: DEMO_STUDENT_PASSWORD,
      fullName: student.fullName,
    }),
  )

  const course = createCourse(db, teacher.id, {
    title: 'Physics, grade 9',
    description: 'Light and lenses - the first block of the term.',
  })

  const firstLesson = createTopic(db, course.id, { title: 'Lesson 1: rays' })
  const secondLesson = createTopic(db, course.id, { title: 'Lesson 2: lenses' })

  // The picture a question points at, written the way an upload writes one: bytes
  // in the uploads directory, a row that names the file.
  const picture = writePicture(options.uploadsDir)
  const asset = createAsset(db, teacher.id, {
    title: 'Refraction diagram',
    filePath: picture.fileName,
    mimeType: 'image/png',
    sizeBytes: picture.sizeBytes,
  })

  const tests = [
    { key: 'refraction', title: 'Refraction: exit ticket', lesson: firstLesson.id, limit: 600 },
    { key: 'lenses', title: 'Lenses: true or false', lesson: secondLesson.id, limit: null },
    { key: 'mirrors', title: 'Mirrors: multiple choice', lesson: null, limit: null },
    { key: 'diagrams', title: 'Ray diagrams: matching', lesson: null, limit: null },
    { key: 'shortAnswers', title: 'Optics: short answers', lesson: null, limit: null },
  ].map((entry) => {
    const row = createTest(
      db,
      teacher.id,
      {
        title: entry.title,
        description: '',
        timeLimitSec: entry.limit,
        passingPercent: entry.key === 'refraction' ? 50 : null,
      },
      QUESTIONS[entry.key]!(entry.key === 'refraction' ? { assetId: asset.id } : null),
    )
    attachTest(db, course.id, row.id)
    // A test filed under a lesson is what the course screen groups; the rest
    // stay loose, which is shown at the end rather than hidden.
    if (entry.lesson !== null) setTestTopic(db, course.id, row.id, entry.lesson)
    return { key: entry.key, id: row.id, title: entry.title }
  })

  const reading = createMaterial(db, course.id, {
    title: 'Ray diagram',
    filePath: picture.fileName,
    mimeType: 'image/png',
    sizeBytes: picture.sizeBytes,
  })
  setMaterialTopic(db, course.id, reading.id, firstLesson.id)

  createAnnouncement(db, course.id, teacher.id, {
    body: 'Bring a ruler on Friday - we measure the angles.',
    materialId: reading.id,
  })

  const room = createRoom(db, { ownerId: teacher.id, name: 'Grade 9-A', courseIds: [course.id] })
  for (const student of students) addRoomMember(db, room.id, student.id)

  // One finished run, so the journal has a column with numbers in it. The rest of
  // the tests stay planned and never run: an empty cell is a fact the screen is
  // built to show.
  const exitTicket = tests.find((test) => test.key === 'refraction')
  const journalCells = exitTicket ? runExitTicket(db, teacher.id, exitTicket.id, room.id, students) : 0

  return {
    seeded: true,
    // Only named when this seed made the account: printing a password the
    // teacher set themselves would be a lie, and the wrong one at that.
    teacher: {
      username: teacher.username,
      ...(existingTeacher === null ? { password: teacherPassword } : {}),
    },
    students: students.map((student) => ({
      username: student.username,
      password: DEMO_STUDENT_PASSWORD,
    })),
    courseId: course.id,
    roomId: room.id,
    roomKey: room.key,
    counts: { tests: tests.length, lessons: 2, materials: 1, journalCells },
  }
}

/**
 * The run, end to end, through the same functions the API calls.
 *
 * It is finished on purpose: a run left open would be the student's current one
 * and would follow them around the app.
 */
function runExitTicket(
  db: DatabaseSync,
  teacherId: string,
  testId: string,
  roomId: string,
  students: Array<{ id: string; username: string }>,
): number {
  const session = createSession(db, {
    testId,
    ownerId: teacherId,
    timeLimitSec: 600,
    passingPercent: 50,
    name: 'Exit ticket - refraction',
    roomId,
  })
  startSession(db, session.id)
  const questions = listQuestions(db, testId)
  const scoreable: ScoredQuestion[] = questions.map((question) => ({
    id: question.id,
    type: question.type,
    payload: question.payload,
    points: question.points,
  }))
  const settings = session.settings

  let submitted = 0
  for (const plan of SUBMISSIONS) {
    const student = students.find((candidate) => candidate.username === plan.username)
    if (!student) continue
    const participation = joinSession(
      db,
      session.id,
      student.id,
      questions.map((question) => ({ id: question.id, payload: question.payload })),
      settings,
    )
    // The answers are keyed by question id, the shape the runner sends, so the
    // stored attempt is the one a student would have produced.
    const answers: Record<string, unknown> = {}
    questions.forEach((question, index) => {
      const given = plan.answers[index] ?? null
      if (given === null) return
      answers[question.id] = question.type === 'single_choice' ? { key: given } : {}
    })
    const timings: Record<string, { timeMs: number; changed: number }> = {}
    questions.forEach((question, index) => {
      timings[question.id] = { timeMs: (plan.seconds[index] ?? 0) * 1000, changed: index === 0 ? 1 : 0 }
    })
    const graded = scoreSubmission(scoreable, answers, session.passingPercent)
    saveSubmission(db, participation.id, 'submitted', graded.results, answers, graded.summary, timings)
    submitted += 1
  }

  setSessionStatus(db, session.id, 'finished')
  return submitted
}

/** A small PNG that reads as a diagram, written the way an upload writes bytes. */
function writePicture(uploadsDir: string): { fileName: string; sizeBytes: number } {
  const width = 480
  const height = 320
  const bytes = diagramPng(width, height)
  const fileName = 'demo-refraction-diagram.png'
  writeFileSync(join(uploadsDir, fileName), bytes)
  return { fileName, sizeBytes: bytes.length }
}

/**
 * A bar chart, drawn by hand: white paper, a dark frame and axis, three bars.
 *
 * It is generated rather than shipped so the demo has no binary in the
 * repository, and it is a *readable* picture rather than a coloured square -
 * the screenshots have to show a diagram somebody can look at.
 */
function diagramPng(width: number, height: number): Buffer {
  const paper: [number, number, number] = [0xfd, 0xfb, 0xff]
  const ink: [number, number, number] = [0x3a, 0x35, 0x40]
  const bars: Array<[number, number, number]> = [
    [0x67, 0x50, 0xa4],
    [0x2f, 0x6d, 0x5e],
    [0xb3, 0x26, 0x1e],
  ]

  const axisY = height - 48
  const left = 56
  const right = width - 40
  const barWidth = Math.floor((right - left) / (bars.length * 2))
  const maxBarHeight = axisY - 48

  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let colour = paper
      // The frame.
      if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) colour = ink
      // The axis.
      if (y >= axisY && y <= axisY + 2 && x > 24 && x < width - 24) colour = ink
      // The bars.
      for (const [index, bar] of bars.entries()) {
        const barLeft = left + index * barWidth * 2
        const barRight = barLeft + barWidth
        const heightOfBar = Math.round(maxBarHeight * (0.45 + index * 0.25))
        const barTop = axisY - heightOfBar
        if (x >= barLeft && x < barRight && y >= barTop && y < axisY) colour = bar
      }
      const at = (y * width + x) * 3
      pixels[at] = colour[0]
      pixels[at + 1] = colour[1]
      pixels[at + 2] = colour[2]
    }
  }

  // A PNG is a signature, a header, the deflated scanlines and an end marker.
  const crcTable: number[] = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc = (buffer: Buffer): number => {
    let c = 0xffffffff
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'ascii')
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, sum])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour

  // Each scanline is one filter byte, zero, then the pixels.
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    pixels.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

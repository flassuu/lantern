import { DatabaseSync } from 'node:sqlite'
import { createUser } from './users'

export interface Database {
  /** Set when an empty database was seeded with the first teacher account. */
  seededTeacherWarning: string | null
  raw: DatabaseSync
  close(): void
}

export function nowIso(): string {
  return new Date().toISOString()
}

export const SCHEMA_VERSION = 8

const MIGRATIONS: Array<{ version: number; up: string }> = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS app_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    up: `
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        role          TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
        status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'blocked')),
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        full_name     TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
    `,
  },
  {
    version: 3,
    up: `
      CREATE TABLE IF NOT EXISTS tests (
        id              TEXT PRIMARY KEY,
        owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        time_limit_sec  INTEGER,
        passing_percent INTEGER,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tests_owner ON tests(owner_id);

      CREATE TABLE IF NOT EXISTS questions (
        id       TEXT PRIMARY KEY,
        test_id  TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        type     TEXT NOT NULL CHECK (type IN ('single_choice', 'multiple_choice', 'true_false', 'short_answer', 'matching')),
        body     TEXT NOT NULL,
        payload  TEXT NOT NULL,
        points   INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL,
        UNIQUE (test_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_questions_test ON questions(test_id);

      CREATE TABLE IF NOT EXISTS courses (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_courses_owner ON courses(owner_id);

      CREATE TABLE IF NOT EXISTS course_enrollments (
        id          TEXT PRIMARY KEY,
        course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        enrolled_at TEXT NOT NULL,
        UNIQUE (course_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS course_tests (
        id        TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        test_id   TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        added_at  TEXT NOT NULL,
        UNIQUE (course_id, test_id)
      );

      CREATE TABLE IF NOT EXISTS materials (
        id         TEXT PRIMARY KEY,
        course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        file_path  TEXT NOT NULL,
        mime_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_materials_course ON materials(course_id);
    `,
  },
  {
    version: 4,
    up: `
      -- A live session is one run of a test that students join with a short code.
      CREATE TABLE IF NOT EXISTS live_sessions (
        id               TEXT PRIMARY KEY,
        test_id          TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        owner_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        join_code        TEXT NOT NULL UNIQUE,
        status           TEXT NOT NULL CHECK (status IN ('active', 'paused', 'finished')),
        -- Snapshots of the test settings, so editing the test mid-run is harmless.
        time_limit_sec   INTEGER,
        passing_percent  INTEGER,
        created_at       TEXT NOT NULL,
        started_at       TEXT NOT NULL,
        finished_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_live_sessions_owner ON live_sessions(owner_id);
      CREATE INDEX IF NOT EXISTS idx_live_sessions_status ON live_sessions(status);

      CREATE TABLE IF NOT EXISTS participations (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status         TEXT NOT NULL CHECK (status IN ('joined', 'submitted', 'auto_submitted')),
        -- JSON array of question ids: the per-student order stays stable on reload.
        question_order TEXT NOT NULL,
        score          INTEGER,
        max_score      INTEGER,
        percent        INTEGER,
        passed         INTEGER,
        joined_at      TEXT NOT NULL,
        submitted_at   TEXT,
        UNIQUE (session_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_participations_session ON participations(session_id);
      CREATE INDEX IF NOT EXISTS idx_participations_user ON participations(user_id);

      CREATE TABLE IF NOT EXISTS participation_answers (
        id               TEXT PRIMARY KEY,
        participation_id TEXT NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
        question_id      TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        payload          TEXT NOT NULL,
        is_correct       INTEGER NOT NULL,
        points_awarded   INTEGER NOT NULL,
        UNIQUE (participation_id, question_id)
      );
      CREATE INDEX IF NOT EXISTS idx_answers_participation ON participation_answers(participation_id);
    `,
  },
  {
    version: 5,
    up: `
      -- A classroom is a teacher's own group: a key a student can register with,
      -- so a teacher alone can get their class in without an admin in the room.
      CREATE TABLE IF NOT EXISTS classrooms (
        id         TEXT PRIMARY KEY,
        owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        -- Same alphabet as join codes: read aloud, no 0/O or 1/I.
        key        TEXT NOT NULL UNIQUE,
        status     TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        -- Optional: everyone who arrives through this class joins the course too.
        course_id  TEXT REFERENCES courses(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_classrooms_owner ON classrooms(owner_id);

      -- Who came in through which class. A join table rather than a column on
      -- users: one student can pass through several classes over a school year.
      CREATE TABLE IF NOT EXISTS classroom_members (
        id           TEXT PRIMARY KEY,
        classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at    TEXT NOT NULL,
        UNIQUE (classroom_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_classroom_members_class ON classroom_members(classroom_id);
    `,
  },
  {
    version: 6,
    up: `
      -- A room is who and a course is what. The class table becomes rooms, a room
      -- and a course link many-to-many (a group takes several subjects, a subject
      -- is taken by several groups), tests and sessions can be pointed at a room,
      -- and a free label - subject or topic - hangs off all three.
      --
      -- Renames go through ALTER TABLE rather than a copy: SQLite rewrites the
      -- referencing foreign keys itself, and a rebuild would have to remember to
      -- rebuild every one of them by hand.
      ALTER TABLE classrooms RENAME TO rooms;
      ALTER TABLE classroom_members RENAME TO room_members;
      ALTER TABLE room_members RENAME COLUMN classroom_id TO room_id;

      -- The indexes kept the old names; they describe columns that no longer have
      -- those names, and nobody greps for them again once they are gone.
      DROP INDEX IF EXISTS idx_classrooms_owner;
      DROP INDEX IF EXISTS idx_classroom_members_class;
      CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(owner_id);
      CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id);

      -- A join table with a composite key, like a relation rather than a row: it
      -- is never addressed on its own, only as "this room in this course".
      CREATE TABLE IF NOT EXISTS course_rooms (
        course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (course_id, room_id)
      );
      CREATE INDEX IF NOT EXISTS idx_course_rooms_room ON course_rooms(room_id);

      -- The single optional course a room used to carry becomes one link of many.
      INSERT OR IGNORE INTO course_rooms (course_id, room_id, created_at)
      SELECT course_id, id, created_at FROM rooms WHERE course_id IS NOT NULL;
      ALTER TABLE rooms DROP COLUMN course_id;

      ALTER TABLE tests ADD COLUMN room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL;
      ALTER TABLE live_sessions ADD COLUMN room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL;
      ALTER TABLE live_sessions ADD COLUMN name TEXT;

      CREATE TABLE IF NOT EXISTS tags (
        id         TEXT PRIMARY KEY,
        owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      -- Case-insensitive uniqueness: "Algebra" and "algebra" are one tag, and a
      -- filter that returned both would look like a bug.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_owner_name ON tags(owner_id, lower(name));

      CREATE TABLE IF NOT EXISTS entity_tags (
        id          TEXT PRIMARY KEY,
        tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('test', 'session', 'course')),
        entity_id   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE (tag_id, entity_type, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_entity_tags_entity ON entity_tags(entity_type, entity_id);
    `,
  },
  {
    version: 7,
    up: `
      -- A session now opens in a lobby: it exists, students can walk in and see
      -- the room assemble, and the clock does not start until the teacher presses
      -- Start. So 'lobby' joins the statuses and started_at becomes nullable -
      -- and SQLite cannot widen a CHECK in place, so the table is rebuilt.
      --
      -- defer_foreign_keys is what makes the rebuild safe inside this
      -- transaction. participations points at live_sessions, and a rebuild has
      -- to drop that table while its children exist; with the checks deferred,
      -- they are resolved once at COMMIT, by which time the name is back.
      -- foreign_keys itself cannot be toggled here - SQLite ignores it inside a
      -- transaction - which is exactly why this pragma exists.
      PRAGMA defer_foreign_keys = ON;

      CREATE TABLE live_sessions_new (
        id               TEXT PRIMARY KEY,
        test_id          TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        owner_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        join_code        TEXT NOT NULL UNIQUE,
        status           TEXT NOT NULL CHECK (status IN ('lobby', 'active', 'paused', 'finished')),
        -- Snapshots of the test settings, so editing the test mid-run is harmless.
        time_limit_sec   INTEGER,
        passing_percent  INTEGER,
        name             TEXT,
        room_id          TEXT REFERENCES rooms(id) ON DELETE SET NULL,
        -- While set, nobody new may join; the students already in are untouched.
        entry_locked     INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        started_at       TEXT,
        finished_at      TEXT
      );
      INSERT INTO live_sessions_new
        (id, test_id, owner_id, join_code, status, time_limit_sec, passing_percent,
         name, room_id, entry_locked, created_at, started_at, finished_at)
        SELECT id, test_id, owner_id, join_code, status, time_limit_sec, passing_percent,
               name, room_id, 0, created_at, started_at, finished_at
          FROM live_sessions;
      DROP TABLE live_sessions;
      ALTER TABLE live_sessions_new RENAME TO live_sessions;
      CREATE INDEX IF NOT EXISTS idx_live_sessions_owner ON live_sessions(owner_id);
      CREATE INDEX IF NOT EXISTS idx_live_sessions_status ON live_sessions(status);

      -- Leaving the window is recorded, not punished: one row per visibility
      -- change, so a teacher can see the shape of a run afterwards without the
      -- student having been blocked or auto-submitted for walking away.
      CREATE TABLE IF NOT EXISTS participation_events (
        id               TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        participation_id TEXT NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
        kind             TEXT NOT NULL CHECK (kind IN ('visible', 'hidden')),
        created_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_participation_events_session ON participation_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_participation_events_participation ON participation_events(participation_id);
    `,
  },
  {
    version: 8,
    up: `
      -- What a teacher decides about a run: shuffle, when answers are revealed,
      -- when results are released, and one question at a time. JSON rather than a
      -- column per option, because these are a bag of choices that grow and
      -- share one lifetime - and each one is read whole, never queried.
      ALTER TABLE tests ADD COLUMN settings TEXT;
      ALTER TABLE live_sessions ADD COLUMN settings TEXT;
      -- The snapshot a session takes of the test's defaults when it is created.
      ALTER TABLE live_sessions ADD COLUMN results_released INTEGER NOT NULL DEFAULT 0;
      -- A student's own option order, per question, when options are shuffled:
      -- fixed at join so a reload shows the same paper, not a new shuffle.
      ALTER TABLE participations ADD COLUMN option_order TEXT;
    `,
  },
]

function migrate(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  )
  const row = db
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get('schema_version') as { value: string } | undefined
  const current = row ? Number(row.value) : 0

  for (const migration of MIGRATIONS) {
    if (migration.version > current) {
      db.exec('BEGIN')
      try {
        db.exec(migration.up)
        db.prepare(
          'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).run('schema_version', String(migration.version))
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }
}

/**
 * Seeds the first teacher account on an empty database.
 *
 * A teacher, not an admin: one person with a laptop runs a class, and making
 * them create an admin first was ceremony with no purpose. The admin role still
 * exists for institution-wide accounts — `admin` can create one, or the console
 * `promote` command can — but nobody has to have one to teach.
 *
 * Credentials come from TEACHER_USERNAME / TEACHER_PASSWORD. ADMIN_USERNAME /
 * ADMIN_PASSWORD still work as fallbacks so existing scripts and installs keep
 * running. Returns what it did instead of printing it: a line written with
 * `console` never reaches the log stream, so on the desktop it would arrive as
 * plain text with no level and be shown as an error. The caller logs it.
 */
export function seedTeacher(db: DatabaseSync): string | null {
  const existing = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('teacher')
  if (existing) return null

  const username = process.env.TEACHER_USERNAME ?? process.env.ADMIN_USERNAME ?? 'teacher'
  const password =
    process.env.TEACHER_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'teacher'
  const fromEnv = Boolean(process.env.TEACHER_PASSWORD ?? process.env.ADMIN_PASSWORD)
  createUser(db, {
    role: 'teacher',
    status: 'approved',
    username,
    password,
    fullName: 'Teacher',
  })
  if (!fromEnv) {
    return `seeded the first teacher account '${username}'/'${password}' — set TEACHER_PASSWORD to choose your own`
  }
  return null
}

export function openDatabase(dbPath: string): Database {
  const raw = new DatabaseSync(dbPath)
  raw.exec('PRAGMA journal_mode = WAL;')
  raw.exec('PRAGMA foreign_keys = ON;')
  migrate(raw)
  const seeded = seedTeacher(raw)
  return {
    raw,
    /** A warning the caller should log; null when there is nothing to say. */
    seededTeacherWarning: seeded,
    close() {
      raw.close()
    },
  }
}

export function checkDatabase(db: Database): boolean {
  return schemaVersion(db) === SCHEMA_VERSION
}

export function schemaVersion(db: Database): number {
  try {
    const row = db.raw
      .prepare('SELECT value FROM app_meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined
    return row ? Number(row.value) : 0
  } catch {
    return 0
  }
}
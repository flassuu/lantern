# Database schema

Schema of the system at v0.6.0 and later. SQLite via `node:sqlite` (`DatabaseSync`);
ids are server-side UUIDs; timestamps are stored as ISO-8601 UTC strings. The
schema is enforced by idempotent, versioned migrations run at server startup;
`GET /api/admin/stats` reports the applied version as `schemaVersion`.

> Status: **current**, at version 8. Phases 1–3 added the tables: roles and
> auth, the test/course core, and the live-session runtime.
> **Reporting (Phase 4) added no tables on purpose** — the grade journal and
> per-question difficulty are derived from `participations` and
> `participation_answers`, which already record who answered what and whether
> it was right. Storing an aggregate would only add a second source of truth
> that has to be recomputed every time a session is graded.
> **Phase 5.1 added no tables either** — `app_meta` was already a key/value
> store, so the public address is one row.
> **Phase 5.2 (v5)** adds the class key and who arrived through it.
> **Phase 6.1 (v6)** renames those two tables to `rooms` and `room_members` — a
> room is *who*, a course is *what*, and the two are no longer allowed to look
> alike — and adds `course_rooms`, `tags` and `entity_tags`. `tests.room_id`,
> `live_sessions.room_id` and `live_sessions.name` join the rest.
> **Phase 6.3 (v7)** makes a session open in a `lobby`: `status` gains the value,
> `started_at` becomes nullable, `entry_locked` joins the row, and
> `participation_events` records when a student's window was hidden or shown.
> **Phase 6.4 (v8)** gives a run options: `tests.settings` holds a teacher's
> defaults, `live_sessions.settings` the snapshot a run takes of them,
> `live_sessions.results_released` whether held results have been let out, and
> `participations.option_order` a student's own shuffled option order.

## Conventions

- `id` — `TEXT` UUID (server-side generated).
- `created_at` / `updated_at` — `TEXT` ISO-8601 UTC.
- Every foreign key is `ON DELETE CASCADE`, so removing a test takes its
  questions and sessions with it; uniqueness is enforced where it matters.
- Enums are stored as `TEXT` with a `CHECK` constraint (survives binary
  recompilation without codegen).

## Tables

### users

Accounts for all three roles. The built-in **admin is seeded** on first run
(bootstrap account, see migrations).

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| role | TEXT | `admin \| teacher \| student` |
| status | TEXT | `pending \| approved \| blocked` |
| username | TEXT UNIQUE | login |
| password_hash | TEXT | salted scrypt hash (`node:crypto`, no dependency) |
| full_name | TEXT | display name (the teacher's full name) |
| created_at / updated_at | TEXT | ISO-8601 UTC |

- **Admin** is seeded by the system at first startup; cannot be deleted.
- **Teachers** are created by an admin (status `approved` immediately).
- **Students** register themselves → status `pending` until an **administrator**
  approves them (the status endpoint is admin-only). `blocked` revokes access
  and invalidates every token.

### courses

Teacher-created containers of materials and tests (Google Classroom style).

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| owner_id | TEXT FK users.id | creating teacher |
| title | TEXT | |
| description | TEXT | |
| created_at / updated_at | TEXT | |

### course_enrollments

Links students to courses.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| course_id | TEXT FK courses.id | |
| user_id | TEXT FK users.id | student |
| enrolled_at | TEXT | |
| UNIQUE (course_id, user_id) | | no duplicate enrollments |

### materials

Files attached to a course (PDF, images, …), served as static files.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| course_id | TEXT FK courses.id | |
| title | TEXT | |
| file_path | TEXT | relative to data dir |
| mime_type | TEXT | |
| size_bytes | INTEGER | |
| created_at | TEXT | |

### tests

A test is a set of questions; it can be shared directly or via courses.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| owner_id | TEXT FK users.id | creating teacher |
| title | TEXT | |
| description | TEXT | |
| time_limit_sec | INTEGER | nullable — no time limit |
| passing_percent | INTEGER | admin/teacher configurable threshold |
| room_id | TEXT FK rooms.id | nullable; the group this paper was written for |
| settings | TEXT | the teacher's run defaults, as JSON; NULL means the defaults |
| created_at / updated_at | TEXT | |

### questions

Five supported types, stored uniformly with JSON payloads.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| test_id | TEXT FK tests.id | |
| type | TEXT | `single_choice \| multiple_choice \| true_false \| short_answer \| matching` |
| body | TEXT | question text |
| payload | TEXT JSON | options + correct answer(s), per type |
| points | INTEGER | score for a fully correct answer |
| position | INTEGER | ordering inside the test |
| UNIQUE (test_id, position) | | stable ordering |

Payload shapes (draft):

- `single_choice` / `multiple_choice` — `{ options: [{key, text}], correct: [key] | key }`
- `true_false` — `{ correct: boolean }`
- `short_answer` — `{ accepted: string[] }` (case-insensitive compare)
- `matching` — `{ pairs: [{left, right}], keys: [{key, text}] }`

### app_meta

Key/value settings. Holds the migration bookkeeping and the server's own
configuration, so adding a setting needs no migration.

| Column | Type | Notes |
|--------|------|-------|
| key | TEXT PK | e.g. `schema_version`, `public_base_url` |
| value | TEXT | applied version, or the setting value |

Settings stored here:

| Key | Meaning |
|-----|---------|
| `public_base_url` | The address students open, or empty for "not configured". See [`GET /api/settings`](./api.md#settings-apisettings). |

### sessions

Auth tokens. One row per signed-in client; the token is stored hashed.

| Column | Type | Notes |
|--------|------|-------|
| token_hash | TEXT PK | sha256 of the opaque token |
| user_id | TEXT FK users.id | cascades on delete |
| created_at | TEXT | |
| expires_at | TEXT | 12 h after login |

> Name clash worth knowing: the **live** session of a test is `live_sessions`
> below, not this table.

### live_sessions

One live run of a test, started by a teacher and joined by students with a
short code. Created already `active` — there is no draft state.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| test_id | TEXT FK tests.id | cascades |
| owner_id | TEXT FK users.id | teacher who started it |
| join_code | TEXT UNIQUE | 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no ambiguous 0/O or 1/I) |
| status | TEXT | `lobby \| active \| paused \| finished` |
| time_limit_sec | INTEGER | snapshot of the test at start |
| passing_percent | INTEGER | snapshot of the test at start |
| name | TEXT | what the teacher called this run; NULL falls back to the test title |
| room_id | TEXT FK rooms.id | the group sitting it; defaults to the test's own room |
| entry_locked | INTEGER | 1 while no *new* student may join; the ones inside stay |
| settings | TEXT | the run's options, snapshotted from the test when it was created |
| results_released | INTEGER | 1 once held results have been let out |
| created_at | TEXT | |
| started_at | TEXT | NULL until the teacher starts the run: the lobby has no clock |
| finished_at | TEXT | nullable |

### participation_events

Leaving the window, recorded rather than punished. One row per visibility
*change* — not per heartbeat — so the record is the shape of the run and not a
list of the same sentence repeated every few seconds. The live "on question 3"
state is not here: it changes too fast to be worth a row, and means nothing once
the run is over.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| session_id | TEXT FK → live_sessions(id) | `ON DELETE CASCADE` |
| participation_id | TEXT FK → participations(id) | `ON DELETE CASCADE` |
| kind | TEXT | `CHECK IN ('visible', 'hidden')` |
| created_at | TEXT | |

The snapshots are deliberate: editing the test while a session runs changes
nothing for the students already answering.

### participations

One row per student who joined a session, holding their personal question
order and their result.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| session_id | TEXT FK live_sessions.id | cascades |
| user_id | TEXT FK users.id | cascades |
| status | TEXT | `joined \| submitted \| auto_submitted` |
| question_order | TEXT JSON | array of question ids — the per-student shuffle, fixed at join so a reload never reshuffles |
| option_order | TEXT JSON | map of question id to that student's option order; NULL when options are not shuffled |
| score | INTEGER | points earned, nullable until submitted |
| max_score | INTEGER | points on offer |
| percent | INTEGER | `round(score / max_score × 100)` |
| passed | INTEGER | 0/1, **NULL when the test has no pass mark** |
| joined_at | TEXT | |
| submitted_at | TEXT | nullable |
| UNIQUE (session_id, user_id) | | one participation per student |

### participation_answers

The submitted paper, one graded row per question. Rewritten on every
submission, so a student who resubmits before the session closes does not
accumulate rows.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| participation_id | TEXT FK participations.id | cascades |
| question_id | TEXT FK questions.id | cascades |
| payload | TEXT JSON | the raw answer, per question type |
| is_correct | INTEGER | 0/1 |
| points_awarded | INTEGER | |
| UNIQUE (participation_id, question_id) | | one answer per question |

## Relationship overview

```
users ─┬─ owns ──▶ courses ──┬─ has ──▶ materials
       │         │            ├─ enrolls ─▶ course_enrollments ─▶ users (student)
       │         │            └─ runs ───▶ course_tests ─────────▶ tests
       ├─ owns ──▶ tests ──▶ questions
       ├─ owns ──▶ rooms ──┬─ members ─▶ room_members ─▶ users (student)
       │                   └─ course_rooms ─▶ courses
       └─ owns ──▶ tags ───▶ entity_tags (test | session | course)
       ├─ signs in ─▶ sessions            (auth tokens, hashed)
       └─ runs ────▶ live_sessions ──▶ participations ──▶ participation_answers ──▶ questions
```

### rooms

A teacher's own group of students, held for its key: a student who registers with
it is approved without an admin. *Who*, where a course is *what* — the room
carries a key, and what the group studies is a separate relation, so a class can
take several subjects and a subject can be taken by several classes.

Renamed from `classrooms` in v6.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| owner_id | TEXT FK → users(id) | the teacher; `ON DELETE CASCADE` |
| name | TEXT | as typed, trimmed |
| key | TEXT UNIQUE | 6 chars from the join-code alphabet |
| status | TEXT | `active` or `revoked` |
| created_at | TEXT | |
| revoked_at | TEXT | NULL until revoked |

### room_members

Who arrived through which key. A join table rather than a column on `users`: one
student can pass through several rooms over a school year, and a teacher needs
the list per room.

Renamed from `classroom_members` in v6.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| room_id | TEXT FK → rooms(id) | `ON DELETE CASCADE` |
| user_id | TEXT FK → users(id) | `ON DELETE CASCADE` |
| joined_at | TEXT | |
| | UNIQUE(room_id, user_id) | registering twice does not double-count |

### course_rooms

What a room studies. Many-to-many, added in v6, replacing the single optional
`rooms.course_id` it grew out of. The composite key is the whole identity: this
row is only ever addressed as "this room in this course".

| Column | Type | Notes |
|--------|------|-------|
| course_id | TEXT FK → courses(id) | `ON DELETE CASCADE` |
| room_id | TEXT FK → rooms(id) | `ON DELETE CASCADE` |
| created_at | TEXT | |
| | PRIMARY KEY(course_id, room_id) | |

Enrolment follows this table in both directions: attaching a course to a room
enrols the members already in it, and adding a member enrols them in every
course already attached. Whichever happens last, the two are in step.

### tags

The teacher's own free labels — "algebra", "photosynthesis", "chapter 4". Not a
group: what class something belongs to is `room_id`, because a room can be joined
and revoked and a label cannot.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| owner_id | TEXT FK → users(id) | the teacher; `ON DELETE CASCADE` |
| name | TEXT | |
| created_at | TEXT | |
| | UNIQUE(owner_id, lower(name)) | "Algebra" and "algebra" are one label |

### entity_tags

Which labels are on which thing. Added in v6. A tag carries no permission of
its own: attaching one still requires permission on the entity, and that is
checked by the routes, not here.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| tag_id | TEXT FK → tags(id) | `ON DELETE CASCADE` |
| entity_type | TEXT | `CHECK IN ('test','session','course')` |
| entity_id | TEXT | no foreign key: the three kinds have three different owners |
| created_at | TEXT | |
| | UNIQUE(tag_id, entity_type, entity_id) | |

## Migration notes

- v1 creates `app_meta`.
- v2 creates `users` (with the built-in admin seed) and `sessions`.
- v3 creates `tests`, `questions`, `courses`, `course_enrollments`,
  `course_tests`, `materials`.
- v4 creates `live_sessions`, `participations`, `participation_answers`.
- v5 creates the class key and its members.
- v6 renames them to `rooms` and `room_members`, adds `course_rooms`, `tags` and
  `entity_tags`, and adds `tests.room_id`, `live_sessions.room_id`,
  `live_sessions.name`. The existing single course link is copied into
  `course_rooms` before `rooms.course_id` is dropped.
- v7 rebuilds `live_sessions` — SQLite cannot widen a `CHECK` in place — to let
  `status` be `lobby` and `started_at` be null, and adds `entry_locked` and
  `participation_events`. The rebuild drops a parent table that `participations`
  references, so it runs with `PRAGMA defer_foreign_keys = ON`: the checks are
  resolved once, at COMMIT, by which time the table is back under its own name.
- v8 adds the settings columns (`tests.settings`, `live_sessions.settings`,
  `live_sessions.results_released`) and `participations.option_order`. Settings
  are JSON rather than a column per option: they are a bag of choices that grow,
  share one lifetime, and are read whole, never queried.
- v9 adds `live_sessions.paused_at`: a pause stamps it, a resume moves
  `started_at` forward by the length of the hold, so one clock serves the board
  and every phone without either keeping its own tally.
- v10 gives the attempt a shape of its own — `participation_answers.time_ms`,
  `answered_at`, `changed`, and `participations.total_time_ms`, `focus_lost`.
  The change count is there because a rewritten answer is not the confident one
  it looks like, and `focus_lost` is the server's own count of the `hidden`
  events it already records, so it cannot be edited by the student it describes.
  All of it is nullable or zero-valued where it is not known: an attempt from a
  client that never measured stores null, and `null` must not read as zero.
- Migrations run idempotently at startup, in order; each is wrapped in a
  transaction and versioned in `schema_migrations`.

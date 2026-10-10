# API Reference

Conventions: REST + JSON, errors as `{ "error": { "code", "message" } }`
(validation failures → `400 VALIDATION`), realtime over WebSocket at `/ws`.
Auth uses `Authorization: Bearer <token>`; tokens are opaque, DB-backed
sessions valid for 12 hours.

CORS is enabled (`@fastify/cors`, origin reflected) so browser-based clients
on other origins — including the Tauri desktop webview (`tauri://localhost`),
which is a different origin from `http://localhost:3300` — can call the API
directly. The desktop app therefore always targets the local Node server at
its API base (`VITE_API_TARGET` at build time, default `http://localhost:3300`);
the Vite dev proxy is only a convenience for `pnpm dev:web` / `dev:desktop`.

## Health

### `GET /api/health`

Probe used by clients to confirm the local server is up. Public.

```json
{
  "status": "ok",
  "version": "0.5.1",
  "database": "ok",
  "uptime_ms": 1234,
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

## Authentication (`/api/auth`)

### `POST /api/auth/register`

Student self-registration. Public.

Request body:

```json
{
  "username": "student1", "password": "secret-pass-1", "fullName": "Student One",
  "roomKey": "42FAK2"
}
```

- `roomKey` is optional. Without it the account is `pending` and waits for an
  approval — from an admin, or from a teacher (see
  [`GET /api/users/pending`](#get-apiuserspending)). With a valid
  [room key](#rooms-apirooms) it is `approved` immediately, the room records the
  student, and they are enrolled in every course the room is attached to — a
  teacher can run a class alone.
- Only a student role is ever created, whatever the body contains.

Response:

```json
{
  "user": { "id": "…", "role": "student", "status": "approved" },
  "viaClass": { "className": "Class 9A", "teacherName": "Olena M." }
}
```

`viaClass` is `null` when no key was used.

- `409 CONFLICT` — username already taken
- `400 INVALID_CLASS_KEY` — a key was typed but is wrong or revoked. Nothing is
  created, so the name stays free and the student can fix the code.
- `400 VALIDATION` — missing/invalid fields

### `POST /api/auth/login`

Verifies credentials and issues a role-scoped bearer token. Public.

Request body:

```json
{ "username": "teacher", "password": "teacher" }
```

- `200` → `{ "token": "<opaque>", "user": {...} }`
- `401 INVALID_CREDENTIALS` — bad username/password
- `403 PENDING_APPROVAL` / `403 BLOCKED` — account not usable

### `POST /api/auth/password`

Changes the signed-in account's own password. Any role.

```json
{ "currentPassword": "old-pass-1", "newPassword": "new-pass-1" }
```

The current password is required, so a borrowed session cannot lock the owner
out. On success **every** session of that account is ended and a new token is
returned — including the one that made the change, so the client must store it:

```json
{ "token": "…", "user": { … } }
```

- `401 INVALID_CREDENTIALS` — the current password is wrong
- `400 VALIDATION` — missing fields, or a new password under 8 characters

This is what makes the desktop app's "Teacher password" setting work on a data
folder that already exists: `TEACHER_PASSWORD` is read once, when the folder has
no teacher yet.

### First boot: the account is a teacher

An empty data folder is seeded with **one teacher**, not an admin. One person
with a laptop runs a class; making them create an admin first was ceremony with
no purpose.

- `TEACHER_USERNAME` / `TEACHER_PASSWORD` set the credentials. Defaults:
  `teacher` / `teacher`, and the default is logged as a warning.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` still work as fallbacks, so existing
  installs and scripts keep running.
- A **console** `admin <username> <password>` command creates an admin later, for
  the institution-wide screens (full roster, stats, participants). Nobody has to
  have one to teach.

### `POST /api/auth/logout`

Revokes the current session. Requires a valid token. → `204`.

### `GET /api/auth/me`

Returns the logged-in user. Requires a valid token.

```json
{ "user": { "id": "…", "role": "student", "status": "approved", "username": "student1", "fullName": "Student One", "createdAt": "…", "updatedAt": "…" } }
```

## User management (`/api/users`)

The full roster is admin-only. Two endpoints are open to a teacher, because a
class run without an admin has to still be able to seat a student and read the
log: [`GET /api/users/pending`](#get-apiuserspending) and
[`PATCH /api/users/:id/status`](#patch-apiusersidstatus).

Users are returned without password material: `{ id, role, status, username, fullName, createdAt, updatedAt }`.

### `GET /api/users`

List users. Query: `role` (`admin|teacher|student`), `status`
(`pending|approved|blocked`), `q` (substring on username/fullName).

```json
{ "users": [ { "user": {...} } ] }
```

### `POST /api/users`

Admin creates a teacher (approved immediately). Request body like
`register`; role is always `teacher`.

- `201` → `{ "user": {...} }`
- `409 CONFLICT` — username already taken

### `GET /api/users/pending`

Admin **or teacher**. Students who registered without a class key and are waiting
to be let in. Only ever pending students, never the roster.

```json
{ "users": [ { "id": "…", "username": "student1", "status": "pending", … } ] }
```

The teacher's **Classes** tab shows this list with an Approve / Refuse pair for
each entry. Without it, a student who typed no key waits for an admin that a lone
setup does not have.

### `PATCH /api/users/:id/status`

Approve or block an account. Body:
`{ "status": "pending" | "approved" | "blocked" }`. Blocking revokes all
active sessions for that user. Admin accounts are immutable.

- **Admin** — any non-admin account.
- **Teacher** — students only. A teacher who could block another teacher could
  lock a colleague out of a room they share the server with, so `403` is the
  answer for any non-student target.

- `200` → `{ "user": {...} }`
- `400 INVALID_OPERATION` — target is an admin account
- `403 FORBIDDEN` — a teacher aimed at a teacher or admin
- `404 NOT_FOUND` — no such user

### `DELETE /api/users/:id`

Admin removes a teacher or student (sessions cascade). Admin accounts are
immutable. → `204`.

## Tests (`/api/tests`, admin & teacher)

A test belongs to its creator; admins see everything, teachers only their own.
Questions carry a per-type `payload`:

| Type | Payload |
|------|---------|
| `single_choice` | `{ "options": [{ "key", "text" }], "correct": "key" }` |
| `multiple_choice` | `{ "options": [{ "key", "text" }], "correct": ["key", ...] }` |
| `true_false` | `{ "correct": boolean }` |
| `short_answer` | `{ "accepted": ["Paris", ...] }` |
| `matching` | `{ "pairs": [{ "left", "right" }, ...] }` |

### `GET /api/tests`

List own tests (admin: all). → `{ "tests": [{ id, ownerId, title, description, timeLimitSec, passingPercent, questionCount, createdAt, updatedAt }] }`

### `POST /api/tests`

Create a test. Body:

```json
{
  "title": "Intro quiz",
  "description": "First test",
  "timeLimitSec": 600,
  "passingPercent": 60,
  "roomId": "…",
  "tags": ["Algebra", "Year 9"],
  "questions": [{ "type": "single_choice", "body": "…", "points": 2, "position": 0, "payload": { "options": [{ "key": "a", "text": "A" }, { "key": "b", "text": "B" }], "correct": "a" } }]
}
```

- `201` → full test with questions, its `roomId` and its `tags`
- `400 VALIDATION` — any question payload is invalid, or `roomId` names a room
  the requester does not own

`roomId` and `tags` are optional on create and on `PUT`. Duplicating a test
keeps both: a copy is the same paper for the same class, and a stranger that has
to be set up again is not a copy.

### `GET /api/tests/:id`

- `200` → `{ "test": { ...test, "questions": [...] } }`
- `403` — not the owner (non-admin) · `404`

### `PUT /api/tests/:id`

Replaces title/limits and **all** questions (positions must stay 0-based
sequential). Same body and errors as `POST`.

### `DELETE /api/tests/:id`

Removes the test; questions cascade. → `204`.

### `GET /api/tests/:id/export`

The test as a shareable file: `application/json` with a
`content-disposition` filename. No ids, no owner, no timestamps — and the
answer keys, because a colleague has to be able to run it.

```json
{
  "format": "knowledge-testing.test",
  "version": 1,
  "title": "Photosynthesis",
  "description": "Grade 9",
  "timeLimitSec": 600,
  "passingPercent": 60,
  "questions": [{ "type": "true_false", "body": "…", "points": 1, "position": 0, "payload": { "correct": true } }]
}
```

### `POST /api/tests/:id/duplicate`

`201` with the copy: owned by the caller, titled `<original> (copy)`, with fresh
question ids so the two tests are independent. → `403` for another teacher's
test · `404`.

### `POST /api/tests/import`

Reads a file written by the export and creates the test for the caller. The
body is the export document; `format` and `version` must match, positions are
renumbered from the array order, and every question goes through the editor's
own validation.

- `201` → the created test with its questions
- `400 VALIDATION` — not a test file, an unsupported version, no title, no
  questions, or a question that fails validation (the message says which and
  why: `question 2: …`)

### `GET /api/tests/:id/results`

Grade journal for one test, aggregated over **every** session it was run in.
Attempts still in progress are ignored. Both class figures are judged on each
student's last attempt, so a student who improved since the first try is not
counted as a fail; `passRate` is `null` when the test has no pass mark rather
than reading as 0 percent.

```json
{
  "test": { "id": "…", "title": "Photosynthesis", "passingPercent": 50 },
  "students": 2, "submissions": 3, "averagePercent": 50, "passRate": 67,
  "journal": [{ "userId": "…", "username": "ana", "fullName": "Ana K.",
                "attempts": 2, "bestPercent": 100, "lastPercent": 25,
                "lastPassed": false, "averagePercent": 63, "lastSubmittedAt": "…" }],
  "questions": [{ "questionId": "…", "body": "…", "type": "true_false", "points": 1,
                  "answers": 24, "correct": 7, "percent": 29 }]
}
```

`questions` lists every question of the test, including ones nobody has answered
yet (`answers: 0`). → `403` for a student or another teacher · `404`.

## Courses (`/api/courses`, admin & teacher)

A course groups materials (files) and tests, and enrolls students.

### `GET /api/courses`

Own courses (admin: all), each with `materialsCount`, `testsCount`,
`studentsCount`. → `{ "courses": [...] }`

### `POST /api/courses` / `PATCH /api/courses/:id`

Body: `{ "title": "Physics 101", "description": "…", "tags": ["Subject"] }`.
`POST` → `201`. `GET /api/courses/:id` returns the full course with `materials`,
`tests` (`{ id, title }`), `students` (`{ id, username, fullName }`) and
`tags`.

### `DELETE /api/courses/:id`

Removes the course and its enrollments/links/materials. → `204`.

### Enrollments

- `POST /api/courses/:id/enrollments` with `{ "username": "student1" }` →
  `201` (student must exist with status `approved`); `409 CONFLICT` if already
  enrolled; `400 INVALID_OPERATION` otherwise.
- `DELETE /api/courses/:id/enrollments/:userId` → `204`.

### Attach / detach tests

- `POST /api/courses/:id/tests` with `{ "testId": "…" }` → `201`;
  `409 CONFLICT` when already attached.
- `DELETE /api/courses/:id/tests/:testId` → `204`.

### Materials

- `POST /api/courses/:id/materials?name=notes.pdf` — raw body
  (`Content-Type: application/octet-stream`, no multipart). → `201`
  `{ id, courseId, title, mimeType, sizeBytes, createdAt }`. 100 MiB cap;
  MIME detected from the extension (pdf, images, office, zip, …).
- `GET /api/courses/:id/materials/:materialId/file` — streams the file back
  with its MIME type and `Content-Disposition: attachment`.

## Admin insights (`/api/admin`, admin only)

### `GET /api/admin/stats`

Aggregated DB health and table counts — the admin "System & DB" screen.

```json
{
  "stats": {
    "version": "0.5.1",
    "uptimeMs": 1234,
    "schemaVersion": 5,
    "database": "ok",
    "counts": {
      "users": 5, "admins": 1, "teachers": 1, "students": 3,
      "pendingUsers": 1, "approvedUsers": 4, "blockedUsers": 0,
      "tests": 2, "questions": 7, "courses": 2,
      "enrollments": 4, "materials": 2
    }
  }
}
```

### `GET /api/admin/participants`

Flat course → student participation list (the admin "Participants" screen).

```json
{
  "participants": [
    { "courseId": "…", "courseTitle": "Physics 101", "studentId": "…",
      "username": "student1", "fullName": "Student One",
      "status": "approved", "enrolledAt": "2026-01-01T00:00:00.000Z" }
  ]
}
```

Ordered by course title, then enrollment date.

## Settings (`/api/settings`)

`publicBaseUrl` is the address students open. It is what the join link and the QR
code are built from, so it has to be an address the teacher's own machine cannot
reach on its own: `localhost`, `127.0.0.1` and `tauri://localhost` all work on
the teacher's desk and none of them work on a phone. When it is unset, clients
fall back to the origin they are served from, which is exactly the wrong address
in both of the real setups — so the teacher UI says so out loud.

### `GET /api/settings`

Any signed-in role: the teacher's Live tab needs the address to build a link, and
the admin's System screen needs the same value plus what to choose from.

```json
{
  "publicBaseUrl": "http://192.168.1.65:3300",
  "suggestions": ["http://192.168.1.65:3300", "http://172.20.0.14:3300"]
}
```

`publicBaseUrl` is `null` when unset. `suggestions` are the IPv4 addresses this
machine answers on, each with the port the server actually bound. Loopback is
excluded on purpose: offering `127.0.0.1` as a suggestion would be exactly the
wrong advice. IPv6 is left out — a link-local address needs a scope suffix no
phone camera will type in.

### `PATCH /api/settings`

Admin **or teacher**. Returns the same object as the GET.

A teacher needs this: the value goes into the QR their students scan, so a
teacher running a lesson on a machine with no admin on it would otherwise be
unable to make a single phone connect.

```json
{ "publicBaseUrl": "http://192.168.1.65:3300" }
```

- `null` (or an empty string) clears the setting.
- The value is normalised on the way in: case, a default port and a trailing slash
  are dropped, so `http://host:3300/` and `http://host:3300` are the same setting.
- Rejected with `400 VALIDATION` and a message naming the problem: not absolute,
  a scheme other than `http`/`https`, a path, a query, a fragment, credentials in
  the URL, or more than 200 characters. Unknown fields are stripped rather than
  rejected, which is Fastify's default AJV behaviour.

The value lives in `app_meta` under `public_base_url`; a value that is not
currently valid is treated as unset rather than trusted.

## Rooms (`/api/rooms`)

A **room** is one teacher's group of students. It exists to hold a six-character
key that a student can register with: with a valid key the account is approved on
the spot, so a teacher can seat a class without an administrator in the room.

A room is *who*; a **course** is *what* it studies. The two were the same column
until 0.6.1 and are now separate: a room links to any number of courses, and a
course can be taken by any number of rooms.

The key is drawn from the same alphabet as a join code (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`,
no `0`/`O`/`1`/`I`), so it can be read aloud in class. It accepts only a student
role — the role is fixed in the registration handler, so no key, however it was
obtained, produces anything else.

- The read is authenticated for teachers and admins; a student is refused.
- A teacher sees only their own rooms. Another teacher's room answers `403`
  for read, update, revoke, key and delete alike. An admin sees all.
- Registering through a key **approves** the account; registering without one is
  unchanged (`pending`, waiting for an admin).
- A wrong key and a revoked key both answer `404 NOT_FOUND` with the same
  message, so a key cannot be used to find out which rooms existed.

### `GET /api/rooms`

```json
{
  "rooms": [
    {
      "id": "…", "ownerId": "…", "name": "9A",
      "key": "42FAK2", "status": "active",
      "courseIds": ["…"], "createdAt": "…", "revokedAt": null,
      "membersCount": 12
    }
  ]
}
```

### `POST /api/rooms`

```json
{ "name": "9A", "courseIds": ["…"] }
```

`courseIds` is optional and may be empty. A course the requester does not own is
rejected with `400 VALIDATION` rather than silently ignored — attaching a room
to someone else's course would enrol your students into their roll.

### `GET /api/rooms/:id`

The room, its students, and the courses it is attached to.

```json
{
  "room": { "id": "…", "name": "9A", "membersCount": 1 },
  "members": [
    { "userId": "…", "username": "olena", "fullName": "Olena M.",
      "status": "approved", "joinedAt": "…" }
  ],
  "courses": [{ "id": "…", "title": "Algebra 9" }]
}
```

### `PATCH /api/rooms/:id`

`{ "name": "…", "courseIds": ["…"] }` — rename, change the linked courses, or
both; send whichever fields you mean. The key and the existing members are
untouched.

Enrolment follows the courses both ways: attaching a course enrols the members
already in the room, and a member who arrives later is enrolled in every course
already attached. Enrolling the same student twice is refused with `409`.

### `POST /api/rooms/:id/revoke`

Sets `status: "revoked"` and stamps `revoked_at`. Nobody can register with the key
afterwards; the accounts that already came in are untouched.

### `POST /api/rooms/:id/key`

Issues a **new** key and returns it. The old one stops working immediately — this
is the fix for a code that was photographed and left on a wall.

### `DELETE /api/rooms/:id`

Removes the room and its member rows, and the links to its courses. The student
accounts and the course enrolments stay.

### `GET /api/rooms/preview?key=…`

**Public.** What a key leads to, so the sign-up form can say "9A · Olena M."
before a student types a password. No account is created and nothing is recorded.

```json
{ "preview": { "roomName": "9A", "teacherName": "Olena M." } }
```

A key holder learns the room name and the teacher's name, and nothing else.

## Tags (`/api/tags`)

A **tag** is one of the teacher's own free labels — "algebra", "photosynthesis",
"chapter 4" — put on a test, a session or a course.

Deliberately only labels: what class something belongs to is `roomId`, not a tag,
because a room can be joined, revoked and enrolled, and a label cannot. Tags
carry no permission of their own; attaching one still requires permission on the
thing itself, and a tag another teacher created is never visible here.

Labels are per teacher and case-insensitive: "Algebra" and "algebra" are one tag.

### `GET /api/tags`

```json
{ "tags": [{ "id": "…", "ownerId": "…", "name": "Algebra", "createdAt": "…" }] }
```

### `POST /api/tags`

`{ "name": "Algebra" }` → `201 { "tag": { … } }`. Returns the existing tag when
the name is already in use, rather than failing: one word, one label.

### `PATCH /api/tags/:id` · `DELETE /api/tags/:id`

Rename or remove one of the teacher's own labels. Removing it unlinks it from
everything it was on; the tests and sessions themselves are untouched. Another
teacher's label answers `403`.

### `PUT /api/tags/:entity/:id`

The one call the UI makes: `{ "names": ["Algebra", "Year 9"] }` puts exactly these
labels on that thing.

`:entity` is `test`, `session` or `course`; anything else is `400`. Names the
teacher has not used before are created, names that are no longer listed lose
their link, and the answer is the state that resulted rather than the request:

```json
{ "tags": [{ "id": "…", "name": "Algebra", "ownerId": "…", "createdAt": "…" }] }
```

A missing entity answers `404`; somebody else's answers `403`, and nothing is
written on the way out.

## Live sessions (`/api/sessions`)



A **session** is one live run of a test. A teacher starts it, students join
with a six-character code, answer, and the server grades and stores the paper.

A session snapshots the test's time limit and pass mark at start, so editing
the test mid-run changes nothing for the students already answering. It is
created already `active`; `PATCH` moves it to `paused` or `finished`.

Every entry point that grades or closes a session also sweeps expired
participations: once the time limit has passed, anyone still working is
auto-submitted with zero and the session closes. A teacher who forgets to end
a session therefore costs nobody their attempt.

### Answer payload

Answers are keyed by **question id**, so the shuffled order never matters. One
flat shape per question type:

| Type | Body |
|------|------|
| `single_choice` | `{ "key": "a" }` — the chosen option key |
| `multiple_choice` | `{ "keys": ["a", "c"] }` |
| `true_false` | `{ "boolean": true }` |
| `short_answer` | `{ "text": "oxygen" }` |
| `matching` | `{ "pairs": [{ "left": "Cat", "right": "Animal" }] }` |

Unanswered or malformed answers score zero. Short answers are compared trimmed,
whitespace-collapsed and case-insensitively against the accepted list;
multiple choice is an exact set match, and duplicate keys never collapse into a
match.

### `GET /api/sessions`

Admin & teacher. The teacher's own sessions; an admin sees every teacher's.
Every query parameter is optional.

Narrowing: `room`, `test`, `status`, `from`, `to` (ISO dates), `q` (matches the
run name and the test title) and `tag` (a tag id).

Ordering and paging: `sort` (`created` | `name` | `status` | `submitted`,
default `created`), `dir` (`asc` | `desc`, default `desc`), `limit` (1–200,
default 50) and `offset`. Ties are broken down to the id, so the order is total
and a later page can never repeat a row from an earlier one.

```json
{ "sessions": [ { "id": "…", "joinCode": "JV8Z9B", "status": "active",
                  "timeLimitSec": 600, "passingPercent": 50,
                  "name": "Monday revision", "roomId": "…",
                  "title": "Mixed quiz", "questionCount": 5,
                  "joinedCount": 2, "submittedCount": 1,
                  "tags": [{ "id": "…", "name": "Algebra" }] } ],
  "total": 137 }
```

`total` is what the *filter* matches, not the size of the page: it is what a
library counts pages against. Sorting by `name` sorts by what the card shows —
the run's name, or the test title when the run was not named.

A tag that exists but is on nothing answers with an empty list, not with an
error — a filter that matched nothing is a result, not a failure.

### `GET /api/sessions/:id`

Admin & teacher (owner). One session in the same shape the list returns, so a
screen that arrived at it directly gets the name, the room, the labels and the
counts without a list call first. `404` for no such session, `403` for another
teacher's.

### `POST /api/sessions`

Admin & teacher. Body `{ "testId": "…", "name": "…", "roomId": "…", "tags": ["…"] }`
→ `201` with the new session.

`name` is what the teacher called this run; when it is omitted the test title
stands in. `roomId` defaults to the test's own room, so the common case — a paper
written for one group, run in front of that group — needs no decision at all.

- `400 VALIDATION` — the test has no questions yet, or `roomId` names no room
- `403 FORBIDDEN` — the test, or the room, belongs to another teacher

### `GET /api/sessions/:id/participants`

Admin & teacher (owner). The live board: the session plus one row per student.

```json
{ "session": { "id": "…", "status": "active", "…": "…" },
  "participants": [ { "userId": "…", "username": "student1",
                      "fullName": "Student One", "status": "submitted",
                      "score": 6, "percent": 75, "passed": true,
                      "joinedAt": "…", "submittedAt": "…" } ] }
```

`passed` is `null` when the test has no pass mark. `status` is `joined` while
the student is still working, then `submitted` or `auto_submitted`.

### `PATCH /api/sessions/:id`

Admin & teacher (owner). Body `{ "status": "paused" | "active" | "finished" }`
→ `200` with the session. `409 CONFLICT` once it is finished.

### `GET /api/sessions/:id/review`

Admin & teacher (owner). The paper **with** the answer key, for the teacher's
own review screen. Students never receive this payload.

### `POST /api/sessions/join`

Student only. Body `{ "code": "JV8Z9B" }` → `201`. Case and stray spaces are
normalised, so a code read out in class or pasted from a slide works.

```json
{ "participation": { "id": "…", "status": "joined", "questionOrder": ["…"] },
  "session": { "id": "…", "status": "active", "timeLimitSec": 600,
               "passingPercent": 50, "startedAt": "…", "serverNow": "…" },
  "questions": [ { "id": "…", "type": "single_choice", "body": "Capital?",
                   "points": 2, "position": 0,
                   "payload": { "options": [{ "key": "a", "text": "Kyiv" }] } } ] }
```

`serverNow` lets the client correct its clock for the round trip. The payload
carries **no answer key**: `correct` is stripped from choices, `accepted` from
short answers. Re-joining returns the same participation and the same order.

- `404 NOT_FOUND` — no session with that code
- `409 CONFLICT` — the session is finished or paused

### `GET /api/sessions/current`

Student only. The session **still in progress** with the same shape as `join`,
so a reload lands back on the same paper. Only a participation with status
`joined` counts: a finished attempt is history, not something to resume, and the
student home shows it in the results list instead. `404 NOT_FOUND` when nothing
is running.

### `POST /api/sessions/:id/submit`

Student only. Body `{ "answers": { "<questionId>": … } }`.

```json
{ "participation": { "status": "submitted", "…": "…" },
  "result": { "score": 6, "maxScore": 8, "percent": 75, "passed": true } }
```

- `403 FORBIDDEN` — the student never joined
- `409 CONFLICT` — already submitted, or the session is over

### `GET /api/sessions/:id/result`

Student only, their own participation. `409 CONFLICT` before submitting.
Returns the graded paper, each question with `isCorrect`, `pointsAwarded` and
**the answer key**, so the student can learn from the result.

### `GET /api/student/results`

Student only. The student's own finished attempts (status `joined` excluded),
newest first, capped at 50 — the results list on the student home.

```json
{ "results": [{ "participationId": "…", "sessionId": "…", "joinCode": "ABC123",
                "testId": "…", "testTitle": "Photosynthesis", "questionCount": 2,
                "status": "submitted", "score": 4, "maxScore": 4,
                "percent": 100, "passed": true, "submittedAt": "…" }] }
```

`passed` is `null` for a test without a pass mark, which the client shows as a
neutral "Completed" rather than a failure.

### `GET /api/sessions/:id/results.csv`

Admin & teacher (owner). The session as a spreadsheet: `text/csv; charset=utf-8`
with a `content-disposition` filename, a header block (test, join code, status,
start/finish, pass mark), a blank line, then one row per participant with
score, percent, pass and submission time. Fields containing a comma or a quote
are quoted, and the file starts with a UTF-8 BOM so spreadsheet apps read
non-ASCII names correctly.

Because the API authenticates with an `Authorization` header rather than a
cookie, a plain `<a href>` to this endpoint is rejected — the client fetches it
with the token and saves it as a blob.

→ `403` for another teacher's session · `404`

## Reporting

Two endpoints cover what a teacher needs after a run, and they answer different
questions:

| Question | Endpoint |
|----------|----------|
| How did the class do, and which question needs reteaching? | `GET /api/tests/:id/results` — the journal plus per-question difficulty, across every session of that test |
| Give me the sheet for this session | `GET /api/sessions/:id/results.csv` — one row per participant |

Both are teacher-or-admin, scoped to what the caller owns. The journal is what
the app's report screen renders; the CSV is meant to leave the app.

## Logs (`/api/logs`, `/ws/server`)

The same log lines the terminal console prints, for a client that has no
terminal: the desktop console, and the admin **Server** tab.

**Admin or teacher, never a student.** A log names who signed in, which accounts
exist and what failed — on a teacher's machine that is the list a student must
not read. A teacher gets it because they are the one standing in front of the
class who needs to know why a phone could not connect.

### `GET /api/logs?since=<seq>`

```json
{
  "entries": [
    {
      "seq": 412,
      "at": "2026-10-07T10:14:22.104Z",
      "level": "info",
      "msg": "request completed",
      "fields": {
        "req": { "method": "GET", "url": "/api/tests", "statusCode": 200 },
        "responseTimeMs": 3
      }
    }
  ],
  "lastSeq": 412
}
```

- `since` returns only lines newer than that sequence number, so a reconnecting
  client asks for exactly what it missed. Omit it for the whole buffer (the last
  500 lines).
- `fields.req` is trimmed to method, url and status; an error keeps its message
  but not its stack; nothing else on the record is dropped.
- **`token=` never appears in a line.** Browsers cannot set headers on a
  WebSocket handshake, so the token travels in the query string and Fastify logs
  the whole URL; the value is replaced with `…` before anything is written.
- Reading the log is itself logged, so the buffer grows between two calls: `since`
  is about sequence numbers, not about how many lines come back.

### `GET /ws/server?token=<token>&since=<seq>`

The live tail over the same buffer. One socket carries both halves: the backlog
the client missed, then each new line as it happens.

| Message | Meaning |
|---------|---------|
| `{ "type": "backlog", "entries": [ … ], "lastSeq": 412 }` | the lines newer than `since` |
| `{ "type": "entry", "entry": { … } }` | one new line |
| `{ "type": "error", "code": "…", "message": "…" }` | then the socket closes |

Rejections close with a code: `4401` unauthenticated, `4403` not an admin.

## Realtime (`/ws`)


### `GET /ws/sessions/:id`

A WebSocket carrying the session live. Browsers cannot set headers on a
WebSocket handshake, so the token travels in the query string:
`/ws/sessions/<id>?token=<token>`.

| Message | Sent to | Meaning |
|---------|---------|---------|
| `{ "type": "status", "status": "active", "serverNow": "…" }` | everyone in the session | state on connect and on every change |
| `{ "type": "participants", "participants": [ … ] }` | teachers only | the board, on connect and after every join, submit, pause, resume, finish and timeout sweep |
| `{ "type": "error", "code": "…", "message": "…" }` | the offender | then the socket closes |

Rejections close with a code rather than connecting silently: `4401`
unauthenticated, `4403` not your session (a student who never joined, or a
teacher who does not own it), `4404` unknown session.

## Roles & access

| Endpoint | Admin | Teacher | Student |
|----------|:-----:|:-------:|:-------:|
| `POST /api/auth/register` | + | + | + (student only, `roomKey` optional) |
| `POST /api/auth/login` | + | + | + |
| `POST /api/auth/logout`, `GET /api/auth/me` | + | + | + |
| `GET/POST /api/users`, `DELETE /api/users/:id` | + | – | – |
| `GET /api/users/pending` | + | + | – |
| `PATCH /api/users/:id/status` | + (any non-admin) | + (students only) | – |
| `GET /api/logs`, `GET /ws/server` | + | + | – |
| `/api/tests`, `/api/tests/:id`, `/api/courses*` | + | + (own) | – |
| `GET /api/tests/:id/results` | + | + (own) | – |
| `GET/POST /api/sessions`, `PATCH /api/sessions/:id`, `…/participants`, `…/review`, `…/results.csv` | + | + (own) | – |
| `POST /api/sessions/join`, `GET /api/sessions/current`, `/:id/submit`, `/:id/result`, `/api/student/results` | – | – | + |
| `GET /ws/sessions/:id` | + (board) | + (board) | + (status only) |
| `/api/admin/stats`, `/api/admin/participants` | + | – | – |
| `/api/rooms*` | + | + (own) | – (preview is public) |
| `/api/tags*` | + | + (own) | – |
| `GET /api/logs`, `/ws/server` | + | – | – |
| `GET /api/settings` | + | + | + |
| `PATCH /api/settings` | + | + | – |

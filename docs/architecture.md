# Architecture

The Knowledge Testing System is an **offline-first, role-based application** for
running classroom knowledge tests entirely on a local network. A single
application serves an **Administrator**, **Teachers**, and **Students**; the
chosen role unlocks different functionality. No internet connection is
required — all data lives inside the classroom LAN.

## Roles

| Role | Entry points | Capabilities |
|------|--------------|--------------|
| **Administrator** | Desktop app (with embedded console) or headless CLI | Hosts the system: runs the embedded server, manages the database, users and participants, sees all data. The central point every other client connects to. |
| **Teacher** | Desktop app and/or web app on `localhost` | Creates and edits tests, shares them with students, builds courses and rooms (like Google Classroom) with materials, reviews statistics, grade journals and per-session reports. May prepare tests offline and sync them later. |
| **Student** | Web app on a phone/PC (PWA) or desktop app | Takes tests, views own statistics, and reads materials from assigned courses. (Forums — a future idea, out of scope for v1.) |

One client, many roles — the frontend is a single codebase whose features are
gated by the logged-in role.

## Topology

```
┌────────────────────────────────────────────┐
│ Admin machine — hosts the whole system      │
│  Tauri admin client (console + admin panel) │
│               │ spawns & owns               │
│               ▼                             │
│  Embedded server (single binary)            │
│   REST API · WS hub · static web client     │
└──────────────────────┬─────────────────────┘
                       │ HTTP/WS on LAN 0.0.0.0:3300
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   Teacher          Student        Students
   (desktop /   (desktop / web  (phones via Wi-Fi,
    web on        on localhost)    mobile-first PWA)
    localhost)
```

The server lives on the teacher's machine, bundled with the desktop app. Teachers and
students connect to it over the LAN. Web clients are served by the server
itself as static files.

## Application layering

### `apps/server` — embedded server & system core

- **Framework:** Fastify (v5); plugins `@fastify/cors`, `@fastify/static`,
  `@fastify/websocket`.
- **Storage:** SQLite via built-in `node:sqlite` (`DatabaseSync`) — zero native
  deps, so it compiles to a single standalone binary with `bun build --compile`.
  DB file: `<data-dir>/app.db`.
- **Migrations:** idempotent, versioned, run at startup.
- **CLI:** `--host`, `--port`, `--data <dir>`, `--webroot <dir>`, `--no-console`
  — the admin can run it headless (pure console) or from the admin client.
- **Logging:** one pino stream (`lib/log.ts`) with three readers: a human line on
  a terminal, the original JSON in a pipe, and an in-memory ring buffer that
  `GET /api/logs` and `/ws/server` serve. `token=` values are redacted before any
  of them sees a line.
- **Console:** interactive commands on stdin when there is a terminal
  (`lib/console.ts`) — `help`, `status`, `sessions`, `users`, `students`,
  `approve`, `block`, `password`, `level`, `clear`, `stop`. The commands call the
  same library functions the HTTP routes call.
- **Packaging:** one binary (`lantern-server(.exe)`); no Node.js on targets.

### `apps/web-client` — the shared frontend (all roles)

- Vite + Vue 3 + TypeScript + Tailwind CSS v4, mobile-first, PWA.
- **One codebase, role-gated UI**: at first launch the user picks a role,
  signs in, and the UI adapts (admin panel / teacher workbench / student view).
- i18n (`vue-i18n`): base **en**, **uk** included; one-place locale registration.
- Produces static files served by the server; also used inside the desktop app.

### `apps/desktop` — desktop shell (Tauri 2)

- Provides the same frontend in a native window for admin & teacher workflows
  (and for students who prefer a desktop app).
- **It hosts the server.** The bundle carries it as a **resource**
  (`bundle.resources`), not as a sidecar: an `externalBin` lands in `usr/bin`,
  where `linuxdeploy` rewrites it with `patchelf` and corrupts a
  `bun build --compile` binary - which is what kept the AppImage broken from
  0.5.1 to 0.7.0. `src-tauri/src/host.rs` spawns it from `resource_dir()` with
  `std::process`: settings, `--port`/`--data`/`--webroot`, the piped stdout read
  into Tauri events, and a watcher that reports an exit nobody asked for. No new
  Rust dependency, and the module knows nothing about Tauri — it is handed two
  closures, which is what lets the tests spawn a real server.
- The resource is staged by `scripts/desktop-sidecar.sh` (`pnpm
  desktop:sidecar`) into `src-tauri/resources/lantern-server[.exe]`, the name the
  host looks for next to the app. CI runs that step before every `tauri build`.
- The API base is a **variable, not a build-time constant**: the port is a host
  setting, and changing it must not need a rebuild (`setApiBase()` in
  `api/client.ts`).
- Minimal Rust — everything above the process is in TypeScript.
- The webview is the **only** thing that differs from `apps/web-client`: the API
  base is explicit (`apiUrl()`), plus desktop-only pieces —
  `composables/desktop.ts` (app version, window geometry, and the host commands
  and events), the Server screen, and the About dialog.
- The window needs `core:window:allow-*` permissions for the geometry; the app
  version comes from `core:app:allow-version`.

## Access & accounts

- The **admin account is seeded into the system** (built-in bootstrap account).
- **Teachers are created by the admin.**
- **Students register themselves** and must be **approved by a teacher or admin**
  before they can join sessions.
- Authentication: login + password; server issues role-scoped bearer tokens.
- Passwords are hashed; security hardening is deferred but the data model
  already covers roles, statuses (pending/approved/blocked) and moderation.

## Offline mode

Almost everything requires the running server. When the server is unreachable:

- Anyone can **read previously cached content**: course materials, descriptions,
  statistics (PWA cache + local storage).
- **Teachers keep authoring.** A save that cannot reach the server becomes a
  **local draft** (`src/drafts/testDrafts.ts`, localStorage) rather than an
  error, listed above the tests with open / upload / discard. Drafts upload
  themselves the moment the app's shared health poll reports the server is back,
  and a draft the server rejects keeps its place for the next attempt. The rules
  are pure functions over a small storage interface, so they are unit-tested
  without a browser.

## Rooms, courses and lessons

- A **room** is *who*: students behind a six-character key, plus the approval
  list for anyone who registered without one. A **course** is *what*: materials,
  tests and lessons. The two are many-to-many — one room follows several
  courses, one course reaches several rooms — and linking them later still
  enrols the members already in the room, because a class that starts mid-term
  should not have to be re-keyed.
- A room lives on the test and on the session: a run inherits the test's room
  and the teacher may override it. A run with no room is what older data left
  behind, and the journal counts it against the room of its course rather than
  dropping it.
- **Labels** (`tags`) sit on tests, sessions and courses through `entity_tags`,
  so a library narrows by topic without a folder tree nobody agrees on.
- A **lesson** (`course_topics`) is an ordered heading inside a course. Any test
  and any file may be filed under one, or left loose and shown at the end;
  deleting a heading leaves what was under it — taking a plan down is not a way
  to delete the reading filed under it.
- An **announcement** is a sentence to the class with an optional attachment,
  written by one teacher, and only they may take it down.

## Media

- Pictures live in `assets`: an id, an owner, a mime, a size, bytes on disk
  beside the database. An asset belongs to the **uploader** rather than to a
  course or a test, because a diagram outlives the course it was drawn for and
  the same test can run in several courses.
- A paper points at a picture by **id, never a URL** (`media` on the question,
  `image` on an option, `leftImage`/`rightImage` on a matching side), so a
  question can only ever show a picture this server holds. A payload naming
  somebody else's id has it dropped rather than borrowed.
- Images and plain text are served **inline**, everything else as an
  `attachment`. A figure next to a reading is meant to be looked at; a file that
  opens is a file that runs something on the teacher's machine.
- The browser holds an image as an object URL fetched with the bearer token —
  `<img src>` cannot carry the header, and a plain link would arrive
  unauthenticated.

## The journal

Students down the side, tests across the top, one cell per pair, for a **room**
or for a **course**: two routes, because the two rosters are different sets and
a body that named either would be a request the caller can get wrong.

- A cell is the student's **last** attempt, not their best. A best is the
  flattering number, and it is the one that hides a student who guessed once and
  never came back; the attempt count sits beside it, so "80%, once" and "80%, six
  times" read as the different things they are.
- A student on the roster who has never attempted a test keeps their row and an
  **empty cell** — `percent` null, a dash on screen, an empty field in the CSV.
  "No attempt" and "attempted and scored nothing" are different facts.
- A **room** shows the tests it has been run; a **course** shows its whole plan,
  because a planned test nobody has done is exactly the empty cell worth seeing
  before the next lesson.
- A cell carries the run it came from, so a teacher who wants to know *why* the
  number is what it is opens the attempt behind it — the same per-student detail
  the run's own board opens.

## Data model (see [schema](./schema.md))

`users` (roles, approval status) · `sessions` (auth tokens) · `rooms` and
`room_members` · `courses`, `course_rooms`, `course_enrollments`,
`course_topics`, `announcements` · `materials` · `assets` · `tests` ·
`questions` (5 types: single choice, multiple choice, true/false, short answer,
matching) · `tags` and `entity_tags` · `live_sessions` · `participations` ·
`participation_answers` · `participation_events`.

## Testing flow (live sessions)

1. Teacher picks a test and starts a **session** on the Live tab. The server
   issues a 6-character join code (no ambiguous `0/O` or `1/I` glyphs, so it
   can be read out loud) and snapshots the time limit and pass mark. The run is
   born in the **lobby**: the code is already out and students may arrive, but
   nothing is timed and nothing can be submitted until the teacher opens the
   door — which is what a class looks like for the first two minutes.
2. Students sign in, type the code — or open the teacher's `?join=CODE` link,
   which fills it in — and a `participations` row is created. The teacher can
   lock the door to **new** students and keep the ones already in; a reload
   during a locked run never throws anybody out.
3. The paper is served in a **per-student shuffle** fixed at join, so a reload
   never reorders it, and with **every answer key stripped**. A test can still
   be edited meanwhile: the session works from its snapshots.
4. The countdown is corrected for the round trip to the server, so a device
   with a drifting clock still sees the real deadline. At zero the client
   submits, and every server entry point that grades or closes a session also
   sweeps expired participations — a forgotten session costs nobody their
   attempt.
5. Scoring is server-side: points per question and a percent of the maximum.
   Missing or malformed answers score zero.
6. The teacher's **live board** streams over **WebSocket**: status changes for
   everyone in the session, the participant list for the teacher. The client
   falls back to polling where a socket cannot be opened.
   **Pause and resume** move one clock: a resume pushes `started_at` forward by
   the length of the hold, so the board and every phone read the same deadline
   without either keeping its own tally. **Presence** is the phone reporting its
   window visible or not — best-effort by nature, stored on the attempt as an
   indicator, never a sanction: the server grades answers, not attention.
   Each question's time, the times an answer was rewritten and the times the
   window went away are recorded with the answer itself, because a rewritten
   answer is not the confident one it looks like.
7. **Reporting.** A test is judged across *every* session it was run in, not
   one: its own journal gives each student their attempts, best, last and
   average percent, and the class its average and pass rate — both judged on the
   last attempt, so a student who improved is not counted as a fail.
   Per-question difficulty comes from the same query, because the questions the
   class missed are what says what to reteach. The **room/course journal**
   (above) is the other direction: one student against every test of a class.
8. **One student in full.** From the board, or from a cell of the journal, a
   teacher opens one attempt: score, question by question, time on each, how
   often the answer was rewritten and what happened to the window.
9. **Getting it out.** The report prints through the browser's own dialog (no
   PDF library; the print stylesheet collapses the theme to ink on white), and
   one session exports as CSV through a fetch with the bearer token — a plain
   link cannot authenticate here.

## Communication

| Flow | Channel |
|------|---------|
| Everyone ↔ Server (CRUD, join, submit, results) | REST `/api/*`, bearer token (the student's own account token) |
| Teacher → Server (report export) | REST `/api/sessions/:id/results.csv` and `GET /api/journals/*?format=csv`, fetched with the token and saved as a blob — a plain link would arrive unauthenticated |
| Teacher → Server (a picture in a question) | REST `/api/assets`, bytes to disk; the paper points at the id |
| Server → Teacher (live board: joins, submissions, status) | WebSocket `/ws/sessions/:id` |
| Server → Student (pause, finish, time) | same WebSocket, status only |
| Admin → Server (live log tail, same lines the terminal prints) | WebSocket `/ws/server`, backlog via `GET /api/logs?since=` |
| Fallback when a socket cannot be opened | REST polling (cheap, LAN scale) |

## Deployment scenarios

Three ways the system is meant to be used — a server on a school machine, the
teacher desktop app hosting its own server, and a classroom with no admin in the
room. What each one needs, what works today, and the runbook for each:
[scenarios.md](./scenarios.md). The plan that closes the gaps is Phase 5 of the
roadmap.

## Security model (LAN trust)

- Offline classroom: role-scoped bearer tokens for all three roles; an
  administrator approves student registrations; CORS open to the LAN.
- A student can only read or submit **their own** participation: results and
  the live channel check the participation belongs to the caller.
- The live channel authenticates from the query string (browsers cannot set
  headers on a WebSocket handshake) and closes with a code when the token, the
  session or the ownership check fails.
- No TLS in v1 (out of scope); deeper security review is deferred — see Access
  & accounts.

## Cross-platform packaging

- **Server:** `bun build --compile` → native binary per platform.
- **Desktop:** `tauri build` → `.deb` / `.AppImage` (Linux), `.msi` / `.nsis`
  (Windows); CI builds both, releases on `v*` tags.
- **Web client:** static files served by the server binary.

See: [Database schema](./schema.md), [API reference](./api.md).

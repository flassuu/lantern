# Roadmap

Offline-first, role-based classroom testing system — **LANtern**
(admin / teacher / student).
Progress is tracked as SemVer releases; each phase lists what it owes, and the
checklist is the honest state of it — an item is only ticked when it is done and
verified, not when it is planned.

| Phase | Version | Goal |
|-------|---------|------|
| Phase 0 — Scaffold | **0.0.1** (done) | Monorepo, tooling, docs, CI, demo window |
| Phase 1 — Foundation | **0.1.0** (done) | Data model, accounts & roles, auth, admin base |
| Phase 1.1 — UI/UX polish | **shipped in 0.2.0** | Design & feedback pass over what 0.1.0 already ships |
| Phase 2 — Teacher workbench | **0.2.0** (done) | Test/course authoring and sharing |
| Phase 3 — Session runtime | **0.3.0** (done) | Live testing: join, answer, score, WS board |
| Phase 4 — Reporting | 0.4.0 (done) | Statistics, journals, printable + CSV export |
| Phase 5 — Deployment | **0.5.0** (done) | The three ways it has to run: desktop host, school server, classroom without an admin |
| Phase 6 — Classroom experience | **0.6.1 … 0.6.9** (next) | Rooms & tags, a session lobby, per-student detail, media in questions, course lessons & announcements, journals |
| Phase 7 — MVP polish | 1.0.0 | Packaging polish, e2e, screenshots, offline PWA |

The UI/UX polish pass (originally planned as its own 0.1.1) shipped together
with Phase 2 as **0.2.0** — separating them would have meant a release that
only restyled the same screens.

## Phase 0 — Scaffold (v0.0.1, done)

- [x] Monorepo + pnpm workspaces + git (`main`)
- [x] Server binary, health endpoint, migration runner (node + bun-compiled)
- [x] Web client & desktop foundations, i18n (en/uk), CI builds, release v0.0.1

## Phase 1 — Foundation (v0.1.0, done)

**Data model ([docs/schema.md](./docs/schema.md))**
- [x] `users` with role enum (`admin | teacher | student`) and status
      (`pending | approved | blocked`), built-in admin seed
- [x] `sessions` — opaque bearer tokens, SHA-256 hashed at rest
- [x] `courses`, `course_enrollments`, `course_tests`, `materials` (files)
- [x] `tests`, `questions` (5 types) — live-run `sessions`, `participants`,
      `answers` land with Phase 3

**Accounts & auth**
- [x] Register/login endpoints; password hashing (scrypt, no deps); role-scoped bearer tokens
- [x] Admin creates teachers; student self-registration + approval workflow
- [x] Role-based UI shell in web + desktop: role picker on sign-in, login/register
      screens, per-role dashboards; token persisted, restores session on start

**Admin basics**
- [x] Admin panel: users management (list, filters, approve/block) in the UI
- [x] Participants list (courses × enrolled students) & DB health views
      (schema version, table counts, uptime) in the admin UI
- [x] First-run bootstrap: seed admin account (server + UI login with it)

**Tests & courses (CRUD)**
- [x] Test/question CRUD with per-type payload validation (5 question types)
- [x] Course CRUD + material upload (static files, no multipart deps)
- [x] Admin insights: DB health (+ table counts) and participants list
- [x] Import/export share format (JSON) — Phase 2 authoring

## Phase 1.1 — UI/UX polish (done; revisited in v0.4.2 and v0.5.1)

Nothing new server-side: make everything 0.1.0 already ships feel finished.
Planned as its own 0.1.1, released as part of 0.2.0 together with Phase 2; the
two items that needed a real screen to judge — the component consistency pass and
the desktop About dialog — landed later, the dialog in 0.4.0 and the pass in
0.4.1. v0.5.1 came back to it once more: two menus became one, the header settled,
the sign-up form was reordered, and the whole motion vocabulary was written —
plus the Linux desktop flicker, which was a WebKitGTK renderer bug and not a UI
one, and so belonged here only because that is where the symptom was reported.

**Revisited in v0.4.2**, because the remaining complaint was not a missing
feature but a wrong one: button sizes followed the language, the Ukrainian login
screen scrolled sideways, and the motion was ad-hoc. What changed: fixed control
geometry from tokens (36/40/48px, square icon buttons, equal-width tabs),
Material 3 Expressive motion tokens with `prefers-reduced-motion` respected, a
language menu with drawn flags instead of two text buttons, text cut to what is
actually needed, and the project renamed **LANtern** with placeholder artwork and
a documented format list for web, PWA and desktop.

### Design rules (binding)

These rules apply to every screen of web-client and desktop. No exceptions.

1. **No emoji in the UI.** Icons come from Lucide (`@lucide/vue`) only —
   never paste an emoji or decorative glyph into markup, buttons, placeholders
   or labels. The single exception is user-authored content (e.g. a material
   title), which is rendered as-is.
2. **One cohesive style, modelled on Material 3 Expressive**: rounded shape
   scale (cards `rounded-2xl`, controls `rounded-xl`, chips pill), tonal
   surfaces instead of flat white, and short expressive motion (150–250 ms)
   on state changes.
3. **Colour only through semantic theme tokens** (`bg-surface`,
   `text-on-surface`, `bg-primary`, …), never raw palette classes
   (`bg-slate-800`, `text-rose-600`, …), so light and dark both work.
4. **Exactly two themes: light and dark.** No extra palettes, no per-component
   hard-coded colours.

**Design system & states**
- [x] Consistency pass: one set of buttons, cards and text fields —
      `AppButton` (66 call sites), `AppCard` (44) and `AppInput` (15). What is
      deliberately *not* a component stays a raw element: text links, table
      sort headers, clickable rows and tab strips do not look like buttons, so
      they should not act like one. Badges were left as they are - they are
      already one component (`MaterialBadge`) plus a handful of chips whose
      tones differ per screen
- [x] Light/dark theming: semantic M3 Expressive token layer in Tailwind v4
      (`@theme inline` + `:root`/`.dark`), class-based dark on `<html>`,
      theme switcher in every header, system preference as first-run default,
      persisted choice with an anti-flash boot script, global `:focus-visible`
      ring and `prefers-reduced-motion` guard
- [x] State coverage: shared `<EmptyState/>` (icon, title, hint, optional
      call-to-action) and `<SkeletonList/>` (card + table variants, pulse) on
      every list — tests, courses, course details, users, participants,
      system stats and the boot screen; inline error alerts kept per screen
- [x] Global toast notifications (success/error) via a shared, dependency-free
      `useToast()` + `<ToastHost/>` (tests, courses, students, materials, user
      actions), plus an app-wide offline banner and a "server is back" toast
      driven by one shared health-poll composable

**Sign-in & auth UX**
- [x] Enter-to-submit, "show password" toggle, remember the last username
      and role, autocomplete attributes — the role picker switches instantly
      without a page reload
- [x] One-click role switching (no reload); focus management after
      login/logout still open

**Admin dashboard**
- [x] Confirm dialog before blocking a user (Users tab)
- [x] Users/Participants as sortable tables on wide screens (cards stay on
      narrow) with result counts and `aria-sort` on the headers
- [x] Bulk approve of pending students: row checkboxes, select-all-pending,
      one-click approval with a toast; confirm dialog guards blocking

**Teacher workbench**
- [x] Confirm dialogs before destructive deletes: test, course, remove
      student, detach test (material delete UI not implemented yet)
- [x] Editor ergonomics: duplicate a question, move questions up/down, and a
      live test preview (student view with the correct answers highlighted)
      before saving
- [x] Course page: searchable test-attach picker (type, question count and
      time limit per row, no more bare `<select>`) and material rows with a
      file-type badge resolved from MIME type with an extension fallback

**A11y, i18n & desktop**
- [x] Accessibility pass: focus rings actually visible again (the `outline-none`
      utility was beating the global `:focus-visible` ring), `aria-label` on every
      icon-only control and on all 14 placeholder-only form controls, keyboard
      focus trap + focus restore in both dialogs, contrast audit of all 15
      bg/text token pairs in both themes (all ≥ 4.5:1)
- [x] i18n hygiene: last hardcoded strings (server-status tooltip) moved into
      the locales, `<html lang>` synced to the active locale, locale choice
      persisted
- [x] Desktop: About dialog with the app version and the server it talks to,
      window size/position remembered across restarts, a plain window title
      instead of one with a name in it, and the window permissions it needs
- [x] Web/mobile QA of admin, teacher and student screens at 320, 390, 768px
      (and the desktop at 800×560 and 1080×720), measured in a real browser:
      no horizontal scroll, no touch target under 30px, no unnamed control.
      This found and fixed the 24px header chips, the 28px primary actions and
      a header that scrolled sideways at 320px

## Phase 2 — Teacher workbench (v0.2.0, done)

- [x] Test authoring UX — list + full editor for all 5 question types in the
      teacher dashboard (web-client & desktop)
- [x] Course builder: create courses, attach/detach tests, enroll students,
      upload and download materials
- [x] Test duplication & sharing: `Duplicate` per test (fresh question ids, so
      editing the copy cannot touch the original), `GET /api/tests/:id/export`
      writes a file with no ids and no owner but with the answer keys, and
      `POST /api/tests/import` reads it back
- [x] Offline authoring: a save that cannot reach the server becomes a local
      draft, listed with the tests; drafts upload themselves when the server
      answers again, and a rejected draft keeps its place for the next attempt

## Phase 3 — Session runtime (v0.3.0, done)

- [x] Session lifecycle (create → active → paused → finished) with a 6-character
      join code (no ambiguous 0/O or 1/I glyphs) and snapshots of the test's time
      limit and pass mark
- [x] Student join flow; deterministic per-student question shuffle that
      survives a reload, with every answer key stripped from the payload
- [x] Scoring engine (points + percent) as pure functions over all five
      question types, with unit tests
- [x] Auto-submit on timeout, enforced both in the client clock and by a
      server-side sweep on every entry point that grades or closes a session
- [x] Student UI: code entry, the paper with all five input types, a
      server-corrected countdown, submit with confirmation, graded result with
      a per-question breakdown
- [x] Teacher side UI: start a session from a test, join code shown large with
      a copy button, participant board (polling every 4s) with working markers,
      percentages and pass badges, pause / resume / finish with confirmation
- [x] WebSocket hub: `GET /ws/sessions/:id` streams status to everyone and the
      participant board to the teacher, pushed on every join, submit, pause,
      resume, finish and timeout sweep; the client falls back to polling when
      the socket cannot be opened
- [x] Join link: the teacher copies a `?join=CODE` link, which fills the code in
      on the student's phone; a scannable QR code for the same link is part of
      Phase 4

## Phase 4 — Reporting (v0.4.0, done)

- [x] Grade journal per test: one row per student across every session of that
      test (attempts, best, last and average percent), class average and pass
      rate judged on each student's last attempt, so someone who improved since
      the first try is not counted as a fail
- [x] Per-question difficulty across every attempt, with the questions most of
      the class missed called out at the top of the report
- [x] Student side: the courses the student is enrolled in with their materials,
      the result of every finished attempt on the home screen, and the QR code
      on the teacher's board to join a session
- [x] CSV export per session (`GET /api/sessions/:id/results.csv`), fetched with
      the bearer token rather than a plain link, UTF-8 BOM and escaped fields so
      spreadsheets open non-ASCII names correctly
- [x] Printable report: the journal screen prints through the browser's own
      dialog with the app chrome dropped and the theme collapsed to ink on
      white (no PDF library needed)
- [x] Tag `v0.4.0` and publish the release

## Phase 5 — Deployment (v0.5.0, done)

The three ways the system is actually used, made to work end to end. Today the
middle one works if the teacher happens to open the web client on the LAN
address, and the other two do not work at all — see
[docs/scenarios.md](./docs/scenarios.md) for the runbook of each.

### 5.1 Reachability — the address students can actually open

**Done.** The join link used to be built from `window.location.href`, which is
`tauri://localhost` in the desktop app and `http://localhost:3300` in a browser
on the teacher's machine: a phone can open neither, so the QR code used to be
decorative. The address is now a server setting, the QR carries it, the teacher's
tab prints it, and it says so when the address is one no phone can reach.

- [x] `publicBaseUrl` server setting, kept in `app_meta` (key/value exists, so
      no schema migration). `GET /api/settings` (auth) and `PATCH /api/settings`
      (admin) with validation: absolute http(s), no path, no trailing slash
- [x] Server reports the LAN addresses it sees (`os.networkInterfaces`) as
      suggestions; the admin can accept one or type their own
- [x] `joinLink()` moved out of the component into a pure function that prefers
      `publicBaseUrl` and falls back to the current origin — unit tested both ways
- [x] Teacher's Live tab shows which address is in the QR, and says so plainly
      when it is `localhost` or `0.0.0.0` ("students cannot reach this")
- [x] Students keep working when the address is wrong: the code can always be
      typed by hand, and the copy-link button copies the LAN address, not the
      origin of the window

### 5.2 Classroom with a key — a teacher who is not an admin

**Done.** A self-registered student was `pending`, could not log in (403), and
only an admin could approve — so in a classroom, where the teacher is alone,
nobody got in. The fix was not more power for teachers: it is a scoped key. A
class key approves a student account and nothing else; a teacher still cannot
touch a user, another teacher's class, or anything an admin holds.

- [x] Table `classrooms` (migration v5): owner, name, `key` (6 chars, the same
      unambiguous alphabet as join codes, unique), status `active | revoked`,
      optional `course_id` for auto-enrolment, timestamps
- [x] Teacher API: create, list own, rename, revoke, regenerate the key, delete
- [x] `GET /api/classrooms/preview?key=` — public, validates a key without
      creating anything, so the register screen can say "Class 9A · Olena M."
- [x] `POST /api/auth/register` accepts an optional `classKey`: a valid key
      creates the account **approved** and records the classroom; an invalid one
      is a clear 400 and the account stays `pending` as before
- [x] Teacher UI: "My classes" with the key as text and as a QR of the
      registration link (`?class=KEY`), the students who came in through it, and
      revoke/regenerate/delete
- [x] Register screen gets an optional class-code field; students who already
      have an account are unaffected
- [x] Tests: key generation and uniqueness, approve-on-valid, reject-on-invalid
      and on revoked, a teacher cannot see or revoke another's class, auto-
      enrolment into the linked course, and that a key never grants teacher rights

### 5.3 The server console — one implementation, three surfaces

**Done, except the desktop view (5.4).** The headless server used to write pino
JSON with no interactive control, and the desktop app had no log view at all. A
teacher running the server in a school computer room needs to see what it is
doing and be able to act without a second machine, so there is now one log stream
with three readers — the terminal, the ring buffer and the live tail — and a
console that acts through the same library functions the API calls.

- [x] Human-readable log lines (level colour, aligned, relative time) when
      stdout is a TTY, unchanged JSON when piped — so `systemd` and CI still work
- [x] Interactive commands on stdin when a TTY, acting through the same
      functions the HTTP API uses: `help`, `status`, `sessions`, `users`,
      `students [pending]`, `approve`, `block`, `password`, `level`, `clear`,
      `stop`. Disabled by `--no-console`, skipped automatically when piped
- [x] In-memory ring buffer of recent lines + `WS /ws/server` (admin only) and
      `GET /api/logs?since=` so the desktop and the web admin can follow the
      same stream live
- [x] Admin "Server" tab in the web client: live console, server status, and the
      same actions as API calls (approve a student, stop the server)
- [x] Restart is deliberately *not* an API call: only the desktop, which owns the
      process, can bring it back. *(The decision is implemented — there is no such
      endpoint, and the Server tab says restart happens at the machine; the
      desktop side of it is 5.4.)*
- [x] Tests: the formatter (TTY vs piped), the command parser and its
      permissions, the ring buffer's ordering and trimming

### 5.4 The desktop app as a host

**Done.** `src-tauri/src/lib.rs` used to be six lines with one plugin: no sidecar,
no spawn, no console, no settings — the scenario the whole project was imagined
for did not exist. The app now carries the server as a sidecar, starts it, shows
its output, and keeps its settings; `src-tauri/src/host.rs` spawns it with
`std::process` and knows nothing about Tauri, which is what lets its tests start a
real server.

- [x] Bundle the server binary as a sidecar (`bundle.externalBin`) and spawn it
      from a small Rust module (`std::process::Command` + piped stdout → Tauri
      events — no new dependency), with stop/restart and an exit code surfaced
- [x] Console view in the desktop app: colourised, auto-scrolling, filterable by
      level, copy and clear, start/stop/restart, "open in browser" with the LAN
      address
- [x] Settings view: data dir, port, admin password, public address — persisted
      locally, applied on restart
- [x] The desktop API base stops being a build-time constant (`VITE_API_TARGET`)
      and follows the settings, so changing the port does not need a rebuild
- [x] First run: defaults + "Start", and a clear message when the bundled binary
      is missing (a dev build) with the path that was looked for
- [x] Packaging: the sidecar is renamed per platform in CI, and a dev build can
      point at a locally built binary

### 5.5 Making it verifiable (done)

- [x] `docs/scenarios.md`: the runbook for all three scenarios, including what
      each needs, how to try it by hand, and how to tell it worked
- [x] The browser harness (headless Firefox over WebDriver BiDi, already used
      during development) kept as a dev script with the checks it runs: overflow,
      tap targets, and one happy path per role. `scripts/browser-checks.mjs`,
      `pnpm check:browser`, no dependencies of its own
- [x] A CI smoke step for the console: start the binary, send one command on
      stdin, assert the output, and that `--no-console` starts clean.
      `scripts/console-smoke.sh`, `pnpm smoke:console`, wired into the release
      workflow's server job

## Phase 6 — Classroom experience (v0.6.1 … v0.6.9, next)

The system can author a test and run a class; this phase makes the *classroom*
work. Three ideas run through it: a **room is who, a course is what**; a session
is something the teacher **opens, starts and watches**; and a question can
**carry a picture**. Every decision below was taken with the room in mind — one
teacher, a class of phones, no administrator anywhere.

**Decisions taken before the phase (binding, they shape the schema):**

- A **Room** (the tab formerly "Classes") is *who*: a group such as 9A with a
  registration key. A **Course** is *what*: a programme with lesson topics,
  materials and tests. Rooms and courses link **many-to-many**, and a room can
  have any number of courses.
- The rename goes all the way down — tables and API too: `classrooms` → `rooms`,
  `/api/classrooms` → `/api/rooms`. There are no external clients, so nothing
  needs a compatibility shim.
- **Tags** are free subject/topic labels on tests, sessions and courses. A room
  is a **relation**, not a tag: "which class" is a foreign key, "which topic" is
  a label.
- Per-question time is measured by the **client** and sent with the submission —
  no incremental writes, no autosave.
- Leaving the window is **recorded** (passive status plus an event log with
  timestamps), not punished. Nothing is auto-submitted and nothing is blocked.
- Question and answer media is stored as **files on the server**, served by URL,
  so a GIF animates.
- A result is shown **immediately on submission** by default; the teacher can
  hold it until they release it.

**Cross-cutting groundwork, built early and reused by later sub-phases:**

- [ ] `AppTabs` — the "browser tab" behaviour for sessions (6.2)
- [ ] `TagInput` + `TagChips`, one chip style, used wherever a tag is edited (6.1)
- [ ] `AppTable` — a sortable table, extracted from the admin screens, for the
      journal (6.8)
- [ ] `AppDrawer` / wide dialog, for the session library and the student detail
      (6.2, 6.5)
- [ ] `MediaFigure` (image/GIF + lightbox) and `AssetUpload` (6.6)
- [ ] `usePresence` — the Page Visibility API plus a WebSocket heartbeat (6.3)
- [ ] `useSessionSettings` — one client-side model of the session options (6.4)

Every change lands in **both** apps (`apps/desktop` and `apps/web-client`), whose
files are byte-identical twins, and in both locale files.

### 6.1 Rooms, tags, session name — v0.6.1 — **done**

Goal: separate *who* from *what*, give tests and sessions tags, and give a
session a name and a room.

- [x] Migration **v6**: rename `classrooms` → `rooms`, `classroom_members` →
      `room_members`, `classroom_id` → `room_id`; add `course_rooms`
      (many-to-many), move `rooms.course_id` into it; add `tests.room_id` and
      `live_sessions.room_id` (nullable FKs) and `live_sessions.name`; add
      `tags` and `entity_tags` (entity kind `test | session | course`)
- [x] Server: `lib/classrooms.ts` → `lib/rooms.ts`, `routes/classrooms.ts` →
      `routes/rooms.ts`, `/api/rooms*`; a room enrols its members into every
      course it is linked to, present and future
- [x] Server: `lib/tags.ts`, `routes/tags.ts` — `GET/POST /api/tags`,
      `PATCH/DELETE /api/tags/:id`, `PUT /api/tags/:entity/:id`; tests, sessions
      and courses carry `tags[]` and `roomId` in and out
- [x] Server: `POST /api/sessions` takes `name`, `roomId` and `tags`;
      `GET /api/sessions` gains filters (`room`, `test`, `tag`, `status`, `from`,
      `to`, `q`, `limit`)
- [x] Client: `ClassesTab.vue` → `RoomsTab.vue` and the tab label becomes
      "Rooms"; a room links to several courses; members as before
- [x] Client: `TagInput.vue` in `TestsTab`, `CoursesTab`, `CourseDetails` and the
      start-session dialog; the room chip on the test card and the Live board
- [x] i18n: `teacher.rooms.*` (the rename), `teacher.tags.*`, session name/room
- [x] Tests: `rooms.test.ts` (CRUD, ownership, enrolment both ways),
      `migration-v6.test.ts` (the rename on a populated file), `tags.test.ts`
      (labels, ownership, filters); `scripts/browser-checks.mjs` for the new tab
- [x] Docs: `schema.md` (v6), `api.md` (rooms, tags, filters),
      `architecture.md`, `scenarios.md`, `TEST_PLAN.md`

Two decisions the plan left open, taken while building it:

- The tag endpoint is `PUT /api/tags/:entity/:id`, not
  `PUT /api/:entity/:id/tags` — one URL per kind of thing, one body, one call
  the UI makes for every labelled screen.
- A session's room defaults to the test's own rather than to null. Most of the
  time the paper was written for one group and that is who is in the room, so
  the common case should not ask a question.

### 6.2 Live — session tabs and a library — v0.6.2 — **done**

Goal: a strip of the most recent sessions that reads like browser tabs, a button
beside it that opens a comfortable library to search and filter, and a board that
visibly belongs to the selected tab.

- [x] Server: `GET /api/sessions` with the 6.1 filters, sorting and paging, and a
      `total` that belongs to the filter rather than the page;
      `GET /api/sessions/:id` for one session
- [x] Client: `SessionTabs.vue` — as many tabs as fit are shown (measured with a
      `ResizeObserver`), the rest live behind "All sessions"; a tab carries the
      status dot, the name and the code
- [x] Client: `SessionLibraryDialog.vue` — search by name and test, filters by
      date, test, status, room and tag, sorting, and selection
- [x] Client: one visual unit — the tabs are the top edge of one card, and the
      selected session's hero, board and participants sit inside it, so it is
      plain which board and which participants belong to which test
- [x] i18n: `teacher.live.library.*`, `teacher.live.tabs.*`
- [x] Tests: `session-library.test.ts` (sort, paging without repeats, the total,
      one session by id); the browser harness opens the library, searches, picks,
      and checks the tab strip and the grouped block

Two decisions taken while building it:

- The library is a **wide dialog**, not a side drawer. The groundwork note listed
  "AppDrawer / wide dialog" as either; a modal is the better fit on a phone,
  which is where a teacher picks a past run, and it needed no new component.
- The "All sessions" button is always in the strip rather than appearing only
  when tabs overflow. A control that materialises under a finger is worse than
  one that stays put, and the library is worth reaching even when three tabs fit.

### 6.3 The lobby, the start, presence — v0.6.3 — **done**

Goal: a session is created in a **lobby**; the clock starts when the teacher
starts it; the teacher sees who is in and what they are doing; leaving the window
is recorded.

- [x] Migration **v7**: rebuild `live_sessions` so `status` includes `lobby` and
      `started_at` is null until the start; add `entry_locked`; add
      `participation_events`
- [x] Server: `POST /api/sessions` creates a `lobby`; `POST /api/sessions/:id/start`
      stamps `started_at`, flips to `active` and broadcasts; `PATCH` takes
      `entryLocked`; `join` refuses when locked and works from the lobby
- [x] Server: the WebSocket takes a student's `presence` (visible) and `progress`
      (question index, answered count), keeps them in memory, and broadcasts the
      board with `online`, `active` and `questionIndex` folded in
- [x] Server: focus/visibility changes are appended to `participation_events`,
      one row per change
- [x] Client (student): `LobbyScreen` ("waiting for your teacher"), then the
      runner; `usePresence` reports activity and progress and shows a note when
      the student has looked away
- [x] Client (teacher): lobby state, Start, Close/Open entry, and participant
      rows that say *here*, *answered N*, *away* or *offline*
- [x] i18n: `student.lobby.*`, `teacher.live.begin|entryLock|entryUnlock|presence.*`
- [x] Tests: `lobby.test.ts` (lobby → start, refusal when locked, the student
      already inside); the browser harness opens a lobby, starts it and checks
      the board

Decisions taken while building it:

- **Presence travels on the WebSocket, `participation_events` holds only the
  changes.** "On question 3" changes every few seconds and means nothing after
  the run, so it is memory; "left the window" is worth a row. The roadmap's
  "in-memory + event log" is exactly this split.
- The **student's socket lives for the whole run**, lobby and paper alike, so the
  board never sees a gap where a student reloaded. It is also what carries the
  start: no polling, no reload.
- **One page of questions for now**, so `questionIndex` is always 0 and the board
  shows how many were answered. `questionsPerPage` in 6.4 is what makes "on
  question 3" true, and the field is already there for it.
- The tap-target audit caught the harness check running against a stale build
  once. Worth knowing: rebuild the web client before the checks, and a failed
  first navigation is worth a second run.

### 6.4 Session settings — v0.6.4 — **done**

Goal: shuffle, answer reveal, result release, and one question at a time.

- [x] Migration **v8**: `tests.settings` and `live_sessions.settings` (JSON) and
      `live_sessions.results_released`; `participations.option_order` for the
      shuffled options
- [x] Defaults: `shuffleQuestions`, `shuffleOptions`,
      `showCorrectAnswers: never | after_submit`,
      `releaseResults: immediate | teacher`,
      `questionsPerPage: all | one`, `allowBack`
- [x] Server: a session snapshots the test's defaults when it is created (and the
      start dialog may override them); options are shuffled per student and fixed
      in `option_order`; `POST /api/sessions/:id/release` flips the release;
      with `releaseResults: teacher`, `submit` answers `released: false` and
      `result` refuses with `409 RESULT_HELD` until released
- [x] Client: a settings block in the test editor for the defaults, and the same
      controls in the start dialog and in the lobby, driven by one
      `SessionSettingsFields` component
- [x] Client (student): a one-at-a-time runner with a pager when
      `questionsPerPage: one`; the result view honours the reveal rule, and a
      held result says so instead of failing
- [x] Client (teacher): a "Release results" action and a "results are out" badge
- [x] i18n: `teacher.sessionSettings.*`, `student.paged.*`
- [x] Tests: `session-settings.test.ts` (the snapshot and the override, settings
      frozen after the start, option order fixed across a reload, the release
      gate, the hidden key); the harness checks the lobby's settings controls

Decisions taken while building it:

- Settings are **snapshotted when the session is created**, not at the start: the
  lobby is where they are edited, so a start-time copy would either overwrite the
  teacher's edits or need a second write. "Snapshot" means "a later edit to the
  test cannot reach a run that already exists", which is what this gives.
- The settings model lives in `api/normalize.ts` rather than `api/types.ts`,
  because that module has no runtime imports and a plain `node --test` can load
  it.
- **Deferred to the end-of-phase test pass**: an end-to-end harness run of the
  paged runner and a held result through the student path. The server behaviour
  is covered by tests and the lobby controls by the harness; the student flow is
  the last thing to wire into the browser checks.

### 6.5 Per-student detail — v0.6.5

Goal: for each student, what was right and wrong, how long each question took,
and how the attempt went.

- [ ] Migration **v9**: `participation_answers.time_ms`, `answered_at`,
      `changed`; `participations.total_time_ms`, `focus_lost` (the events table
      landed in v7)
- [ ] Server: `submit` accepts and stores timings, changes, events, `focus_lost`
      and `total_time_ms`; `GET /api/sessions/:id/participants/:userId` returns
      the questions, the student's answer, correctness, points, time, the events
      and the start/finish times; the test report gains time aggregates
- [ ] Client: `useQuestionTiming` in the runner — time on the visible question,
      number of changes, sent on submission
- [ ] Client: `ParticipantDetailDialog.vue`, opened from a participant row — a
      header, a per-question table (right/wrong, points, time, "changed N
      times"), the activity timeline, and metrics (average time, where focus was
      lost)
- [ ] i18n: `teacher.participantDetail.*`
- [ ] Tests: accepting and storing timings and events, the detail endpoint and
      its permissions; the timing computation as pure functions

### 6.6 The test editor, media, statistics — v0.6.6

Goal: images and GIFs in questions and answers, a more useful editor, and a
prettier result for both teacher and student.

- [ ] Migration **v10**: `assets` (owner, path, mime, size); question payloads
      grow `media` on the question, `image` on each option and each matching side
- [ ] Server: `routes/assets.ts` — raw upload like materials (with a size cap),
      `GET /api/assets/:id` (GIF supported), `DELETE`, owner-scoped; the student
      paper and the result carry media
- [ ] Client: `AssetUpload.vue` and `MediaFigure.vue` (preview + lightbox), in
      `QuestionEditor` for the question and every option/pair, and in
      `QuestionAnswerInput`
- [ ] Client: a body editor of text plus inserted images, without a heavy
      dependency
- [ ] Client: editor statistics — count and points chips, an estimated time, and
      for an existing test the per-question difficulty from its results; a
      polished `TestPreviewDialog` that shows media
- [ ] Client: a readability and beauty pass over the editor, the student runner
      and the result screen
- [ ] i18n: `teacher.editor.media.*`, `common.image.*`
- [ ] Tests: assets CRUD, permissions and limits; export/import with media;
      payload utilities; the browser harness inserts an image and sees it as a
      student

### 6.7 Courses — lessons, announcements, media — v0.6.7

Goal: lesson topics, teacher announcements, and images viewed rather than only
downloaded.

- [ ] Migration **v11**: `course_topics`; a nullable `topic_id` on `materials`
      and `course_tests`; `announcements` (course, author, body, optional
      material, timestamps)
- [ ] Server: topics CRUD and ordering; attach/detach tests and materials to a
      topic; announcements CRUD (author only); the student's course payload
      carries topics, announcements and materials
- [ ] Client (teacher): `CourseDetails` shows ordered topics, each with its tests
      and materials; create and edit a topic; an announcement form (text plus an
      optional file); materials show a preview with a lightbox and a GIF plays
- [ ] Client (student): `StudentCourses` shows topics, materials with previews,
      and the announcement feed
- [ ] i18n: `teacher.courses.topics.*`, `teacher.courses.announcements.*`,
      `student.courses.*`
- [ ] Tests: topics, announcements and ordering, with permissions; the browser
      harness views an image inside a course

### 6.8 Journals by room and by course — v0.6.8

Goal: a table of students against tests, with grades and dates, scoped to a room
or to a course.

- [ ] Server: `GET /api/journals/rooms/:id` and `/api/journals/courses/:id` —
      students against the tests of the room or course, each cell the last
      percent, the attempt count and the last date; CSV export and print
- [ ] Client: `JournalTable.vue` on `AppTable` — a sticky first column, sorting,
      a dash for an empty cell, a tooltip for "N attempts, date", printing
- [ ] Client: a Journal screen reachable from a room and from a course, with the
      scope switch and the test columns; a link into the student detail (6.5)
- [ ] Client: the dashboard menu settles as `Live`, `Tests`, `Courses`, `Rooms`,
      `Journal`
- [ ] i18n: `teacher.journal.*`
- [ ] Tests: journal aggregates for both scopes and their permissions; the
      browser harness covers the table and the empty cells

### 6.9 Documentation, i18n, tests, e2e — v0.6.9

- [ ] `docs/schema.md` brought up to date through v6–v11, `architecture.md` with
      the room/course model, the lobby and presence flows, media and journals,
      `api.md` with every new endpoint, `scenarios.md` with the new steps
- [ ] i18n: en and uk in step, no hard-coded string anywhere
- [ ] Server integration tests for every new path; client tests for the new pure
      logic; `scripts/browser-checks.mjs` extended for rooms, the session library,
      the lobby, the paged runner, media, the journals and image viewing
- [ ] A CHANGELOG entry per sub-phase, and a final consistency pass on the style

**Order and dependencies.** 6.1 → 6.2 → 6.3 → 6.4 → 6.5 → 6.6 → 6.7 → 6.8 →
6.9. Timing (6.5) needs the lobby and the events table from 6.3; the journals
(6.8) use the detail from 6.5 and the room/course model from 6.1. Each sub-phase
is its own release: **0.6.1 … 0.6.9**.

**Assumptions to keep in view.** Rooms↔courses are many-to-many and a later link
still enrols the members; a room lives on the test and on the session (the
session inherits, the teacher may override); `questionsPerPage` defaults to "all
at once"; media is png/jpg/webp/gif with a per-file cap and is served from
`/api/assets/:id`; announcements are course-level with one optional attachment;
the journal is a matrix with a room scope, a course scope and a by-date mode.

**Risks.** The v6 migration touches a live database — it ships with a
post-migration integrity check and a test against a populated file. The lobby
changes the session lifecycle everywhere (student, socket, CSV, reports) and is
covered by integration tests. Presence is best-effort by nature and is an
indicator, never a sanction. Media complicates test export: the export either
carries the files or carries the references, and 6.6 decides which.

## Phase 7 — MVP polish (v1.0.0)

- [x] Server unit and integration tests: scoring over all five question types,
      the grade journal and CSV export, the session runtime, auth and the role
      boundaries (104 tests)
- [x] Client tests for the logic worth testing: the session clock and answer
      payloads, the QR generator, the download helper, the offline drafts, and an
      i18n catalogue check that compiles both locales (45 tests)
- [x] GitHub-ready README: what the project is, the three roles, the topology,
      headless install with the CLI flags, badges
- [ ] Seed demo data, so a fresh install can be shown without typing anything in
- [ ] Screenshots in the README (teacher workbench, live board, journal, student)
- [ ] Browser e2e for the student flow: join → answer → submit → result
- [ ] Offline PWA caching polish: a manifest and a service worker, so a phone can
      install the client and a room without Wi-Fi still shows what it has
- [ ] A Linux AppImage that actually runs, from CI — the format is off in CI for
      a reason, and 0.5.1 is where that was found. See below.

### The AppImage, and what 0.5.1 established about it

The desktop ships a `.deb` from CI and an AppImage built locally. The AppImage is
excluded from CI not because it is flaky but because it is **wrong**: the bundle
builds, uploads, and the app inside it segfaults on startup.

The cause is `linuxdeploy`. Assembling an AppImage, it runs `patchelf` over
every ELF in the AppDir's `usr/bin` to give it the bundle's rpath. Our sidecar is
a `bun build --compile` binary, and that rewrite corrupts it. The `.deb` does not
go through any of this — `dpkg-deb` rewrites nothing — and its sidecar starts and
serves, which is how the two formats differ.

What is already established, so this does not have to be re-learned:

- **Nothing structural notices.** `readelf` reads the header, the program headers
  and the dynamic section without complaint. Comparing hashes does not work
  either: adding the rpath is `patchelf`'s job, so the bytes are *meant* to
  change, and that test can only ever fail. `ldd` is content wherever the
  libraries happen to resolve, and unhappy where they do not.
- **Only running the artifact sees it.** Give the sidecar a data directory and
  eight seconds: a live server is killed by the timeout (124), a corrupted one
  dies on its own (139).
- **`NO_STRIP`, `APPIMAGE_EXTRACT_AND_RUN` and an `ldd` shim are not the fix.**
  The shim does make the bundle build — which is precisely how a broken file got
  onto the download list before it was caught by hand. Those three address
  `linuxdeploy`'s environment, not its rewrite of our binary.
- **The same command works on a workstation.** Building it locally on Arch is
  fine, and that is what AGENTS.md documents. The failure is specific to
  `linuxdeploy` touching the sidecar, not to the machine.

What the fix therefore looks like, and what is left to do: move the Bun binary
out of `usr/bin` into a directory `linuxdeploy` does not scan — resources, where
it is shipped as data rather than as an executable — and put a small wrapper in
the sidecar slot that execs it. That means resolving the bundled path in Rust
(`resource_dir()`), keeping the `.deb` and Windows layouts working, and proving
the result by running the produced AppImage before it goes on the release page.
The verification step is the part worth keeping whatever the packaging ends up
being: an artifact nobody has started is an artifact nobody has tested.

## Out of scope (v1)

- Multi-admin sync, cloud hosting, account recovery
- Question bank sharing/import, forums, anti-cheat beyond answer locking

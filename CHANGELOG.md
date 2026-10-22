# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

Eleven changes after 0.7.0, each found by using the thing rather than by reading
it: a clock that lied, a student screen that grew, a server panel nobody could
reach, a paper that emptied itself when the phone reloaded, a gradebook nobody
could take a copy of, a client a phone could not install or keep offline, a PDF
that could not spell a Ukrainian name, a run screen whose clock and search box
did not do what they looked like they did, three screens that were read rather
than used, a scrollbar that was bigger than the thing it moved, and a live
board whose controls were more kinds than one run needs.

### A paper that survives the phone

- **An answer given before a reload is still there after it.** The runner used
  to keep the paper in memory only: a battery saver killing the tab, a thumb on
  the wrong button or a browser crash handed the student back an empty paper.
  The answers, the page and the time spent on each question now live in
  `localStorage`, one entry per run and student, written on a 400ms debounce and
  flushed when the tab is hidden or closed. The paper says the answers came back
  rather than filling itself in silently.
- **A submit that did not reach the server says so and waits.** It was a toast
  that disappeared while the paper was still on screen and still unsent. It is
  now a banner that stays, with a button to try again; the draft stays too.
- **A paper the server already has is not sent twice.** A `CONFLICT` answer -
  a retry that went through without its response reaching the client, or the
  sweep at the deadline - clears the draft and opens the result, held or not.
- **Signing out takes the drafts with it.** A phone passed around a classroom is
  the normal case; the next student starts on an empty paper.
- **A status frame no longer empties the paper.** The runner reset every answer
  whenever the questions array changed identity. It now reacts to a different
  set of question ids and keeps the answers to the questions that remain.

### A clock that tells the truth

- **A run on hold no longer runs out.** `isSessionOver` compared the wall clock
  against the start mark and never looked at the pause, while the start mark
  moves only when the run resumes. A paper paused with thirty seconds left was
  handed back graded four and a half minutes later — the one thing a pause is
  for. A run on hold is now never out of time, and resuming gives back exactly
  what was left.
- **`+15s` and a pause reach the student.** The status frame carried the word
  "paused" and nothing else, so a phone never heard a new limit, a pause mark or
  a start mark that moved; its clock ran against numbers the server had left
  behind. The frame now carries `startedAt`, `pausedAt` and `timeLimitSec`, and
  the dashboard folds them into the session the runner already reads. A frame
  with no clock in it is ignored rather than blanking one that works.
- Both regressions are pinned by tests that move the clock instead of sleeping:
  a run paused with thirty seconds left is still paused, still joined, and still
  has those thirty seconds after four and a half minutes; a run twenty seconds
  past its deadline stays open when it is given thirty more.

### The student side gets the workbench's tabs

- **Join, courses and results are three tabs, not one long page.** The same
  `TabStrip`, the same transition and the same width as the teacher's workbench.
  A link from a teacher's QR lands on the join tab with the code filled in; the
  states that own the whole screen — a lobby, a paper, a result — keep it whole
  and get no tabs.
- **The two lists lost their own headings**, because the tab above already names
  the screen; the hint under the courses stayed, because it says what the tab
  does not.
- **The harness finds controls by role now.** It looked for the join button by
  its text, and the new tab carries the same word, so five checks were clicking
  a tab. Buttons are found by `main form button[type=submit]`, and the courses
  tab is waited for rather than assumed.
- The question count reads as a word again — `{count} questions`, not
  `{count} que`.

### The server panel

- **It adopts a server it did not start.** A server already listening — on
  autostart, or started from a terminal — used to meet "Start the server" and an
  address-in-use error. A TCP connect and one `GET /api/health` now say whether
  the port holds this app's server and which build it is: the panel reports it
  as running, labels it as started outside the app, and stops it by the pid that
  holds the port (`ss`, `lsof` or `netstat`, by number, `SIGTERM`). A port held
  by something else is reported and left alone.
- **Three tabs instead of a wall.** Status, Settings and Console on the same
  `TabStrip` as the workbench; the console no longer sits under seven inputs for
  the whole lesson. Status gained the numbers the buttons act on: port, version,
  process, uptime.
- **Reachable while signed in.** The row in the profile menu was gated on
  `hosted`, which only the sign-in and register screens pass — so the one moment
  a teacher wants to check the server was exactly when it was missing. The
  desktop teacher and admin screens pass it now; the phone client does not.

### User management

- **An admin can set somebody else's password.** A locked-out student cannot
  change theirs without the old one, and there was no way back in.
  `PATCH /api/users/:id/password`, admin only, and it ends every session that
  user held — a reset that leaves the old device signed in is not a reset.

### A gradebook that can be backed up

- **The whole school in one file, on purpose.** `GET /api/admin/backup` streams
  the database as a download. The copy is made with `VACUUM INTO` rather than a
  file copy: a live SQLite database with a WAL is a database plus a journal, and
  copying the first without the second loses exactly the work someone is trying
  to save. The temporary file goes when the stream ends.
- **A backup comes back through the door it left by.** `POST
  /api/admin/backup/restore` takes the file as raw bytes, checks the SQLite
  header, `PRAGMA integrity_check` and the schema version, and refuses while a
  run is open. An older file is accepted and migrated at the next start; a file
  from a newer server is refused instead of being silently downgraded. Each
  refusal has its own code — `SESSION_ACTIVE`, `NOT_SQLITE`, `NOT_LANTERN`,
  `NEWER_SCHEMA`, `CORRUPT` — because each one means a different fix.
- **Nothing is replaced under a running server.** An accepted file is parked as
  `<data>/.restore` and applied by the next start, which keeps the replaced
  database as `app.db.before-restore`. The desktop panel restarts the server
  itself, since it owns the process; a headless server says a restart is needed
  and leaves the decision to its operator.
- **A migration keeps what it replaces.** Before the migrations run, a database
  older than this build is copied into `<data>/backups/`, newest seven kept. Not
  on every launch: seven identical copies teach nobody anything.
- **Admin → System has the card.** Download, the moment of the last backup, and
  restore behind a confirm that names the file.
- Nine server tests cover the round trip: a snapshot is a SQLite file, only an
  admin can touch it, a foreign database and a newer schema are refused, work
  done after a snapshot is gone after the next start, and a run in the lobby
  blocks a restore.

### A certificate, when there is one

- **`--tls-cert` and `--tls-key`, both or neither.** With them the listener
  speaks HTTPS; without them nothing changes, because a classroom with no
  internet has no authority to ask and a server that refuses to start without
  TLS is a server a teacher cannot run. One flag on its own, or a file that
  cannot be read, stops the process with a sentence naming the flag — silently
  falling back to plain HTTP on a typo is the one outcome worth crashing for.
  `/api/health` answers `"tls": true`, and the startup line says `https://`.
- **The sockets follow the scheme they are given.** They were built from
  `window.location`, which in the desktop app is the Tauri window rather than
  the server: the host had no port, the socket never opened, and the live board
  quietly fell back to polling. They are built from the API base now — which is
  `https`-aware — and the student client, served by the server, keeps following
  its own page.
- **The app says whether it can be installed.** A service worker, and therefore
  an installable offline copy, exists only in a secure context. Registration now
  checks for one instead of failing inside a `catch`, About shows "Offline copy
  — Installable / Needs HTTPS", and the offline banner adds why there is nothing
  cached to fall back on.
- **`docs/https.md`.** A local CA with `openssl` (a phone trusts a CA, not a
  leaf), Caddy and nginx recipes with the upgrade headers the live board needs,
  and the note that `publicBaseUrl` takes an `https` address unchanged.
- The harness accepts a local certificate (`acceptInsecureCerts`) and takes
  `BASE=https://…` with `NODE_EXTRA_CA_CERTS`; a full run against a self-signed
  certificate passes, sockets included.

### A report that prints Ukrainian

- **The PDF export is gone.** It was built on the standard Helvetica, which has
  no Cyrillic at all, so `Шевченко` came out `Shevchenko` — in a report meant to
  be handed back to the class. `GET /api/sessions/:id/results?format=pdf` now
  answers `400 UNSUPPORTED_FORMAT` and names the two formats that can spell a
  name. CSV and TXT are unchanged and still come from the same reader, so their
  columns agree. A real PDF would mean shipping a font and a subsetter for a
  file the print dialog already makes.
- **The run's board prints.** The action the journal and the test report already
  had: one button, the browser's own print dialog, and whatever font the name is
  set in. It works while the room is still working, because it prints what is on
  the screen; the export still waits for the run to finish, because it writes
  finished results.
- **The save dialog offers two formats instead of three**, and the two buttons
  wrap instead of running off the edge of a 320px screen.
- The browser harness now names its student `Петро Шевченко` and checks the
  print action on the finished board: the name on the page is the name as it was
  written, and the action reaches the print dialog.

### Four things the screens got wrong

- **The live header reads left to right.** The run's data — name, paper, room,
  labels, clock times — on the left, the clock on the right, and `+15s` under the
  clock where there is room for a column and above it on a phone, where the thumb
  reaches the button before the numbers. It had been arranged and reverted twice,
  so this time it is measured: the browser harness reads both boxes at 1100px and
  at 390px and checks the clock is beside the data on the wide screen, under it
  on the phone, and the button on the right side of the clock in both.
- **The picker's search box finds a paper by its label or its room**, not only by
  its title: a teacher who knows the class and the topic but not the file name
  had the box refuse what the list plainly held. It also says how much it looked
  at — `3 of 12 tests` — so a search that finds nothing cannot be mistaken for an
  empty list. Each row names its room next to the question count.
- **A run can be thrown away.** `DELETE /api/sessions/:id` (`204`), for the
  owner or an admin: a session opened on the wrong paper, or twice by mistake,
  no longer stays in the library forever. A run that is `active` or `paused` is
  refused with `409` — students are answering in it — and a `lobby` nobody
  started, or anything finished, may go. Participants, answers and events hang
  off the session by foreign key and go with it. The library's row carries a
  delete button that asks by name first, and says why it is unavailable instead
  of hiding itself.
- **The tab row is one tab stop.** `TabStrip` now answers the arrow keys, with
  Home and End for the ends, and the tab that moved takes the focus with it; only
  the open tab is in the tab order. TEST_PLAN.md carried this as a known failure,
  and the harness now presses the keys rather than reading the markup.

### The editor, the paper, the result

- **The question is the heading of its card.** On the paper and in the result the
  body of a question was set at 14px — the size of the hint under it and of the
  answers beside it — and marked up as a paragraph; in the editor the card had no
  heading at all. It is `text-base` and a heading now (`<h4>` in the editor,
  `<h3>` on the paper and in the result), so heading navigation walks a paper
  question by question instead of landing on one wall of text.
- **A long question wraps instead of pushing the page sideways.** A word with no
  spaces in it, which is the shape a Ukrainian compound takes, ran off a narrow
  screen; the heading carries `break-words`. The harness opens a paper at 390px
  whose second question holds a fifty-character word, and reads both the box of
  the heading and the width of the page.
- **An answer is a control, not a paragraph.** The choice rows and the
  true/false pair on the paper and in the result carry `border-outline-variant`:
  on a card, the fill alone left the options reading as lines of text rather than
  as things to tap. Both states carry the border, so picking an answer does not
  move the row by a pixel.
- **The result's true/false line has its space back.** The label and its value
  are two spans, and Vue condenses the whitespace between elements away, so the
  screen read `Правда / Хиба:Правда`; a flex row with a gap carries the space.
- **The loading skeleton is the app's skeleton.** The student dashboard's loading
  state was two bars drawn by hand where the rest of the app shows
  `SkeletonList`.
- **The browser now inserts a picture through the editor.** The harness uploaded
  its diagram through the API, which proved the student half of the feature and
  nothing at all about the control a teacher uses. The new path sets a file on
  the editor's own input — the same handler the button calls — saves the test,
  joins the run and reads the picture on the paper at 390px.

### A scrollbar in a gutter of its own

- **The bar starts below the header, not beside it.** It was the engine's overlay
  scrollbar: it reserves no room of its own, is painted over whatever sits at the
  top of the page, and brings a full-height background a shade off the page
  (`#1e1e1e` on the dark theme) — that band, not the thumb, was the bar that read
  as huge. The workbench screens now scroll inside a box that begins under the
  header, and the bar is drawn in a gutter of its own, so it starts at the
  header's bottom edge and never covers it.
- **It is not there until the pointer comes to the edge.** WebKitGTK ignores
  `:hover` on every part of a scrollbar — measured by screenshotting the thumb
  under the pointer — so the reveal is a class on `<html>` that
  `composables/scrollbarReveal.ts` raises while the pointer is within 24px of a
  scrolling area's right edge. The thumb is 50% of the outline inside an eleven
  pixel hit area, and fades in and out over 260ms.

### The live board, settled

- **Four tonal panels, no captions.** What the run is, the clock that governs
  it, how students get in and what the teacher can do about it — each a
  `surface-container-high` card of its own, read by position alone. The data
  panel speaks in values: the run's name with the state chip pressed to its
  own edge at the top right, the paper it ran, the mark it started, the room
  and the teacher's tags as chips on the left margin.
- **One frame for the buttons.** 44px of control, 14px semibold labels, a state
  layer on press: Print and Export are one control split by a 5px gap of empty
  panel, and Copy link, Show QR, Resume/Pause, Finish and the entry lock are
  cut the same way. Finish voices danger in its label and error-coloured text
  on the shared neutral body, not in a fill that shouted in both themes.
  `All sessions` takes the start action's width and corners with the tab
  strip's height and letterform; the nudge pair `+15s | +1m` fades, rather
  than vanishes, on a run that cannot take more time.
- **Releasing held results is a press of its own.** While the results are
  held, the results row's right end is a Release button; once let out or
  already released, the Print and Export pair sits there again.
- **Opening the QR no longer shifts the strip.** The dashboards scroll inside
  boxes that reserve the scrollbar's eleven pixels at all times, so a page
  that grows taller never jerks the tabs sideways when the bar appears.
- **An action no longer erases a run's tags.** The answers a press gets back -
  pause, resume, extend, the entry lock, a release - used to arrive without
  the run's labels; folding them over the list wiped the teacher's own tags
  until a manual reload. The action payloads carry the tags now, and a client
  faced with an empty set keeps the ones the list showed.
- **Deleting a session says why it refused.** The library used to answer every
  server refusal - the run is still running, the run belongs to another teacher,
  the run is already gone - with the same generic line; the message that came
  from the server is now shown, and the delete button reads the reason rather
  than asking to try again.

### Fixed

- **Each single-choice question is its own radio group.** Every option on the
  paper shared `name="choice"`, so two single-choice questions were one group
  and answering the second unticked the first. The group is the question's id
  now, and a paper with two of them is checked for it.

## [0.7.0] — 2026-10-11

Phase 7, and the last of the classroom work before the polish. Everything here
serves one end: the thing being **showable, installable and verifiable** — demo
data with no typing, the whole student run checked in a real browser, an
offline-capable phone client, and the Linux AppImage that has been missing since
0.5.1.

### Demo data

- **A fresh install can be shown without typing anything.** `--seed-demo` (or
  `demo` in the server console) fills an empty database with a class: a course
  with two lessons, a room, four approved students, four tests — one carrying a
  picture — a material, an announcement, and **one finished run with answers in
  it**, so the journal shows real numbers beside the dashes of the tests that were
  planned and never run.
- **It never lands on real work.** The seed refuses a database that already holds
  a course, a test or a room, marks itself so a second call is a no-op, and does
  everything in one transaction: a half-arrived demo would be worse than none.

### The client can be installed, and works with the network gone

- **A manifest and an offline shell.** The student client now carries a web app
  manifest - name, icons including a maskable one, standalone display - and a
  service worker that keeps the app shell so a phone that has lost the Wi-Fi still
  opens what it had.
- **What is cached, and what never is.** Navigations and `GET` requests go to the
  network first and fall back to the last answer, so a screen is fresh whenever
  the server is up; hashed assets come from the cache first; a write is never
  cached and another origin is never answered for. The cache is named after a
  fingerprint of the served page, so a new build retires the old cache without
  anyone bumping a version.
- **A new build is announced, not applied.** Reloading under a student half way
  through a paper would throw their answers away, so a new worker offers a reload
  instead of taking one.
- **`?nosw` in the address removes it.** A worker that has gone wrong on a phone
  nobody can reach has to have a way out.
- **One caveat worth knowing before a classroom tries it:** browsers only give a
  page a service worker over HTTPS or on `localhost`. At `http://192.168.x.x:3300`
  the client works completely but cannot be installed and does not cache - a plain
  HTTP origin is not a secure context. An installable classroom needs an HTTPS
  address.

### A Linux AppImage that starts

- **The AppImage is back**, after being excluded from every release since 0.5.1.
  It really was broken, and not in a way any check could see: `linuxdeploy`
  assembles the bundle by running `patchelf` over every ELF in the AppDir's
  `usr/bin`, and on our `bun build --compile` server that rewrite corrupts it - the
  bundle built, uploaded, and the app segfaulted in silence on startup.
- **The server is a bundle resource now**, not a sidecar: it ships as data in
  `usr/lib/LANtern/`, a directory `linuxdeploy` never scans, and the app finds it
  there. Nothing of ours is left in `usr/bin` but the Tauri app itself, which is an
  ordinary Rust binary and safe to rewrite.
- **And CI runs it before it is published.** The job extracts the produced
  AppImage, starts the server from inside it and asks for `/api/health`; the asset
  goes up only if that answers. An artifact nobody has started is an artifact
  nobody has tested, and this one was proved on the machine the release is cut
  from before the job existed.

### Verification at this release

289 server tests, 83 client tests, 9 Rust tests, typecheck across the three
packages, `pnpm build:server`, `pnpm build:web`, `pnpm smoke:console` and
`pnpm check:browser` — all green. The browser sweep now also drives the whole
student run: join, answer all five kinds of question through the widgets, submit
through the dialog, and read the score — 100% of 7 points — with the server's own
row and the teacher's board agreeing with it. It also checks the manifest, its
icons and a registered service worker.

The AppImage was proved by extracting the artifact and starting the server from
inside it, which answered `0.7.0` with the database ok; the release job does the
same thing before uploading it.

**Migrations:** none since 0.6.0 — the schema is still **v12**, applied
idempotently at startup. A database from 0.6.0 upgrades with nothing to do.

## [0.6.0] — 2026-10-11

Phase 6 «Classroom experience»: the workbench could author a test and run one
class; this release makes the *classroom* work. Three ideas run through it - a
**room is who, a course is what**; a session is something the teacher **opens,
starts and watches**; and a question can **carry a picture**. Every decision was
taken with the real setting in mind: one teacher, a class of phones, no
administrator anywhere.

The nine sub-phases below shipped together as one version. They are in the order
they were built - 6.1 first.

### The journal

- **The table a teacher wants before a lesson.** Students down the side, tests
  across the top, one cell per pair, for a **room** or for a **course**. A cell
  is the student's **last** attempt rather than their best: a best is the
  flattering number, and it is the one that hides a student who guessed once and
  never came back. The attempt count sits beside it, so "80%, once" and "80%, six
  times" read as the different things they are.
- **Nobody is dropped for having done nothing.** A student on the roster who has
  never attempted a test keeps their row, and their cell is a dash. An empty cell
  and a `0%` are different facts - "no attempt" and "attempted and scored
  nothing" - so the export writes the first as an empty field.
- **A room shows what it ran, a course shows its plan.** A test that is planned
  but never run is exactly the empty column worth seeing before the next lesson.
- A cell **opens the attempt behind it** - the same per-student detail the run's
  board opens - and the table exports to CSV or prints. Both screens link to it:
  a room card and a course page each hand over to their own journal.

### Lessons and announcements inside a course

- **A course can be a plan, not a pile.** A **lesson** is an ordered heading; any
  test and any file can be filed under one, and the teacher moves lessons up and
  down. Nothing has to have a lesson: a test added on Friday and a lesson planned
  for Monday are both real, so anything with no lesson is shown at the end rather
  than hidden. Deleting a lesson leaves what was under it behind - taking a
  heading down is not a way to delete the reading filed under it.
- **The teacher can say something to the class.** An **announcement** is a
  sentence first - a file is optional, because requiring one would turn every note
  into a download. Each one names its author, and only its author can take it
  down. Students see the feed at the top of the course.
- **Pictures in a course are looked at, not only downloaded.** Every image
  material now has a thumbnail in the teacher's course page and in the student's,
  and a tap opens it full-screen. A GIF plays.
- Images and plain-text materials are now served **inline** rather than as an
  attachment, so the browser draws them instead of saving them. Everything else
  still arrives as a file, because a file that opens is a file that runs something
  on the teacher's machine.

### Pictures in questions

- **A question can carry a picture**, and so can an option and each side of a
  matching pair. The teacher picks or drops a file where the question is being
  written; the picture is uploaded once and the question points at it by id, so
  the same diagram is sent to every phone in the room and costs one copy, not
  one per student.
- **Pasting works too.** A screenshot on the clipboard, pasted into the
  question's text field, becomes the question's diagram - the usual way a
  diagram gets into a question in the first place.
- **Pictures appear where the answer is given**, in the student's paper, with a
  tap to enlarge; and in the teacher's preview, so what the room will see can
  be checked before the run is opened.
- **The editor says what the paper is worth.** The chips above the questions
  now include an estimated time, and an existing test shows, per question, the
  share of past attempts that got it right - the questions the class misses are
  the ones to look at before running it again.
- **A picture that is not there says so quietly.** An image the server no
  longer holds leaves a gap, not an error in the middle of a paper; and a test
  imported from another machine reports how many pictures it lost rather than
  arriving quietly lighter.
- Images only, up to 8 MiB, and a GIF stays animated.

### One student's run, in full

- **Every row on the board opens.** Click a participant and the run appears in
  full: the questions in the order they saw them, what they answered next to the
  right answer, the points, **how long each question took**, **how many times
  they changed it**, and the score with total and average time. This is the
  teacher's own run, so the answer key is on screen — which is the point of
  looking at it after the fact.
- **Focus loss is recorded where it happens.** The server already logged every
  time a student's window went hidden; it now keeps the count on the attempt
  itself, so the detail view can say so and the test report can average time per
  question — a question that is both hard *and* slow is the one worth teaching
  again.
- **Timings are measured on the question that was on screen.** A paper shown one
  question at a time times each one; a paper shown all at once has no single
  question to time and reports none, and the detail view shows a dash rather than
  a zero.


### Export asks where and in what format

- **Export** (was *Export CSV*) opens the **system save dialog**, so the file
  goes where the teacher wants it and in the format they pick there: **CSV**,
  **TXT** or **PDF**. The filter list in the dialog is the format choice - one
  gesture, not two. It stays disabled until the run is finished, since there is
  nothing final to write out before that.
- The three formats come from **one reader** on the server
  (`GET /api/sessions/:id/results?format=`), so a column cannot come to mean two
  things across them. CSV and TXT keep every character; the PDF uses the standard
  Helvetica, which has no Cyrillic, so names outside Latin-1 are transliterated -
  use CSV or TXT when the exact spelling matters.
- The desktop reads the dialog through Tauri's **dialog** and **fs** plugins;
  in a browser Chromium's own file picker does the same job, and a browser with
  neither falls back to a download.

### The board sits still, and a run's rules fit on one screen

- **The session tabs sit on the board.** The first tab's left edge lines up with
  the board card's border, the open tab's fill runs into the card instead of
  stopping at a line across it, and **All sessions** is built like the tabs it
  sits among rather than as a pill glued to the bottom of the strip.
- **The library folds its filters away.** Search and filters are behind one
  button that counts what is active, and the list - which is what the dialog is
  for - is what is on screen when it opens.
- **A question's type is drawn like the app's other fields.** The browser's own
  dropdown kept the platform's fill and arrow, which on a container surface read
  as a black box with a grey edge.
- **Run details folded in the test editor**, with every setting a test changes
  named on the row, and the **start dialog says, under each test, what a run of
  it would do**: those chips are that test's rules, choosing it loads them into
  the fields, and what is sent applies to that run only.
- **Rooms says what is actually wrong.** A server that does not know the route
  answers "this server is older than the app", and what to do about it, instead
  of "something went wrong" - which sent the teacher looking for a network
  problem they did not have.
- **The board stopped repainting for nothing.** The safety poll re-reads every
  twenty seconds and the socket pushes the whole participant list on every
  change; both used to hand the tab a fresh array and re-render every tile for
  data identical to what was already on screen. The clock that ticks every
  second lived in that tab too, so a run in progress re-rendered the whole board
  once a second - it has a component of its own now, and nothing else on the
  board changes with it.

### Rooms, tags, and runs that can be named

A class and a course were doing two jobs under one word: *who* is in the group
and *what* the group studies. They are two things, they are linked many-to-many,
and everything else follows from taking that seriously.

- **Classes are rooms**, all the way down: the tables, the API (`/api/rooms`),
  the sign-up field (`roomKey`), the tab and every string that says so. A room is
  a key that lets students in without an administrator; a course is a programme
  with materials and tests. The rename is a migration (schema v6) that rewrites
  the referencing foreign keys through `ALTER TABLE` and keeps every key, every
  member and every enrolment that already existed.
- **A room links to any number of courses**, and enrolment follows both ways:
  attach a course later and the students already in are caught up, arrive later
  and they are caught up too. Whichever happens last, the two are in step, so a
  teacher never has to think about it.
- **Tags** are the free labels a teacher puts on tests, sessions and courses -
  "algebra", "chapter 4". Deliberately not a group: what class something belongs
  to is a foreign key, because a room can be joined and revoked and a label
  cannot. One call, `PUT /api/tags/:entity/:id`, answers with the state that
  resulted rather than with the request.
- **Tests and runs can be pointed at a room and labelled**, and a test copy keeps
  both, because a copy is the same paper for the same class.
- **A session can be named**, and its room defaults to the test's own - most of
  the time the paper was written for one group and that is who is in the room.
  The Live board shows the name, the room and the labels.
- **The session list takes filters** - room, test, status, date range, word and
  tag - so the archive has something to search once 6.2 gives it a screen.
- **The client copes with a server older than itself.** A server that has not
  been restarted since 6.1 answers without `name`, `roomId` or `tags`, and one
  read of `session.tags.length` threw while the Live board rendered - which did
  not blank a card, it aborted the render of the page, so the whole workbench
  froze and every tab looked like the Live tab. The gaps are now filled at the
  network edge, where the client is the only side that knows it is talking to a
  server it does not control. Restart the server (or rebuild the desktop
  sidecar) to get the rooms and labels themselves.

### A run can be tuned

- **Settings for a run**: shuffle the questions, shuffle the answers, reveal the
  correct ones never or after submitting, show results at once or hold them, one
  question at a time or the whole paper, and whether going back is allowed. A
  test stores its defaults; a **session snapshots them when it is created**, so
  editing the test afterwards cannot change a run that is already under way. The
  start dialog can override them for one run, and they can still be changed in
  the lobby — and only there, because the paper is handed out at the start.
- **Held results.** With `releaseResults: teacher`, submitting shows the student
  that they are done and nothing else; the teacher's board grows a **Release
  results** action, and until they press it the result endpoint refuses. Then it
  flips once, for everyone.
- **Hidden answers.** With `showCorrectAnswers: never`, the per-question
  breakdown arrives without the key in it — the same shape, with the answer
  taken out.
- **One question at a time.** With `questionsPerPage: one`, the student sees a
  pager, an index, and a Back button when the teacher allows one.
- Shuffling is a setting now rather than a habit: questions were always
  shuffled, and a test built as a sequence can keep its order. Options are
  shuffled per student and **fixed at join**, so a reload shows the same paper
  rather than a fresh shuffle.

### A run opens in a lobby, and the room reports itself

A session used to exist only once it had started: creating one began the clock
and opened the doors in the same breath, so a teacher had to create it with the
class already watching.

- **A session is born in a lobby.** Students walk in, see that they are in, and
  nothing is timed. The clock starts when the teacher presses **Start**, and the
  press reaches every phone at once. Answering before that is refused: the paper
  has not been handed out.
- **Closing entry** stops new students joining while leaving the ones already in
  alone — a reload during a locked run must not throw anybody out.
- **The board says what the room is doing.** Behind each student: *here*,
  *answered 3*, *away* (the window is hidden) or *offline* (the socket closed).
  The student's phone reports its own visibility and progress over the same
  socket that carries the start.
- **Leaving the window is recorded, not punished.** A visibility change appends
  one row to a new event log; nothing is auto-submitted and nobody is blocked.
  The paper quietly notes afterwards that the student stepped away.
- Server: schema v7 rebuilds `live_sessions` (SQLite cannot widen the `status`
  CHECK in place) to allow `lobby` and a null `startedAt`, and adds
  `entry_locked` and `participation_events`; `POST /api/sessions/:id/start`,
  `PATCH { entryLocked }`, and the WebSocket takes a student's `presence` and
  `progress`.

### Live: session tabs and a library

The Live tab showed a row of pills and one board, and finding an older run meant
scrolling a strip whose ends never said what was beyond them.

- **The sessions are tabs**, as many as fit across the top of the board - measured
  with a `ResizeObserver`, not guessed - and the rest live behind a button beside
  them that leads to the library. A tab carries the status dot, the run's name
  and its join code.
- **The library** opens from that button: search by name or test, filter by
  status, test, room, label and date, sort by newest, name, status or number of
  submissions, and page through the result with a count that is real.
- **One unit**: the tabs are the top edge of one card, and the selected run's
  hero, board and participants sit inside it - so which board belongs to which
  tab is never a question.
- Server: `GET /api/sessions` grew `sort`, `dir` and `offset` and now returns
  `total` - the size of the filter, not of the page; `GET /api/sessions/:id`
  answers with one session in the same shape the list uses.
- **The surfaces read as surfaces again.** Grouping the board into one sheet had
  flattened it: the cards lost their borders and the run's code block and the
  four tiles sat on the page colour, so in the dark theme they were the same
  black as the card they were on. The cards are bordered panels once more, and
  what sits inside them is one step up with an edge.
- **The library's own controls look like controls**: the selects and the date
  fields are drawn like the app's inputs with an arrow of ours, and the status
  chips are bordered pills at a full tap height. The harness renders the dark
  theme now too, which is where those holes only showed.

### The teacher's Live tab, rebuilt around the run in progress

The tab had grown by accretion - a code, then a QR, then four controls, then a
participant list - and none of it had a shape. It now reads in the order a
lesson runs.

- **The session is a card with a face**: status, the test behind it, when it
  started, and a clock - elapsed, or a countdown when the test has a time limit,
  turning red in the last minute and saying so when it runs out.
- **Students join from one block**: the code large, a copy for the code and one
  for the link, and the QR behind a button, with the address it encodes beneath
  it and the unreachable-address warning kept exactly where it was.
- **A live board**: joined, submitted, passed and not passed as four tiles over
  a submitted/total bar, with the class average and "N still working" below it.
- **Participants carry their result**: a monogram that takes the pass or fail
  colour, the percent, and the time they handed their paper in.
- **Starting a session is a dialog** with the test picker, not a card that
  pushes the page around.

### The Tests and Courses tabs in the same vocabulary

- **Tests**: the card shows what a test is - title, the description that was
  never shown, and the meta as chips; duplicate, export and delete become icon
  buttons with tooltips; the list searches by title from four tests up; the
  editor owns the tab with a heading, a way back, and count and points chips.
- **Courses**: creating one is a dialog; the card shows the description and the
  students/tests/materials counts as chips; the details screen gets the same
  header and count badges as the editor.
- **One action colour per tab**: the main action of a tab is the filled primary
  button - start on Live, new on Tests and Courses - where "new" used to be
  green on some screens and blue on others.
- **Rooms** (called classes until 0.6.0, see above): creating one is a dialog; on
  each room card the reading actions (QR, students) stay as words while rename,
  re-key, revoke and delete become icon buttons with tooltips - revoke had been
  rendering both a tooltip and its own label; the members list picks up the
  participant-row style; approve takes the primary colour it always deserved. The
  address card, the key display and every string the classroom flow depends on
  are untouched.
- **The results journal**: its four headline numbers use the same tile shape as
  the Live board - icon and label above the figure, colour only where the figure
  means something (average in the primary, pass rate in the success colour, and
  a dash in the plain colour when a test has no pass mark to compute one).

### Verification at this release

283 server tests, 73 client tests, 9 Rust tests, typecheck across all three
packages, `pnpm build:server`, `pnpm build:web`, `pnpm smoke:console` and
`pnpm check:browser` — all green. The browser sweep is a real Firefox driven over
WebDriver BiDi, and it walks the screens this release added: a room and the
address students open, the session library, a lobby and its start, one question
per page, a picture in a question and on the paper, lessons and announcements in
a course, and the journal — its table, a dash where nobody has done the test, a
cell opening that student's attempt, and the way in from a course.

One check in that sweep still reports a failure on a machine where a public
address has already been set: the case it proves — that the tab warns when none
is — can only happen once, on a server that has never had an address. It is a
precondition, not a defect, and it is left visible rather than special-cased.

**Migrations:** schema v6 through **v12**, all applied automatically and
idempotently at startup; no manual step. v6 renames `classrooms` to `rooms` and
its members, and moves the single course link into `course_rooms` before dropping
the old column; it ships with a post-migration integrity check and a test against
a populated file. v7 rebuilds `live_sessions` to let a run open in a `lobby`, v8
adds the run's `settings` snapshot, v9 the pause stamp, v10 the per-question
attempt detail, v11 `assets` for pictures, and v12 lessons, announcements and the
nullable `topic_id` on tests and materials. An existing database upgrades in
place; nothing is lost.

## [0.5.1] — 2026-10-10

A class that runs without an admin in the room, and the pass over the interface
that had been waiting for it: one account menu instead of two, a header that
stops moving when it opens, a sign-up form in the order a person actually reads
it, and a motion vocabulary that says something. The Linux desktop build stops
flickering too — that one was a WebKitGTK renderer bug in a CSS costume, and no
amount of styling was ever going to fix it.

### One teacher, no admin

The product is a person with a laptop and a room full of phones. Everything
around that had an admin standing in front of it for no good reason.

- **First boot seeds a teacher, not an admin.** An empty data folder creates one
  `teacher` account, so the shortest path from a fresh install to a class is:
  start the server, sign in, make a class, show the key. Previously it was: start
  the server, sign in as admin, create a teacher, sign out, sign in as teacher.
  `TEACHER_USERNAME` / `TEACHER_PASSWORD` set the credentials;
  `ADMIN_USERNAME` / `ADMIN_PASSWORD` still work as fallbacks so existing
  installs and scripts are untouched.
- **An admin is optional and creatable later** — the server console gained
  `admin <username> <password>`. The institution-wide screens (full roster,
  stats, participants) are still there for a school that wants them; a single
  teacher never has to see one.
- **A teacher can set the public address.** It goes into the QR code students
  scan, so a teacher on a machine with no admin could not make a single phone
  connect. `PATCH /api/settings` is now admin-or-teacher.
- **A teacher can read the server log** — `GET /api/logs` and the `/ws/server`
  tail, admin-or-teacher. A student is still refused: a log names who signed in
  and what failed.
- **A teacher can let a waiting student in.** `GET /api/users/pending` lists the
  students who registered without a class key, and the teacher's **Classes** tab
  shows them with Approve / Refuse. A teacher may change the status of students
  only — `403` for another teacher, because one teacher must not be able to lock
  a colleague out of a room they share the server with. The full roster and
  deleting accounts stay admin-only.

`apps/server/tests/solo.test.ts` walks the whole path from an empty folder to a
class in progress, asserting at every step that no admin was created.

### The account menu, polished

The one menu the header opens, in both apps, tidied up.

- **A Settings row in the desktop app** — above Language, holding the one thing
  the desktop app has and a browser tab does not: whether the window keeps its
  system title bar. Turning it off takes the minimize, maximize and close
  buttons with it, because that is where they live. The choice is remembered and
  applied at the next start, decorations before geometry. The row is not
  rendered where there is no window to configure, so the desktop frontend opened
  as a page offers a menu with no dead switch in it.
- **Tooltips paint above the menu**, not under the row beneath them, and the
  avatar and the name carry `Full name · username`. A tooltip on text that is
  already fully on screen stays quiet.
- **Sign out is a tonal danger button** — grey at rest like the other filled
  controls, red where the cursor is.
- **Nested panels line up with the row that opened them**, first row centre to
  first row centre.

### The header, settled

- **The account menu floats at the window corner** — it hangs below the top bar
  by the same inset it keeps from the screen edge (16px, 12px on narrow
  windows), instead of touching the bar. The avatar sits exactly over the
  sign-out button of the opened panel: the header block recedes 12px, and both
  controls are 40px, so centre meets centre.
- **The server pill keeps the icon and the state word**; the word "Server"
  moved into a hover tooltip that spells the state out in full.

### The sign-up form, straightened

- **The class key is asked first** — it decides whether the account is approved
  at all, and it is checked before anything below it is typed. Username sits
  above Full name.
- **Password and confirm password carry the same reveal toggle the sign-in
  field has** — one per field, an eye icon, a tooltip on hover.
- **Back to sign in sits under Create account**, the same size as it, instead
  of floating above the card.

### Motion

The stylesheets carried motion tokens for a long time; almost nothing used
them, so every state change snapped. All of it runs on the compositor —
`transform` and `opacity` only, as the paint rule requires.

- **Hover and press are animated.** The state-layer tint fades in 120ms, and a
  control squishes a hair under the pointer and settles back on lift — pressing
  takes a short accelerating curve, lifting a longer settling one, which is
  what makes the release read as weight rather than a snap.
- **Menus open on the emphasized curve** — fade, a scale from the corner they
  hang from, and the rows arriving in a 25ms-step stagger. Closing is faster
  and accelerating, and rows stop accepting clicks the frame the exit starts.
  Nested panels animate in and out under a `<Transition>`, with their own rows
  staggered.
- **Tooltips fade, and wait their second.** The hover delay had drifted into
  the wrong rule — the one for the state being left — so a tooltip appeared
  instantly and lingered a second after the pointer left. The delay now sits in
  the state being entered: a second of rest before it shows, a quick fade when
  it goes.
- **Dialogs arrive from below** — scrim fade and an emphasized panel entrance,
  the keyframes the dialog shell's comment always promised but the stylesheet
  never had.
- **Switch thumbs slide** on `translate` (260ms, emphasized); the checkbox tick
  pops in; the role segments on the sign-in screen and the server pill gained
  the state layer.
- **`prefers-reduced-motion` is honoured** — the override the base-layer
  comment promised but the stylesheet never had: durations collapse to
  nothing, delays to zero.
- **Everything animated carries its layer from birth.** In the desktop's
  software-composited webview an unpromoted fade or scale re-rasters the whole
  window surface every frame, and the motion read as flicker and jerk. The
  menu panel and its rows, the state-layer tint and press, tooltips, dialogs
  and the theme thumb are promoted up front (`will-change`), so a frame costs
  a blend instead of a raster.
- **Tabs slide.** The tab indicator takes the emphasized curve when a tab is
  chosen, and snaps — no slide — for the first placement and for window
  resizes, where a glide would read as lag. The tabbed sheet itself fades in
  and out instead of teleporting.
- **Fixed: the whole window flickered as anything repainted.** The cause was
  not the animation code — a frame-by-frame trace in a real browser showed the
  opacity curve moving cleanly, with no restart. It is a known WebKitGTK fault:
  its DMA-BUF renderer asks some Linux GPU drivers (NVIDIA above all) for
  buffer formats they do not provide, and every repaint shows a torn frame.
  The desktop entry point now sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before
  the webview is created — the workaround the Tauri docs prescribe — unless the
  environment already carries a value, so a working setup can keep the fast
  path.
- **The menu motion was slimmed for the software rendering path.** The per-row
  stagger ran a dozen animations at once, and the panel scaled — which
  re-samples its text every frame. Both are gone, leaving one promoted layer
  that fades and slides. Nested lists also stopped flashing on close: their
  exit keyframe was snapping back to full opacity for the frame before Vue
  removed the node.
- **Tab labels ease into their colour** in step with the indicator sliding
  under them, so the highlight arrives with the text instead of behind it.
- **The theme switch's sun and moon turn through each other** rather than
  swapping on a single frame.
- **Loading placeholders wait before they appear.** A fetch against the local
  server answers within a frame or two, and a skeleton that flashed for that
  frame interrupted every tab switch; the placeholder now stays invisible
  through a short delay and shows only when the wait is real.
- **The role picker on the sign-in screen became a segmented control** with the
  same sliding indicator the tab strips use — one fill travels between Student
  and Teacher instead of each cell repainting its own.
- **Tooltips wait, then fade.** The panel is `display: none` while hidden, and a
  transition does not run out of a state the engine never laid out — which is
  why the tooltip appeared instantly, without its fade. The rest (now 1.2s) and
  the fade are a keyframe animation instead, which does start when the element
  becomes visible; the delay is held by `backwards`.
- **Nested menus (Settings, Language) slide in two directions at once** — in
  from the right and down from above — instead of only downward.
- **The "Keep me signed in" checkbox got its M3 interaction.** The check draws
  in with a turn, the box squishes under the press, and the state layer is a
  circle around the box alone — hovering the row lights the box, never the
  label.
- **The role segments on the sign-in screen slide on a measured offset** rather
  than a percentage transform — the same px path the tab strips use. A fill
  positioned with a percentage in a transform is re-sampled as it moves, and
  the software renderer shows that as a stutter.

### Verification at this release

230 server tests, 62 client tests, 9 Rust tests, typecheck across all three
packages, `pnpm build:server`, `pnpm build:web`, `pnpm smoke:console` and
`pnpm check:browser` — all green. The browser sweep is what caught the last
regression here: a nested list closed while it was still opening kept both sets
of transition classes at once and was never removed, leaving a panel open over
the page that swallowed the next click anywhere. Four checks failed on it, and
they are in the file because of that.

**Migrations:** none beyond 0.5.0's schema version 5 — this release changes no
API and no schema. The desktop package picks up `WEBKIT_DISABLE_DMABUF_RENDERER`
at startup, which trades hardware acceleration for a renderer that stops
flickering; set it yourself to keep acceleration and the flicker.

## [0.5.0] — 2026-10-08

Phase 5 «Deployment», the three ways the system is actually used, made to work
end to end: a desktop that carries its own server, a school machine serving the
room, and a class that gets in without an admin present.

### 5.1 — reachability: the address students can actually open

The join link was built from `window.location.href`, which is `tauri://localhost`
in the desktop app and `http://localhost:3300` in a browser on the teacher's
machine. A phone can open neither, so the QR code was decorative.

- **A public address for the school**: `GET /api/settings` for any signed-in
  role, `PATCH /api/settings` for admins, stored in `app_meta` under
  `public_base_url` (no migration — the key/value table was already there). The
  value is validated and normalised: absolute, `http`/`https`, no path, no query,
  no credentials, no trailing slash.
- **Address suggestions**: the server reports the IPv4 addresses it answers on,
  each with the port it actually bound. Loopback is excluded on purpose — offering
  `127.0.0.1` as a suggestion would be exactly the wrong advice.
- **Admin → System & DB → Public address**: the current value, the suggestions as
  one-tap chips, a field for anything else, and a warning while typing an address
  a phone cannot open.
- **The teacher's Live tab prints the address that is in the QR code**, and when
  that address is `localhost`, `127.0.0.1`, `0.0.0.0` or `tauri://localhost` it
  says plainly that a phone cannot open it and that the code can still be typed.
- **The join link comes from the server's address**, not from the window the
  teacher happens to be looking at. `joinLink()` moved out of the Live tab into a
  pure function with the reachability check next to it, both unit tested.

### 5.2 — a classroom with a key

A teacher alone in a room could not get anybody in: a self-registered student is
`pending`, only an admin can approve, and the teacher cannot manage users. The
answer is a scoped key, not more power.

- **`classrooms` and `classroom_members`** (migration v5): a teacher's class, its
  six-character key from the same alphabet as a join code, and who arrived
  through it. The key approves one thing — a student account — and nothing else:
  the role is hard-coded in the handler, so no key, however it was obtained,
  produces anything but a student.
- **Teacher API**: create, list own, rename, revoke, issue a new key, delete.
  Another teacher's class answers `403` for every one of them; a student is
  refused. A wrong key and a revoked key both answer `404` with the same message,
  so a key cannot be used to discover which classes existed.
- **`GET /api/classrooms/preview?key=`** is public: the sign-up form says
  "Class 9A · Olena M." before a student types a password, and nothing is created.
- **`POST /api/auth/register` takes an optional `classKey`.** Valid → approved
  immediately, the classroom records the student, and a class linked to a course
  enrols them there too. Wrong → `400` and *nothing is created*, so the name
  stays free and the student can fix the code. No key → unchanged (`pending`).
- **Teacher → Classes**: the key large enough to read from a desk, a QR that
  opens the sign-up form with the key filled in, the students who came in, and
  rename / new key / revoke / delete. A class with students can be revoked by
  deleting it — deliberately, since revoking must not look like removing people.
- **Sign-up screen**: an optional class-code field, with the class named as you
  type, and two different success messages: "you can sign in now" through a key,
  "waiting for approval" without one.
- `utils/joinLink.ts` is now `utils/links.ts` and also builds the registration
  link. Both builders refuse a scheme with no origin — `new URL('tauri://localhost').origin`
  is the string `"null"`, which would have put `null/?join=…` into a QR code.

### 5.3 — the server console

The server wrote pino JSON and could not be talked to; the desktop had no log
view at all. Now there is one log stream with three readers, and a console that
acts through the same functions the API calls.

- **Human lines on a terminal, JSON in a pipe** — wall clock, relative age,
  colour-coded level, aligned columns, and a request as `→ GET /api/tests 200`.
  A pipe gets the JSON pino wrote, byte for byte, so `systemd`, `journalctl` and
  CI keep parsing what they parsed before.
- **One line per request, with the duration.** pino logged every request twice
  ("incoming request", "request completed") and never said how long it took; the
  pair is replaced by one line whose level follows the outcome — `error` for 5xx,
  `warn` for 4xx, `info` otherwise.
- **`token=` never reaches a log line.** Browsers cannot set headers on a
  WebSocket handshake, so the token travels in the query string and Fastify logs
  the whole URL. That was already true on stdout, but now the same line is
  rendered in a browser tab, where it would be read, copied into a bug report or
  photographed — and it is valid for twelve hours.
- **A ring buffer of the last 500 lines**, with `GET /api/logs?since=` and
  `WS /ws/server` serving it. Both admin-only: a log names who signed in, which
  accounts exist and what failed. One socket carries both halves — the backlog
  the client missed, then each new line — so a reconnect is exact.
- **Interactive console** when there is a terminal: `help`, `status`, `sessions`,
  `users`, `students [pending]`, `approve`, `block`, `password`, `level`, `clear`,
  `stop`. Off with `--no-console`, and off by itself when stdin is a pipe — which
  is what the desktop app and every CI run are. `approve` and `block` call the
  same `setUserStatus` the HTTP route calls, so blocking revokes live sessions in
  both places or in neither.
- **Admin → Server tab**: the live tail with level filters and counts, pause and
  clear, the server status, and the students waiting for approval — the same
  calls the Users tab makes, next to the log where the question "why is nobody
  getting in?" gets answered. Restarting is not offered on purpose: an HTTP
  request that killed the process serving it would be a strange thing to send.
- `pino` is now a declared dependency of the server. It already was one —
  Fastify's logger *is* pino — but the app now constructs the instance itself to
  own the stream; no new package was downloaded.

### 5.4 — the desktop app as a host

The bundle now carries the server and starts it, so a teacher needs nothing else
running and nothing installed but the app.

- **The server is a Tauri sidecar.** `src-tauri/src/host.rs` spawns it with
  `std::process`, pipes its output into Tauri events, and reports an exit nobody
  asked for with its code. No new Rust dependency. The module knows nothing about
  Tauri — it is handed two closures and a resource directory, which is what lets
  its tests spawn a real server and check the banner arrives through the pipe.
- **A Server screen** reachable without signing in, because starting the server is
  the one thing a teacher may need *before* they can: stopped or running with a
  pid, start / stop / restart, open in browser, the live output with level filters,
  copy and clear.
- **Host settings** — port, data folder, student client folder (`--webroot`),
  server binary path, seed admin password — saved next to the app and applied on
  the next start. The first run shows defaults and a Start button; nothing starts
  silently.
- **A missing binary is a message, not a crash**: the Start button is disabled and
  the screen lists every path it looked in, with the command that produces one. A
  development build without a bundled server is a normal state.
- **The API base is a variable now.** `VITE_API_TARGET` was a build-time constant,
  which meant moving to another port needed a rebuild — impossible for a teacher
  in a computer room. It follows the setting.
- **`POST /api/auth/password`** (any role, requires the current password): the
  seed variable is read once, when a data folder has no admin yet, so changing an
  existing admin password had no API at all. Every session ends, including the one
  that made the change, and a new token comes back.
- **The public address is visible and editable here too** — the address a phone
  opens is the server's setting, so the desktop screen shows it, offers the
  addresses the server answers on, and lets an admin change it.
- **Open in browser uses the LAN address**, not `localhost`: showing a student
  their own teacher's loopback is how a lesson fails to start.
- **The seed warning goes through the log.** It was written with `console`, which
  bypassed the log stream, so the desktop showed it as an untyped error line.
- `scripts/desktop-sidecar.sh` (`pnpm desktop:sidecar`) places the binary where
  Tauri looks for it; CI runs it before every `tauri build`, on Linux and Windows.

**Also on the server**: the startup banner and the seed warning now carry a level
(`warn`), so they are warnings everywhere rather than untyped text.

### 5.5 — making it verifiable

Two checks that run without a human looking at a screen, and one that already
paid for itself.

- **`scripts/browser-checks.mjs`** (`pnpm check:browser`) drives a real Firefox
  over WebDriver BiDi **with no dependencies of its own** — a WebSocket and some
  JSON, because a check that needs a package install will not be run by the
  person who needs it. It creates the accounts, test, session and class it needs,
  deletes them afterwards, and reports per screen and width: horizontal scroll,
  elements past the right edge, touch targets under 30px, unnamed controls and
  untranslated keys — across three roles × two languages × three widths, then one
  happy path per role (the QR address and its warning, the class key, the admin
  console, a student who signed in with a class key). Screenshots of a failure
  come out of the same run.
- **`scripts/console-smoke.sh`** (`pnpm smoke:console`) runs the binary under a
  pty, sends `status` and `approve nobody`, and checks the output is
  human-formatted — then runs it again with the output piped and checks every
  line is still JSON. Wired into the release workflow's server job.

**Fixed by the smoke test, on the day it was written:** Fastify 5 prints a
deprecation notice for the top-level `disableRequestLogging` option, as plain
text, into stdout — which broke the promise that a piped run is machine-readable
for `systemd`, `journalctl` and CI. It now uses `logController`, which is the
supported form.

### Renamed — the project is **LANtern**

The name settled here; everything that carries it followed, because a project
whose own artefacts are called something else is harder to talk about than it
needs to be.

| Was | Now |
|---|---|
| `knowledge-testing-system` (repository) | `lantern` |
| `@testing-system/*` (workspace scope) | `@lantern/*` |
| `testing-system-teacher` (Rust crate) | `lantern-teacher` |
| `testing-server` (server binary, sidecar) | `lantern-server` |
| `testing-server_<version>_linux-x64` (asset) | `lantern-server_<version>_linux-x64` |
| `web-client_<version>.tar.gz` (asset) | `lantern-web_<version>.tar.gz` |
| `com.testingsystem.teacher` (app identifier) | `com.lantern.teacher` |

The display name stays **LANtern**; only paths, packages and file names are
lowercase. GitHub redirects the old repository URL, so existing clones and
badges keep working.

**Two consequences worth knowing:** the desktop app's identifier changed, so
Linux and macOS look for its settings in a new folder — the first run of 0.5.0
shows defaults again, and the port and data folder have to be re-entered if they
were changed from the defaults. And the desktop bundle name follows
`productName`, so the downloaded app is still `LANtern_0.5.0_*`.

**Not renamed:** the exchange format identifier `knowledge-testing.test` inside
exported and imported files. It is a data contract rather than a name — changing
it would make every file a teacher exported in 0.4.x unimportable.

### Verification at this release

220 server tests, 62 client tests, 9 Rust tests (including one that starts the
real server binary and one that captures the exit code of a failing one), 7 of the
server tests covering the password endpoint, typecheck across all three packages,
both builds, `cargo test`, `pnpm smoke:console` and `pnpm check:browser` — all
green.

**Migrations:** schema version 5 (Phase 5.2 adds `classrooms` and
`classroom_members`). `public_base_url` needed no migration — `app_meta` was
already a key/value table. An existing database upgrades on first start with no
action.

## [0.4.2] — 2026-10-07

The interface pass. Sizes that do not depend on the language, motion that comes
from the Material 3 Expressive tokens instead of ad-hoc transitions, a language
menu with flags, shorter text — and the name.

### Added
- **`AppDialog`**: one dialog shell for every dialog, with the scrim fading and
  the panel arriving on the emphasized spring. Bottom-sheet on a phone, centred
  card above that.
- **`TabStrip`**: tabs of equal width with icons and a sliding indicator, so the
  tab bar is the same size in every language. The admin's pending counter moved
  into it as a badge.
- **Language menu with flags**: one fixed-size control that opens a proper menu
  (arrow keys, Escape, click outside) with a drawn flag per language. The flags
  are SVG, not emoji — AGENTS.md bans emoji, and emoji flags render differently
  everywhere anyway.
- **Motion tokens** (`theme.css`): durations 90–400ms, the M3 standard,
  decelerate and accelerate easings, and the emphasized spring sampled into
  `linear()` so it keeps its overshoot. Toasts arrive on it, cards lift on it,
  buttons press into themselves, and skeletons breathe row by row instead of
  blinking together. `prefers-reduced-motion` collapses all of it.
- **`BrandMark`** and a brand folder: the LANtern mark, the app icon, the lockup,
  and a generated set of assets — favicon (SVG + ICO), Apple touch icon, PWA
  sizes, a maskable icon, and the five Tauri icon files including a hand-written
  `.icns`. `docs/brand/README.md` says which format goes where and how to
  re-export after new artwork.

### Changed
- **The project is LANtern** — a lantern on a LAN. In the UI, the window title,
  the desktop product name, the page title, the README and the description
  packets; the import error now says "not a LANtern test file". The npm scope
  (`@testing-system/*`) and the repository name stay: they are not user-facing.
- **Buttons have a fixed box.** M3 keeps a label to one line and never lets it
  wrap or truncate; the heights (36/40/48px) and the icon squares come from
  tokens, and the label is `nowrap`. The Ukrainian login screen used to scroll
  sideways because "Адміністратор" became a grid column's minimum width — the
  role labels are short now, the grid cells have `min-w-0`, and the document is
  exactly as wide as the screen.
- **Header controls keep their size**: the status pill is one short word with no
  wrap, the tagline hides on narrow screens, and theme, language and sign-out
  are all fixed boxes.

### Fixed
- **Escape closes the language menu** even when focus has left it.
- **The question editor no longer scrolls sideways on a phone.** A `<select>` is
  as wide as its widest option, so "Коротка відповідь" pushed the row past a
  320px screen; the select can shrink now (`min-w-0`), and nothing is lost
  because the type is already named in the card header.
- **The admin filter row wraps** instead of overflowing between 640 and 768px.
- **`AppButton` no longer forces `position: relative`**, which silently beat the
  `absolute` a caller passed in — that is why the password eye button had ended
  up below its field.

## [0.4.1] — 2026-10-07

The tails of the earlier phases: share and duplicate tests, keep authoring when
the server is not there, and one component each for the card and the text field.

### Added
- **Duplicate a test** (`POST /api/tests/:id/duplicate`). The copy belongs to the
  caller and its questions get new ids, so editing it cannot reach the original
  — which is the point at the start of a term.
- **Share a test as a file** (`GET /api/tests/:id/export`, `POST
  /api/tests/import`). The export carries no ids, no owner and no timestamps,
  and does carry the answer keys: a colleague has to be able to run it.
  Positions are renumbered on the way in, so a hand-edited file still imports,
  and every question is validated with the editor's own rules.
- **Authoring that survives an absent server.** A save that cannot reach the
  server becomes a local draft, listed above the tests with Open / Upload /
  Discard. Drafts upload themselves the moment the server answers again; one
  that is rejected keeps its place for the next attempt, a second draft of the
  same test replaces the first, and an abandoned empty form is not kept.
- **One `AppCard` and one `AppInput`** (44 and 15 call sites), after `AppButton`
  in 0.4.0. Text links, table sort headers, clickable rows and tab strips stay
  raw elements on purpose: they do not look like buttons, so they should not
  behave like one.
- **A test that every `t()` in the sources has a message.** A missing key does
  not fail a build — vue-i18n prints the key — so the i18n test now walks the
  sources. It caught one: the pass-mark field in the editor asked for
  `teacher.tests.passingPercent`, which exists in neither locale, so the UI
  showed the raw key where a label should be.

### Fixed
- **A request with no body no longer claims it carries JSON.** The client set
  `content-type: application/json` on every non-GET call, and Fastify answers
  those with "body cannot be empty". Every mutation without a payload was
  failing: delete a test, pause / resume / finish a session, approve or block a
  user. Found by clicking the buttons in a real browser rather than by reading
  the code; the rule now has two tests of its own.

## [0.4.0] — 2026-10-06

Reporting: the numbers a teacher acts on, and the ways to get them out of the
building. And the consistency pass the UI needed before a release — one button
component, and touch targets a thumb can actually hit.

### Added
- **Grade journal per test** (`GET /api/tests/:id/results`, teacher only). One
  row per student across every session that test was run in: attempts, best,
  last and average percent, plus the class figures. The class average and the
  pass rate are judged on each student's *last* attempt, so someone who improved
  since the first try is not counted as a fail, and the pass rate stays unknown
  (`null`) for a test without a pass mark instead of reading as 0 percent.
- **Per-question difficulty**, in the same response: for every question, how many
  students answered and how many got it right, across all attempts. The journal
  screen opens from a test row and leads with the questions under 50 percent,
  because that list is what says what to reteach.
- **CSV export per session** (`GET /api/sessions/:id/results.csv`): a header
  block with the test and the session, then one row per participant. Fields are
  escaped, the file carries a UTF-8 BOM so spreadsheets do not mangle non-ASCII
  names, and a session nobody joined exports the header rather than dividing by
  zero.
- **Printable report.** The journal screen prints through the browser's own
  dialog: the app chrome is dropped, the theme collapses to ink on white, and
  the difficulty bars keep their fill (`print-color-adjust`). No PDF library.
- **Student side, completed**: the courses the student is enrolled in with their
  materials, the result of every finished attempt on the home screen, and a QR
  code for the join link on the teacher's board (rendered by `uqr`, the one
  dependency added).
- **Desktop About dialog** with the app version (read from `tauri.conf.json`,
  the file the bundles are actually built from) and the server address the app
  talks to. Reachable from the header, with the usual focus trap and Escape.
- **The desktop window remembers its size and position.** Tauri only does that
  when the config asks it to, which would also pin the size across monitors with
  different scaling, so the geometry is stored locally, restored on start and
  written back (debounced) whenever the window is moved or resized.

### Changed
- **One `AppButton`** for the whole system: 66 buttons across both apps used to
  carry 24 near-identical copies of `rounded-lg … px-3 py-1.5 text-xs`. The
  component holds the variants and enforces the height floor. Text links, table
  sort headers, clickable cards and tab strips are deliberately left as plain
  buttons — they do not look like buttons, so they should not act like one.
- **The client API layer has one request path.** `apiFetch` and the new
  `downloadFile(path, filename)` share a `request()` helper, so the bearer
  token, the content-type default and the error envelope are handled in one
  place instead of twice. The export is fetched with the token and saved through
  a blob URL, never a plain link: the API authenticates with a header, not a
  cookie, so an `<a href>` would have been rejected.
- **Desktop window title** is `Knowledge Testing`; it no longer carries a
  person's name.

### Fixed
- **Touch targets.** The status chip, the locale buttons and the join-code field
  were 24–28px and the primary actions 28px — below what a thumb needs on a
  phone. They are 36–48px now, the table sort headers are 32px, and the header
  wraps instead of scrolling sideways at 320px. Found by measuring every
  interactive box in a real browser, at 320, 390, 768px and on the desktop at
  800×560 and 1080×720.
- **Dialog focus.** A template `ref` on a component resolves to the instance,
  not to its element, so the dialogs that pass their close button as the initial
  focus target silently failed to move focus into the panel.
- **`/api/sessions/current`** no longer hands a student a session they only
  opened. It returns participations in status `joined`, so a finished attempt no
  longer hides the "you already took this" state.
- **Double course fetch on the student home**: the dashboard and the course card
  both loaded the same list on mount.

## [0.3.0] — 2026-09-30

The classroom loop, end to end: a teacher starts a live session, students
join from their phones with a code, answer against a countdown, and get a
graded result. Schema moves to version 4.

### Added
- **Phase 3: the student side, end to end.** The student home was three
  placeholder cards; it is now a working flow:
  - *Join* — the six-character code the teacher reads out. The input upper-cases
    and drops anything that is not a letter or digit, and the server normalises
    case and stray spaces, so a code pasted from a slide just works.
  - *The paper* — questions in a per-student order that stays stable across
    reloads, with every answer key stripped from the payload. All five types
    render as real inputs: radio, checkboxes, true/false, free text, matching.
  - *The clock* — corrected for the round trip to the server, so a device with
    a drifting clock still sees the real deadline. It turns amber in the last
    minute and submits the paper itself at zero.
  - *Submit* — with a confirmation that states how many questions are answered.
  - *Result* — percentage, score, pass mark and a per-question breakdown with
    the correct answers, marked green or red.
- **Phase 3: live session API and schema.** `live_sessions`, `participations`
  and `participation_answers` (schema v4). Teachers start a run of their own
  test, pause/resume/finish it, read the participant board and review the paper
  with the answer key. Students join by code, re-read the paper and the clock,
  submit, and read their graded result. The time limit and pass mark are
  snapshotted per session, so editing a test mid-run changes nothing.
- **Scoring engine** (`lib/scoring.ts`) as pure functions over all five
  question types: option keys for choices (set equality — duplicates never
  collapse into a match), booleans, trimmed case-insensitive text against the
  accepted list, and full pair mapping. Unanswered or malformed input scores
  zero. 32 unit tests.
- **Timeout handling in two places.** The client clock submits at zero, and
  every server entry point that grades or closes a session also sweeps expired
  participations — so a teacher who forgets to end a session costs nobody their
  attempt: the paper is auto-submitted with zero and the session closes.
- **20 server integration tests** over the whole cycle, including that no
  answer key ever reaches a student, that shuffles are stable, and that a
  second submission is rejected.
- **Phase 3: the teacher side.** The teacher dashboard opens on a **Live** tab:
  start a session from any of your tests, read the join code at a size you can
  hold up to the room (with a copy button), and control the run with pause,
  resume and finish — finishing asks for confirmation and says how many students
  have not submitted yet. The participant board refreshes every four seconds and
  shows each student's name, a "working" marker while they are still in the
  paper, and their percentage with a pass badge once they submit; finished
  results sort to the top. It polls for now; the WebSocket hub replaces that.
- **WebSocket hub.** `GET /ws/sessions/:id` streams one session live: teachers
  receive the participant board, students receive status changes, and both get
  the current state on connect. Joins, submissions, pause, resume, finish and
  the timeout sweep all push an update. An invalid token, an unknown session, a
  student who never joined and a teacher who does not own the session are
  rejected with a close code. The client reconnects with a backoff and silently
  falls back to polling when a socket cannot be opened, so the board works
  either way.
- **Join link for phones.** The teacher copies a `?join=CODE` link next to the
  code; opened on a phone it lands on the join card with the code filled in and
  the button ready, and the parameter is cleared once the student is in.
- **`GET /api/sessions`** returns the teacher's own sessions newest first with
  joined and submitted counts. An admin sees every teacher's, a student gets 403.
- **README:** a "Testing from a phone" section — the server already binds
  `0.0.0.0:3300`, so a device on the same network can open
  `http://<lan-address>:3300` once the web client is built.
- **Client-side session logic** (`student/sessionLogic.ts`) — what counts as
  answered, the answer payload per type, the server-corrected clock and its
  formatting — under 20 new `node:test` cases.

### Changed
- The teacher dashboard opens on a **Live** tab (sessions) ahead of tests
  and courses.
- **Every release now ships a headless distribution** alongside the desktop
  bundles: the standalone server binary
  (`testing-server_<version>_linux-x64`) and the built web client
  (`web-client_<version>.tar.gz`). The release workflow builds them, smoke-tests
  the binary (version check, database check and a request to the web root) and
  only uploads if that passes. README documents the CLI flags and how to run
  the system without Tauri.
- `GET /api/admin/stats` now reports `schemaVersion: 4`.


### Fixed
- **"Not passed" on a perfect score.** A test with no pass mark sends
  `passed: null` from the server, and the result screen read that as a failure.
  It now shows a neutral "Completed" panel, and only reveals passed or failed
  when the test actually defines a mark.
- **The result screen's back button** returned to the paper of a session that
  could no longer be submitted. It lands on the student home, with a second
  button to join another test.
- **The sign-in header floated in the middle of a phone screen**, because the
  whole column was vertically centred. The header is pinned to the top now and
  only the card centres.
- **Switching roles on the sign-in screen jumped the layout**, since only the
  student role had the "Create account" line. The slot is always rendered at a
  fixed height and fills with a short note for the other roles.
- **Theme switching flickered**, restyling every element at once. It now
  cross-fades through the View Transition API, falls back to muting transitions
  for a single frame elsewhere, and drops the fade under `prefers-reduced-motion`.

## [0.2.0] — 2026-09-30

The teacher workbench and a finished-looking UI: authoring for all five
question types, the course builder, a real admin dashboard — plus the
UI/UX polish that turns the first release into a product you can hand to
a class.

### Added
- **UI/UX polish batch 1 (v0.1.1)**: a styled, dependency-free confirm dialog
  (`useConfirm()` + `<ConfirmDialog/>`, Esc/backdrop to cancel, focus moved to
  Cancel) now guards every destructive action in web-client and desktop —
  delete test, delete course, remove student, detach test, block user (was
  the native `window.confirm`, or none at all). i18n: new keys in en/uk.
- **Sign-in UX**: "show password" toggle on the login screen; the last
  successful username **and role** are remembered between sessions (only
  persisted on success, so typos never overwrite them).
- **UI/UX polish batch 2 (v0.1.1)**: global toast notifications
  (`useToast()` + `<ToastHost/>`, dependency-free) for test/course/student/
  material and user-management actions, replacing silent saves and one-off
  alerts; an app-wide **offline banner** plus a "server is back online"
  toast, both driven by a single shared health poll (`useServerHealth`
  powers the ServerStatus pill too). Reachability probe `checkHealth()` in
  the API layer keeps the desktop app pointing at `VITE_API_TARGET`.
- i18n: `server.offlineBanner`, `server.backOnline`, toast strings for
  tests/courses/admin actions, `common.dismiss` — en and uk.
- **UI/UX polish batch 4 (v0.1.1): admin tables + bulk approve.** The Users
  and Participants tabs render as sortable tables on wide screens (columns:
  name, role, status / course, student, enrolled, status) and keep the card
  layout on narrow ones. Column headers are buttons with `aria-sort`, sorting
  is client-side via a shared `useTableSort()` composable, and a result count
  sits above the table.
- **Bulk approval**: pending accounts get row checkboxes plus
  "select all pending", and one click approves the selection sequentially
  (with a toast). A confirm dialog still guards blocking.
- **UI/UX polish batch 5 (v0.1.1): test editor ergonomics.** Every question
  row now carries a numbered badge and icon controls to move it up/down,
  duplicate it or delete it. `+` glyph buttons were replaced with Lucide
  icons.
- **Live test preview** (`TestPreviewDialog`): before saving, a teacher can
  open a student-like rendering of the test — title, description, question
  count, total points, time limit and pass mark as chips, and each question
  type rendered read-only with the correct answers highlighted. The preview
  reuses `buildQuestions()`, so an incomplete question surfaces its
  validation message instead of a broken preview. Escape, a click on the
  scrim or the close button dismiss it.
- i18n: `teacher.editor.duplicateQuestion/moveUp/moveDown`,
  `teacher.tests.preview/previewTitle/previewUntitled/totalPoints`,
  `common.close` — en and uk.
- **UI/UX polish batch 6 (v0.1.1): loading and empty states.** Two shared,
  dependency-free components replace the ad-hoc "Loading…" / "No items yet"
  lines: `<EmptyState/>` (Lucide icon in a tonal circle, title, hint and an
  optional call-to-action) and `<SkeletonList/>` (card and table variants built
  on `animate-pulse` plus theme tokens, announced via `role="status"`).
  Every list now uses them — my tests, my courses, course details, users,
  participants, system stats — and the boot screen shows a skeleton instead of
  text. Empty tests/courses carry a real call-to-action ("New test" / "New
  course"), and an empty user list offers "Clear filters" whenever a search or
  filter is active.
- Remaining `+` glyph buttons and the inline empty hints on the course page
  were replaced with Lucide icons to follow the no-glyph rule.
- i18n: `admin.emptyTitle/emptyHint/clearFilters`,
  `admin.participants.emptyTitle/emptyHint`,
  `teacher.tests.emptyTitle/emptyHint`,
  `teacher.courses.emptyTitle/emptyHint` — en and uk (the old single-line
  `empty` keys are gone).
- **UI/UX polish batch 7 (v0.1.1): course page.** Attaching a test is now a
  searchable list (`TestPicker`) instead of a bare `<select>`: every row shows
  the title, the question count and the time limit, and a click attaches
  directly — no extra submit step. Materials carry a `MaterialBadge` with a
  Lucide icon and a short label (PDF, Doc, Sheet, Slides, Image, Archive,
  Video, Audio, Text, File), derived from the stored MIME type with a filename
  extension fallback (`utils/fileType.ts`).
- i18n: `common.fileType.*`, `teacher.courses.attachSearch/attachNoMatch/allTestsAttached`
  — en and uk.
- **UI/UX polish batch 8 (v0.1.1): accessibility and i18n hygiene.**
  - *Focus rings fixed*: every input carried Tailwind's `outline-none`, whose
    utility layer beats the global `:focus-visible` rule in `theme.css`, so
    keyboard focus was invisible app-wide. The utility is gone, focus now
    changes the border to `primary` and shows the 2 px ring.
  - *Labelled controls*: `aria-label` on the two icon-only editor buttons
    (remove option / remove pair) and on all 14 controls that only had a
    placeholder (admin search and filters, teacher-creation form, question
    body/type/option/pair inputs, enroll field, test search).
  - *Dialogs are keyboard-safe*: a shared `useDialogFocus` composable keeps Tab
    inside the confirm and test-preview panels, closes on Escape and restores
    focus to the opener.
  - *Contrast*: all 15 background/text token pairs used in markup reach at
    least 4.5:1 in the light and the dark theme.
  - *i18n*: the server-status tooltip moved into the locales, `<html lang>`
    now follows the active locale and the choice stays persisted;
    `aria-pressed` marks the active language button.
  - i18n: `server.recheckHint`, `admin.roleFilter/statusFilter`,
    `admin.participants.courseFilter`,
    `teacher.editor.typeLabel/optionLabel/removeOption/removePair` — en and uk.
- **Fixed:** toast accents used raw palette colours (`border-l-emerald-500`,
  `border-l-rose-500`, `border-l-slate-500`), which broke the dark theme and
  the "semantic tokens only" rule — now `border-l-success/error/outline`.
- **Fixed:** the "+" glyph buttons in the question editor became Lucide icons.
- **Fixed: black screen for brand-new teacher accounts.** A teacher with no
  tests and no courses mounts `<EmptyState/>`, and its `withDefaults()` used a
  Lucide icon as the default for the `actionIcon` prop. Vue treats a function
  default as a factory and calls it — `Plus(props, undefined)` — while Lucide
  icons are functional components that destructure their second argument, so
  every mount threw `TypeError: Cannot destructure property 'slots'` and unmounted
  the whole app (dark theme: a black screen). The fallback moved into the
  template (`actionIcon ?? Plus`) and the reason is documented in the component.
- **Fixed: throwing i18n messages in the admin dashboard.** `admin.blockConfirm`
  and `admin.bulk.selectUser` used `@{username}`, which vue-i18n reads as
  *linked-message* syntax rather than a placeholder; compiling them threw
  `SyntaxError` while rendering the users table. They are plain `{username}`
  placeholders now (en and uk).
- **Added:** `pnpm --filter @testing-system/web-client test` — six `node:test`
  checks that compile and resolve every message in both locales, reject
  accidental plural/linked syntax (`|`, `@{`), assert that `uk` mirrors the `en`
  key structure, and that interpolated placeholders match across locales. This
  is what catches the class of bug above at build time.
- **Fixed: pending student registrations were hard to find.** The queue was just
  rows inside the admin users table, and the "Participants" tab (course
  enrollments) looked like the place to look, so a fresh registration appeared to
  have vanished. The admin dashboard now shows a callout — "N student accounts
  are waiting for approval" — with a **Review pending** button that opens the
  users tab pre-filtered to `pending`, plus a count badge on the Users tab. The
  badge and callout refresh after every approve, block or teacher creation and
  disappear when the queue is empty.
- **Fixed:** the registration and pending screens promised approval "by a
  teacher or administrator", but only an administrator can approve (the status
  endpoint is admin-only) and the teacher dashboard has no approval queue. Both
  locales now say administrator.
- All emoji and decorative glyphs replaced by Lucide icons
  (`@lucide/vue`): role picker, show/hide password, student phase cards,
  material rows, back arrow, question/pair removal, matching pairs swap,
  toast dismissal, theme switcher. **New dependency: `@lucide/vue`**
  (the deprecated `lucide-vue-next` package is not used).

### Changed
- **UI/UX polish batch 3 (v0.1.1): light + dark themes.** The whole UI now
  runs on a semantic Material 3 Expressive token layer defined once in
  `theme.css` (`@theme inline`, `:root` / `.dark`): surfaces, on-surface text,
  outlines plus primary/secondary/error/success/warning and their containers,
  and a scrim. Every raw palette class was migrated to the tokens, so both
  themes work everywhere.
- Dark mode is class-based (`<html class="dark">`) with a **theme switcher**
  in every header (Sun/Moon icon). The choice is persisted; on first run the
  OS preference wins. An inline boot script applies the theme before first
  paint (no light flash), and `theme-color` meta tags follow the OS scheme.
- Accessibility defaults: a global `:focus-visible` ring and a
  `prefers-reduced-motion` guard that neutralises transitions/animations.
- **New design rule** (ROADMAP "Design rules" + AGENTS.md): no emoji in the
  UI — icons come from Lucide only; one cohesive M3 Expressive style; colour
  only through semantic theme tokens; exactly two themes (light and dark).

### Fixed
- **Black screen for brand-new teacher accounts.** A teacher with no tests
  and no courses mounts the empty state, whose `withDefaults()` used a
  Lucide icon as a prop default. Vue treats a function default as a factory
  and calls it, while Lucide icons are functional components that
  destructure their second argument — every mount threw and unmounted the
  app. The fallback moved into the template, with a comment explaining why
  it must stay out of `withDefaults`.
- **Throwing i18n messages in the admin dashboard.** `admin.blockConfirm` and
  `admin.bulk.selectUser` used `@{username}`, which vue-i18n reads as
  *linked-message* syntax rather than a placeholder, so compiling them threw
  `SyntaxError` while rendering the users table.
- **Focus rings were invisible app-wide.** Every input carried Tailwind's
  `outline-none`, whose utility layer beats the global `:focus-visible` rule.

## [0.1.0] — 2026-09-25

Phase 1 release: the role-based foundation ships as a testable product —
accounts & auth, tests & courses CRUD with materials, and full admin and
teacher UIs in the web client and the desktop app. 35 integration tests green.

### Added
- **Server — accounts & roles (Phase 1)**: `users`/`sessions` tables with role
  (`admin | teacher | student`) and status (`pending | approved | blocked`),
  built-in admin account seeded on first boot (`ADMIN_USERNAME` /
  `ADMIN_PASSWORD` env overrides), password hashing with `node:crypto` scrypt
  (no new dependencies), opaque bearer sessions (SHA-256 at rest, 12 h expiry).
- **Auth API**: `POST /api/auth/register` (students self-register → pending),
  `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- **Admin API**: `GET /api/users` (role/status/search filters),
  `POST /api/users` (create teacher), `PATCH /api/users/:id/status`
  (approve/block, revokes live sessions), `DELETE /api/users/:id`.
- **Admin insights API** (admin only): `GET /api/admin/stats` (schema version,
  DB health, uptime, table counts) and `GET /api/admin/participants` (flat
  course × student enrollment list) — backed by 5 integration tests.
- **Tests & questions API** (`admin`/`teacher`): `GET/POST /api/tests`,
  `GET/PUT/DELETE /api/tests/:id`; embedded questions for all 5 types
  (single choice, multiple choice, true/false, short answer, matching) with
  per-type payload validation; questions are replaced atomically on update.
- **Courses API** (`admin`/`teacher`): `GET/POST /api/courses`,
  `GET/PATCH/DELETE /api/courses/:id`; enroll/unenroll students by username;
  attach/detach tests; raw `application/octet-stream` material upload
  (100 MiB cap, allow-listed MIME) via
  `POST /api/courses/:id/materials?name=<file>`, streamed back through
  `GET /api/courses/:id/materials/:materialId/file`.
- Integration tests covering accounts & auth (13) plus tests/courses CRUD
  incl. file round-trip, cross-teacher isolation and question validation
  (17 more) — **35 total green**.
- **Role-based UI shell** in web-client and desktop: sign-in screen with a
  role picker (student / teacher / administrator), student self-registration,
  per-role dashboards, persisted session restored on start, server-status chip,
  uniform error messages (i18n en/uk).
- **Teacher workbench UI (Phase 2 start)** in web-client and desktop:
  - **Tests tab**: list own tests; full test editor with all five question
    types (correct-answer marking for choices, time limit in minutes, passing
    score), create/edit/delete, per-type client-side validation.
  - **Courses tab**: create/delete courses; course page with students
    (enroll by username, remove), attached tests (attach/detach), and
    materials (file picker uploads raw bytes, download via authenticated fetch).
- **Admin dashboard** in web-client and desktop: live user management with
  search + role/status filters and approve/block; **Participants** tab
  (courses × students with course filter, status badges, enrollment dates);
  **System & DB** tab (server version, uptime, schema version, database
  health, table counts); **create-teacher form** (approved immediately).
- `docs/api.md` and `docs/schema.md` for the new API surface and data model.

### Changed
- **Architecture rewritten around a role-based single product**: one client
  serves Administrator / Teacher / Student, roles are chosen at sign-in;
  topology updated — the admin machine hosts the embedded server, teachers and
  students connect over the LAN; offline mode (cached materials/statistics and
  teacher-side local test drafts) documented in `docs/architecture.md`.
- Roadmap re-scoped to the same vision with a detailed Phase 1 and flexible
  later phases; README updated (roles, topology diagram, offline mode).
- **Desktop**: the v0.0.1 trial demo window (Rust bridge greeting + "sum of
  two numbers", unused `greet` command) removed — the app now opens the same
  role-based sign-in flow; author name stays in the window title.
- Shared `apps/api` layer (typed fetch client, error envelope, token storage)
  between web-client and desktop frontends.

### Fixed
- **`Sign out` now always clears the local session** (web-client + desktop),
  even when the server is unreachable, so it always returns to sign-in.
- **Desktop app reaches the API in production builds**: the built webview runs
  on the Tauri origin, so all API calls (health checks, REST, material
  downloads) now target `http://localhost:3300` explicitly instead of the Vite
  dev proxy; override at build time with `VITE_API_TARGET`. Cross-origin
  requests are served by the existing CORS setup (documented in `docs/api.md`).

## [0.0.1] — 2026-09-10

### Added
- **Project creation**: monorepo scaffold (pnpm workspaces) with three apps:
  `apps/server`, `apps/web-client`, `apps/desktop`.
- Agent rules and opencode config (root `AGENTS.md`).
- Project docs: README, CHANGELOG, ROADMAP, architecture, API reference.
- Server foundation: Fastify app with `GET /api/health`, SQLite bootstrap via
  `node:sqlite` (`DatabaseSync`), idempotent migration runner, CLI args
  (`--host`, `--port`, `--data`, `--webroot`), compiled to a standalone
  single binary with `bun build --compile`.
- Student client foundation: Vite + Vue 3 + Tailwind v4 + i18n (en/uk),
  mobile-first home view with server status check.
- Desktop foundation: Tauri 2 + Vue 3, i18n (en/uk).
- **Trial demo window** in the desktop app: «sum of two numbers» with a Test
  button and the author's name (ПІБ) in the window title, localized per locale.
- GitHub Actions: build workflow (`build-desktop.yml`) producing Linux
  (`.deb` / `.AppImage`) and Windows (`.msi` / `.nsis`) bundles with artifact
  upload; auto-release workflow (`release.yml`) triggered by `v*` tags.
- ✅ Production bundles built in CI for v0.0.1: `.exe` (NSIS), `.msi` (WiX),
  `.deb`, `.AppImage` — published in [GitHub Release v0.0.1].
- Local Linux verification: `.deb` and `.AppImage` built and launched on Arch.

### Fixed
- Server standalone binary: resolve the data/webroot dir from
  `process.execPath`, not `import.meta.dir` (which is `$bunfs` inside the
  compiled binary).
- Linux AppImage bundling on Arch: needs `patchelf` and `NO_STRIP=true`
  (linuxdeploy fails on `.relr.dyn` sections otherwise).
- Renamed Tauri lib crate so `main.rs` resolves the correct lib target.
- Desktop Vite config: dropped `build.target` (rolldown-vite requires
  `esbuild`, which is not installed).
- CI Linux build: removed `libappindicator3-dev` (conflict with
  `libayatana-appindicator3-dev` → "held broken packages").
- CI artifacts: switched to `tauri-apps/tauri-action@v1` with
  `uploadWorkflowArtifacts: true` (the old `uploadArtifacts` input did nothing).
- Linux AppImage blank white window on Mesa 26 + Wayland: launcher
  `scripts/run-linux-appimage.sh` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` and
  preloads the system `libwayland-client.so` (bundled one is ABI-incompatible
  with Mesa 26).

[0.7.0]: https://github.com/flassuu/lantern/releases/tag/v0.7.0
[0.6.0]: https://github.com/flassuu/lantern/releases/tag/v0.6.0
[0.5.1]: https://github.com/flassuu/lantern/releases/tag/v0.5.1
[0.5.0]: https://github.com/flassuu/lantern/releases/tag/v0.5.0
[0.4.2]: https://github.com/flassuu/knowledge-testing-system/releases/tag/v0.4.2
[0.4.1]: https://github.com/flassuu/knowledge-testing-system/releases/tag/v0.4.1
[0.4.0]: https://github.com/flassuu/knowledge-testing-system/releases/tag/v0.4.0
[0.3.0]: https://github.com/flassuu/knowledge-testing-system/releases/tag/v0.3.0
[0.2.0]: https://github.com/flassuu/knowledge-testing-system/releases/tag/v0.2.0
[0.1.0]: https://github.com/flassuu/knowledge-testing-system/releases/tag/v0.1.0
[0.0.1]: https://github.com/flassuu/knowledge-testing-system/releases/tag/v0.0.1

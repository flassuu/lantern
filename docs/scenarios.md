# The three deployment scenarios

The system was imagined around three ways of being used. This is what each one
needs, what works today, and how to check that it works. The plan that closes
the gaps is [Phase 5 of the roadmap](../ROADMAP.md#phase-5--deployment-v050-next).

| Scenario | Where the server runs | Who is in the room | Today |
|---|---|---|---|
| **A — school server** | A machine in the school, started by hand or as a service | admin, teacher, students | **Works**, if the teacher opens the web client on the LAN address |
| **B — teacher desktop** | Inside the desktop app, which starts and owns the server | teacher (+ admin when needed) | Client only: the app never starts a server |
| **C — classroom, no admin** | On the teacher's own machine | teacher and students only | Blocked: a student cannot be approved without an admin |

---

## Scenario A — the server on a school machine

This is the one to use today. Everything below works on the current release.

### 1. Build once

```bash
pnpm install
pnpm build:web                 # → apps/web-client/dist, served by the server
pnpm build:server              # → apps/server/dist/lantern-server
```

Or take both from the release page: `lantern-server_<version>_linux-x64` and
`lantern-web_<version>.tar.gz` (unpack the second — the server expects it at
`--webroot`).

### 2. Start it

```bash
TEACHER_PASSWORD='choose-a-real-one' \
  ./apps/server/dist/lantern-server \
    --port 3300 \
    --data ./data \
    --webroot apps/web-client/dist
```

Expected on screen:

```
{"level":30,...,"msg":"Server listening at http://192.168.1.65:3300"}
[server] listening on http://0.0.0.0:3300 (db: /…/data/app.db)
```

`0.0.0.0` means every interface, which is what lets phones in. If the port is
taken the process exits — pick another one, and remember to use it everywhere
below.


When the terminal shows the LANtern banner, the interactive console is attached:
`help` lists the commands, and `approve olena` lets a student in without leaving
the keyboard. `--no-console` turns it off; a pipe turns it off by itself, which
is what happens when the desktop app starts the server.

### 3. Sign in

Open `http://192.168.1.65:3300` and sign in as **teacher** with the password you
set, picking the teacher role on the sign-in screen.

The first account on an empty data folder is a teacher. There is no admin to
create first, and none is needed for anything in this runbook. If a school wants
one for the institution-wide screens later, the console takes it:
`admin principal some-password`.

### 4. Set the address students can open

A teacher can set this directly. The server lists the addresses this machine
answers on; pick one (or type your own) and save. The same value is available
without guessing:

```bash
ip -4 route get 1.1.1.1 | rg -o 'src [0-9.]+'     # e.g. src 192.168.1.65
```

From this point on, **use `http://192.168.1.65:3300`, never `localhost`** — a
student's phone cannot open `localhost`, and the teacher's own window
(`tauri://localhost` in the desktop app) is no better. Until this is set, the
teacher's Live tab says so in plain words under the QR code, and the code can
still be typed by hand.

The setting is what goes into the join link, the "Copy join link" button and the
QR code, so it is worth checking once: scan the QR with a phone, or open the
copied link on one. If it opens the app, the address is right.

Students register themselves, on their own phones. There is no account to
create in advance.

### 5. Get the student in — with a room key, or an approval

The fastest way, and the one that works when the teacher is alone in the room:
the teacher creates a room and hands out its key. A room is *who* is in the
class; the *what* — materials, tests, lessons — is a course, and one room may
follow any number of them.

1. Sign in as the teacher → **Rooms** → **Create room** (e.g. `9A`, optionally
   linked to courses) → the key appears, e.g. `42FAK2`.
2. Show the QR code on the projector, or read the key out loud.
3. Each student opens the app (on the LAN address from step 3), the room code is
   filled in from the QR, and the account is created **approved** — the student
   can sign in immediately, and nobody needs to press "Approve". Everyone who
   arrives through the key is enrolled in the room's courses as well.

Without a room key the other path still works, and needs no admin:

1. Sign in as the teacher → **Rooms** → at the bottom, **Waiting for approval**
   lists the student.
2. **Approve**.
3. The student can now sign in. Until this happens the API answers
   `403 PENDING_APPROVAL`.

An admin's **Users** tab does the same for the whole school.

### 6. The teacher prepares the test

As the teacher: **Tests → New test**, add questions (all five types are
available), then **Live → Start a session → choose the test**. The board shows:

- a six-character code (no ambiguous `0/O`, `1/I` — it gets read out loud);
- **Copy join link** — this is the URL to test;
- **Show QR code** — the QR encodes the same link.

Check the link before going further: the address is printed under the QR code, and
the tab says so in plain words if a phone cannot open it. If it says `localhost`
and no address was set in step 3, the join link is not usable on a phone yet.

Starting a run opens a **lobby**, not a test: the code is out and the students
arrive and are counted, but nobody is timed and nothing can be submitted until
**Start** is pressed. That is deliberate — the class needs somewhere to stand for
the first two minutes, and a clock that started at "New session" would be half
gone before anybody had a phone out. **Pause** holds the clock for everybody,
and the run's rules (one question per page, shuffling, when results are shown)
are on the same screen.

### 7. A student takes the test

1. The phone joins the same network (same Wi-Fi, not mobile data).
2. Scan the QR, or open the copied link, or open the address and type the code.
   A student who is not signed in lands on the sign-in screen first; the code
   stays in the address and **prefills itself** once they are in.
3. Until the teacher presses **Start** the phone says the run has not opened
   yet — that is the lobby, not a stuck screen.
4. The paper arrives with the question types the test uses, a confirmation
   before submitting, and — only if the test sets a time limit — a countdown
   corrected against the server's clock. With **one question per page** the
   paper shows one question and a **Next**, and the teacher's board waits the
   same way.
5. The result shows the score, the pass mark and the correct answers.
6. The teacher's board updates without a refresh; a student's score is held
   back when the run says so, until the teacher releases it.

### 8. How to know it worked

- `curl http://192.168.1.65:3300/api/health` → `{"status":"ok","database":"ok",…}`
  from the admin machine, and the same from the phone's browser.
- The student's result screen shows a percentage, and the teacher's board shows
  the same student as `submitted`.
- The **Journal** tab shows the student with their last percent, for a room or
  for a course, and a second run adds a row rather than replacing it. A student
  who has not done a test yet keeps their row with a dash — "no attempt" is not
  "scored nothing".
- **Tests → Results → Print** produces the report for the folder; **Export CSV**
  on the board produces a spreadsheet, and the Journal has its own CSV and
  Print. Clicking a number in the journal opens that one student's attempt in
  full — every question, the time on it, and what happened to the window.

### 9. The course as the students see it

The room is how they got in; this is what they came for.

1. **Courses → New course** → open it. **Lessons** are ordered headings; add
   `Lesson 1: rays` and file the test and a file under it, or leave them loose,
   which is shown at the end rather than hidden.
2. **Materials → upload** a picture, then a file. The picture gets a thumbnail,
   and tapping it opens it full screen; a GIF plays. Images and plain text open
   in the browser instead of downloading.
3. **Announcements → post** a sentence — the file is optional, because requiring
   one would turn every note into a download.
4. On the phone: **Courses → the course**. The announcement is at the top,
   because on a phone that is the one part of a course that changed today, then
   the lessons with what is filed under each, each picture with a thumbnail.

Deleting a lesson leaves what was under it behind: taking a heading down is not
a way to delete the reading filed under it.

---

## Scenario B — the teacher desktop app

The desktop app **hosts** the server. The bundle carries it as a sidecar, and the
app starts it, shows its output, and keeps its settings — so a teacher needs
nothing else running and nothing installed on the machine but the app.

### 1. Build both

```bash
pnpm install
pnpm build:server
pnpm desktop:sidecar        # places the binary where Tauri looks for a sidecar
pnpm --filter @lantern/desktop build
```

`pnpm desktop:sidecar` is the step that is easy to miss: Tauri looks for
`apps/desktop/src-tauri/binaries/lantern-server-<rust triple>` and refuses to
build without it. `scripts/desktop-sidecar.sh` also builds the server unless you
pass `--no-build`.

### 2. First run

1. Open the app. The sign-in screen has a **Server** button next to the language
   menu — the one thing a teacher may need before signing in.
2. The screen says **Stopped** and offers **Start**. Nothing is started silently.
3. If the binary is missing, the Start button is disabled and the screen lists
   every path it looked in, plus the command that produces it. A development
   build without a bundled binary is a normal state, not a crash.
4. **Start** → the console fills with the server's output, the status turns to
   **Running** with a pid, and the sign-in screen can reach the server.

### 3. Settings

| Setting | What it does |
|---------|--------------|
| Port | the API base follows it, so a port change needs no rebuild |
| Data folder | where the database and uploads live; defaults inside the app's data dir |
| Student client folder | `--webroot` — unpack `lantern-web_<version>.tar.gz` and point at its `dist`, so phones have something to open |
| Server binary | empty means the bundled one; a path is for a development build |
| Teacher password | `TEACHER_PASSWORD` at start — used **only** when the data folder has no teacher yet |

**Changing the admin password** is a separate pair of fields, and deliberately
so: it calls `POST /api/auth/password`, which ends every session including the
one that made the change. The seed variable is read once, so a second launch
needs the endpoint to move the password at all.

### 4. Stop, restart, close

1. **Stop** → the process is gone; check `ss -ltnp | grep <port>`.
2. **Restart** → the port is free again and a new pid appears.
3. Closing the window stops the server with it. A server left behind would hold
   the port, and the next launch would fail with no clue why.
4. A server that dies on its own — a taken port, a crash — turns the status to
   **Stopped** and reports the exit code.

### 5. Verifying a built bundle

```bash
pnpm desktop:sidecar
NO_STRIP=true pnpm --filter @lantern/desktop tauri build
```

1. Run the bundle with a **fresh** data folder: first launch shows the defaults
   and a Start button, and Start works.
2. Start → the console fills with `listening on http://0.0.0.0:<port>`.
3. **Open in browser** → the same server; from a phone on the LAN, if the student
   client folder is set.
4. Stop → the process is gone (`ss -ltnp | grep <port>`).
5. Change the port, Restart, and confirm the app still talks to the server — this
   is the check that the API base really follows the setting.
6. A development build without a bundled binary shows the paths it looked in, and
   a readable message instead of a crash.

Rust tests cover the parts that do not need a window:

```bash
cd apps/desktop/src-tauri && cargo test      # HOST=<triple> for the real-server test
```

---

## Scenario C — a classroom with no admin

### Closed in Phase 5.2, renamed in Phase 6.1

A **classroom with a key**. Before it, the teacher had to sign in as the admin to
approve students by hand — which is the exact thing that breaks when a student
registers five minutes before the lesson.

How it works:

1. The teacher creates a **room** in their workbench; the app shows a
   six-character key and a QR of the registration link (`?room=KEY`).
2. A student scans it, registers, and is **approved immediately** — the key is
   the approval, scoped to that room and revocable.
3. The room is linked to any number of courses, and everyone who arrives through
   the key is enrolled in all of them. The link works in both directions: attach
   a course later and the students already in are caught up.
4. The teacher sees who came in through the key, and can revoke or regenerate it.

   Since 6.1 the room is *who* and a course is *what*. Before that they were one
   column, and a class could study exactly one course — which was wrong for
   every teacher who teaches more than one subject to the same group.

### How to verify it

- Register with a valid key → the account is usable right away, no admin involved.
- Register with a wrong or revoked key → a clear error, and the account is still
  `pending` (nothing about the old flow changes).
- Revoke a key → the next registration with it is refused; existing students keep
  working.
- A teacher cannot see, revoke or delete another teacher's room, and a room key
  never grants teacher or admin rights anywhere.
- Link two courses to a room, register a student before and after: both end up
  enrolled in both, and enrolling one of them again is refused as a duplicate.
- Automated: `apps/server/tests/rooms.test.ts` (key generation, approve /
  reject / revoke, ownership, enrolment both ways), `tests/migration-v6.test.ts`
  (the rename on a database that already has a room, members and a course in
  it), `tests/tags.test.ts`, and browser checks of the register screen with and
  without a key and of the Rooms tab.

---

## How to develop and verify all of this

**Order of work** — each package ends with something you can try by hand:

| Package | Ends with | Verify by |
|---|---|---|
| 5.1 Reachability | a QR that a phone opens | type an address into settings, read the QR with a phone |
| 5.2 Classroom key | a student in without an admin | register with the key on a second device |
| 5.3 Console | logs you can read, and commands that act | `--no-console` off, type `help`, then `status` |
| 5.4 Desktop host | the server inside the app | build the bundle, start it, open it from a phone |
| 5.5 Verifiability | the runbooks above | re-run this document top to bottom |
| 6.1 Rooms, tags | a key that enrols into courses | register with the key, check the course has the student |
| 6.2 Library | a run you can find again | name a run, filter the library by status and date |
| 6.3 Lobby | students waiting, then answering | start a run, join before and after **Start** |
| 6.4 Settings | rules on one screen | one question per page, then pause and resume |
| 6.5 Detail | one student in full | open an attempt from the board |
| 6.6 Media | a picture in a question | upload in the editor, view it on a phone |
| 6.7 Lessons | a course with a plan | add a lesson, file a test under it, post a note |
| 6.8 Journals | the table before the lesson | open a room's and a course's journal, export the CSV |

**Automated checks**:

```bash
pnpm typecheck                 # all three packages
cd apps/server && bun test     # server unit + integration
pnpm --filter @lantern/web-client test
cd apps/desktop/src-tauri && cargo test   # the host: spawns the real server
pnpm smoke:console             # the console on a pty, and a piped run staying JSON
pnpm check:browser             # a real Firefox, layout and happy paths
```

`pnpm check:browser` drives headless Firefox over WebDriver BiDi with no
dependencies of its own — a WebSocket and some JSON. Per screen and width it
reports horizontal scroll, elements past the right edge, touch targets under
30px, unnamed controls and untranslated keys, across three roles × two languages
× three widths; then it walks the screens this phase added: rooms and the
address, the session library, the lobby and its start, the paged runner, a
picture in a question and on the paper, lessons and announcements, and the
journal — its table, its empty cells, a cell opening an attempt, and the way in
from a course. It creates the accounts, tests, session, room and course it needs
and deletes them afterwards. Screenshots of a failure come out of the same run, so a visual pass
is a minute rather than a manual click-through.

`pnpm smoke:console` exists because the console only appears on a terminal: the
script runs the binary under a pty, sends `status` and `approve nobody`, checks
the output is human-formatted, then runs it again with the output piped and
checks every line is still JSON — the contract `systemd`, `journalctl` and CI
depend on.

**Manual pass before calling a package done** — run the relevant scenario above
end to end on a real phone, not on the same machine.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| QR scans but the page will not open | no public address is set, so the link says `localhost` or `tauri://` | admin → System & DB → Public address, pick the LAN address, save; the tab warns about this on its own |
| Phone cannot reach the server at all | firewall, or a different network | allow TCP 3300; both devices on the same Wi-Fi |
| `403 PENDING_APPROVAL` | the student registered without a room key and is not approved yet | register with the teacher's room key, or admin → Users → Approve |
| `403 FORBIDDEN` on an action | the signed-in role is not the one the action needs | teachers cannot manage users; only admins can |
| The board does not update | the WebSocket could not be opened | it falls back to polling every 4s; check for a proxy in between |
| The countdown looks wrong on a phone | device clock drift | the deadline is corrected against the server on join |
| Server exits at start, `EADDRINUSE` | the port is taken | another port, in the command and in the join link |
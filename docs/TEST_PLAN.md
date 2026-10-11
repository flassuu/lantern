# How to test LANtern by hand

A checklist for looking at the product with your own eyes. Four passes, in
order. Everything you need to start is in part 1; the rest is a list of things
to click.

Print it or keep it open next to the app. When something is wrong, write it in
the log at the bottom — do not fix it mid-pass, or you lose your place.

---

## 1. Start

```bash
pnpm install
pnpm build:server && pnpm build:web   # the desktop app serves the web client
pnpm desktop:sidecar                  # builds the server, copies it where Tauri wants it
pnpm dev:desktop                      # opens the app
```

First run only. After this you only need `pnpm dev:desktop`.

If it complains that the server binary was not found, run `pnpm desktop:sidecar`
once more — that step has to happen after every `pnpm build:server`.

The app opens on the login screen. There is a **Server** link right there, no
sign-in needed — that is where you start the server and set the first admin
password.

Give the admin a real password before the first start, in the **Server** screen
(field "Admin password (first start)"). It only applies to a data folder that
has no admin yet — change it later and nothing happens, by design.

Testing the student side? The desktop app is your server. Take the join link or
QR from the teacher's Live tab and open it on a phone or in a narrow window.

---

## 2. Pass one — does the whole thing work?

No detours. If something breaks here, fix it before pass two; every later
finding is noise while the spine is broken.

- [ ] Start the server from the app. It goes to **Running**
- [ ] Sign in as admin. You land in the admin dashboard
- [ ] Admin → Users → create a teacher. Sign in as them in a second window
- [ ] Teacher → Tests → make a test: **one question of each of the five types**
      (single choice, multiple choice, true/false, short answer, matching)
- [ ] Set a time limit and a pass mark, save
- [ ] Open the test from the list to preview it. Check the preview is what the
      student will get
- [ ] Live tab → start a session with that test. A six-character code appears
- [ ] On a phone (or a narrow window): register a student **with the room key**
      from the teacher → Rooms. They get in without approval
- [ ] Student enters the code, answers all five, changes one answer, submits
- [ ] Result screen: score, percent, passed, and the correct answers shown
- [ ] Teacher's live board showed the student move while they answered
- [ ] Teacher ends the session → results per student, and a CSV downloads
- [ ] Student's Results tab lists the attempt

## 3. Pass two — every feature, once each

Work top to bottom. Tick what works, note what does not.

**Auth**
- [ ] Register with a room key → approved instantly
- [ ] Register without one → stays pending, sign-in says "awaits approval"
- [ ] A teacher's key still creates a **student**, never a teacher
- [ ] Wrong password, and a blocked account, are refused
- [ ] Reload while signed in → still signed in, no flash of the login screen
- [ ] Change password → old one stops working
- [ ] Sign out → the token stops working

**Tests**
- [ ] All five question types: author, preview, answer, check grading
- [ ] Multiple choice: exact set only. A subset scores zero
- [ ] Short answer: `  Oxygen ` with odd spacing and capitals → still correct
- [ ] Edit a test **while a session is live** → students mid-test are unaffected
- [ ] Duplicate a test → full independent copy
- [ ] Export, then import the file into a clean data folder → everything survives
- [ ] Delete a test that has results → warning mentions the history
- [ ] Delete a question, reorder questions → order holds everywhere

**Courses**
- [ ] Create a course, enrol a student → that student sees it, others do not
- [ ] Enrol the same student twice → no duplicate
- [ ] Attach a test, detach it
- [ ] Upload a pdf, png, txt, docx → accepted, shows name/size/type
- [ ] Upload a `.exe` → refused with a reason
- [ ] Download a material as an enrolled student → works
- [ ] Download as a **non**-enrolled student → refused (this is the check that matters)

**Live session**
- [ ] The QR and the join link point at the **public** address, not `localhost`.
      This is the single most common way a classroom fails — check it first
- [ ] Change the public address, reopen the Live tab → link and QR follow
- [ ] Pause → students cannot submit. Resume → they can
- [ ] Finish the session, then try to pause → refused, finished is final
- [ ] Let the time limit run out with students still working → they are
      auto-submitted with zero, nobody's attempt is lost

**Student flow**
- [ ] Paste a lowercase/messy code → the field normalises it
- [ ] Refresh in the middle of a test → answers so far are kept, timer is right
- [ ] Submit twice (double tap) → refused, not double counted
- [ ] Result screen at 360 px wide → no sideways scroll

**Results**
- [ ] CSV opens in a spreadsheet: header row, separators, Cyrillic intact
- [ ] Same student, two attempts → both listed separately

**Admin**
- [ ] Users badge shows the pending count, and matches reality
- [ ] Approve / block / unblock a student → all three work
- [ ] Admin cannot block or delete themselves
- [ ] Stats counts match the Users tab

**Rooms (the no-admin scenario)**
- [ ] Create, regenerate key (old one dies), revoke, rename, delete
- [ ] Key preview shows what a student sees without creating anything
- [ ] A wrong key and a revoked key look **identical** in the response

**Server screen**
- [ ] Console: lines appear without a refresh, level filter works, Clear, Copy
- [ ] Restart the server → data is all still there
- [ ] Change the port → it applies after Restart, and the app follows it
- [ ] Stop the server → the app says stopped, does not pretend

---

## 4. Pass three — break it on purpose

- [ ] Kill the server hard (Ctrl-C) during a session → restart, DB intact
- [ ] Start it on a port that is already busy → clear message, not a stack trace
- [ ] Server away while a student is answering → offline banner, answers kept
- [ ] Bring the server back → banner clears
- [ ] Server binary somewhere with no web client beside it → API works, says so
- [ ] Title of 201 characters → refused. 200 → accepted, header holds
- [ ] `<script>alert(1)</script>` as a title → stored safe, shown as text
- [ ] Answer for a question that does not exist → zero, no crash
- [ ] A student opening the teacher's routes → refused, not just hidden buttons

## 5. Pass four — how it looks and feels

- [ ] Light ↔ dark on every screen. No unreadable text, no invisible borders
- [ ] Ukrainian. Every string switches, nothing left in English
- [ ] 360 px wide on every student screen: no sideways scroll, buttons big
      enough to hit with a thumb, nothing important in a top corner
- [ ] Empty lists → a real empty state with a way forward
- [ ] Loading → skeletons, no layout jump
- [ ] Any failure → a toast, and the screen does not lie about what happened
- [ ] Destructive action → always asks first, naming the thing
- [ ] Dialog: `Esc` closes, `Tab` stays inside, focus comes back
- [ ] Whole app with the keyboard only → every control reachable, visible focus
- [ ] Tab strips with arrow keys → **expected to fail today**, that is a finding
- [ ] No emoji anywhere, icons only
- [ ] OS "reduce motion" on → animations actually stop

---

## Log

Write problems here as you find them. Severity: **blocker** the product does not
work · **major** a core flow is broken · **minor** works but wrong or ugly ·
**polish** noticed, not worth a release on its own.

| # | Severity | What happened | Where | Follow-up |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

When you are done: blockers and majors go into the next patch release, minors
grouped by area, polish into a backlog. Anything that is a **missing** feature
rather than a bug goes into `ROADMAP.md`, not into a patch.

## Not bugs

Decided on purpose — do not report these:

- Restart is not an API call. Only the machine owning the process can restart it.
- A room key approves a student and nothing else. The role is hard-coded.
- POST answers 200, not 201. Consistent everywhere.
- The export format stays `knowledge-testing.test`. Renaming it would break
  every file exported before 0.5.0.
- Short answers score only against the accepted list. No fuzzy matching.
- The admin password field only applies to a data folder with no admin yet.
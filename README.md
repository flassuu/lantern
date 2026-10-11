# LANtern

[![Release](https://img.shields.io/github/release/flassuu/lantern.svg?display_name=tag)](https://github.com/flassuu/lantern/releases/latest)
[![Build desktop app](https://github.com/flassuu/lantern/actions/workflows/build-desktop.yml/badge.svg)](https://github.com/flassuu/lantern/actions/workflows/build-desktop.yml)
[![Release build](https://github.com/flassuu/lantern/actions/workflows/release.yml/badge.svg)](https://github.com/flassuu/lantern/actions/workflows/release.yml)

Classroom testing over a local network, with **no internet access** — a
client-server system for running tests in a computer lab. One role-based
application serves an **administrator**, **teachers** and **students**.

> Course project. Works fully on a LAN; nothing leaves the classroom network.

## What's inside

| App | Tech | Purpose |
|-----|------|---------|
| `apps/server` | Node.js, Fastify, SQLite (`node:sqlite`), WebSocket | Embedded REST API + real-time hub; hosted on the admin machine; compiled to a single standalone binary |
| `apps/web-client` | Vue 3, TypeScript, Tailwind CSS v4, PWA | Shared role-based frontend (admin / teacher / student) — mobile-first, one codebase with role-gated features |
| `apps/desktop` | Tauri 2, Vue 3, Tailwind CSS v4 | Same frontend as a native app; the Admin client embeds and runs the server (console + admin panel) |

## Roles

- **Administrator** — hosts the system: runs the embedded server (in the
  desktop client or headless CLI), manages the database, users, participants.
- **Teacher** — desktop app and/or web app: creates and edits tests with all
  five question types, builds courses with materials, runs a **live session**
  (start a test, read the join code to the room or show the QR code, watch the
  participant board in real time, pause or finish), and afterwards reads the
  **grade journal** — who is where, and which questions the class missed — then
  prints the report or exports the session as CSV.
- **Student** — signs in on a phone (PWA) or PC, browses the courses they are
  enrolled in and their materials, joins a session with a six-character code or
  a link, answers the paper against a countdown, and sees the graded result with
  the correct answers plus a history of every attempt.

## Architecture

```
   Admin machine (hosts the whole system: Tauri client + embedded server)
          │  HTTP/WS on LAN (0.0.0.0:3300)
   ┌──────┼──────────┬─────────────┐
   ▼      ▼          ▼             ▼
Teacher  Student   Students    (headless
(desktop /   (desktop /   (phones via   CLI)
 web on       web on       Wi-Fi, PWA)
 localhost)   localhost)
```

- **No external internet required** — server + DB + web client live on the
  admin machine; teachers and students connect over the LAN.
- **Role-based single client**: choose a role at first sign-in; the UI adapts.
- **Offline mode**: with the server unreachable, the app says so instead of
  failing silently, and whatever the service worker already cached stays
  readable. Authoring offline is not implemented — see the roadmap.
- Live updates arrive over WebSocket; a client that cannot open a socket falls
  back to polling the same endpoints.
- The server serves the built web client as static files and is compiled into
  one executable, so the admin machine needs **no Node.js, no database
  installation** — just the single app bundle.
- i18n via `vue-i18n`: base locale **en**, **Ukrainian** included,
  adding locales is a one-place change.

## Getting started

Requirements: Node.js ≥ 22.5, pnpm ≥ 9, bun (for server builds only).

```bash
pnpm install
```

### Development

```bash
pnpm dev:server        # API on http://localhost:3300 (health: /api/health)
pnpm dev:web           # web client on http://localhost:5173
pnpm dev:desktop       # desktop client (admin / teacher)
```

### See it with demo data

A fresh database can be filled with a class to look at — a course with lessons,
a room, four students, four tests (one with a picture) and one finished run, so
the journal shows numbers instead of a wall of dashes:

```bash
./apps/server/dist/lantern-server \
  --port 3300 --data ./demo --webroot apps/web-client/dist --seed-demo
```

It is never implicit and never lands on real work: the seed refuses a database
that already holds a course, a test or a room, and a second call does nothing.
The teacher's credentials are the ones already configured, and the students share
one password — both are printed on the line that says the seed ran. The same seed
is available from the server console as `demo`.

The server binds `0.0.0.0:3300` by default, so once the web client is built
(`pnpm build:web`) any device on the same network can open it:

```bash
ip -4 route get 1.1.1.1 | rg -o 'src [0-9.]+'   # this machine's LAN address
```

Then browse to `http://<that-address>:3300` on the phone. No configuration
change is needed; if the device cannot connect, the port is blocked by the
host firewall (allow TCP 3300) or the two devices are on different networks.
Vite's dev server (`pnpm dev:web`, port 5173) is separate — for phone testing
use the built client served by the API server, not the Vite port.

**The offline shell needs a secure address.** A browser only gives a page a
service worker — and only offers to install it — over HTTPS or on `localhost`.
Served to a phone as `http://192.168.x.x:3300` the client works completely, but
it cannot be installed and its cache does not run, because a plain HTTP origin
is not a secure context. The manifest and the worker are there and are used
whenever the address is `https://` or `localhost`; a classroom that wants the
installable, offline-capable client needs an HTTPS address for the server.

### Production build

```bash
pnpm build:server      # standalone binary → apps/server/dist/lantern-server
pnpm build:web         # web client → apps/web-client/dist
pnpm build:desktop     # Tauri bundles (.deb / .AppImage / .exe)
```

### Running without the desktop app

Every release also ships the two artifacts a headless install needs: the
standalone server binary and the built web client. Download both from the
release page, unpack the client, then:

```bash
TEACHER_PASSWORD='choose-a-real-one' \
  ./lantern-server_0.6.0_linux-x64 \
    --port 3300 \
    --data ./data \
    --webroot ./dist
```

Then open `http://<this-machine>:3300`. The CLI flags:

| Flag | Default | Notes |
|------|---------|-------|
| `--port` | `3300` | also read from `$PORT` |
| `--host` | `0.0.0.0` | binds every interface, so phones on the LAN can reach it |
| `--data` | `./data` | database (`app.db`) plus `uploads/`; resolved to an absolute path |
| `--webroot` | auto-detected | folder with the built client; resolved to an absolute path |

Sign in as `teacher` with the password you set — the first account on an empty
data folder is a **teacher**, so there is no admin to create first.
`TEACHER_USERNAME` / `TEACHER_PASSWORD` choose the credentials; the default
`teacher`/`teacher` prints a warning on first run. An admin is optional and can be
created later from the server console with `admin <username> <password>`, for the
school-wide screens. The database migrates itself on start, so a newer binary
always opens an older database.

## Documentation

- [Deployment scenarios and how to run them](./docs/scenarios.md)
- [Architecture](./docs/architecture.md)
- [Database schema](./docs/schema.md)
- [API reference](./docs/api.md)
- [Roadmap](./ROADMAP.md)
- [Changelog](./CHANGELOG.md)

## License

MIT (see repository root).

# AGENTS.md — Agent rules for this repository

> Single source of truth. Read fully before starting. If an instruction here
> contradicts a user request, follow this file and ask the user.

## Project overview

Offline classroom testing system (**LANtern**, course project): a **teacher
desktop app** (Tauri 2 + Vue 3), a **mobile-first student web client** (Vue 3 +
PWA) and an **embedded server** (Fastify + `node:sqlite`) compiled to one
standalone binary with `bun build --compile`. All code, comments, identifiers and
technical docs are in **English**. UI strings go through `vue-i18n`: English is
the base locale, Ukrainian ships out of the box, a new locale is a one-place
change.

## Repository layout

```
apps/server/      API + WS server (Fastify, node:sqlite, bun-compiled)
apps/web-client/  Student mobile-first web app (Vite + Vue 3 + Tailwind v4)
apps/desktop/     Teacher desktop app (Tauri 2 + Vue 3 + Tailwind v4)
docs/             Architecture, DB schema, API reference, release checklist
scripts/          Sidecar, smoke and browser-check scripts
```

## Environment

- Dev OS: Arch Linux. Targets: Windows (.exe) and Linux (`.deb`, AppImage). CI
  ships all of them; the AppImage is best-effort and is published only after the
  job has started the server out of the artifact (see
  docs/RELEASE_CHECKLIST.md §5).
- Node.js >= 22.5 (built-in `node:sqlite`), pnpm >= 9. `bun` only compiles the
  server binary — it is not the runtime for anything else.
- Tauri on Linux needs `webkit2gtk-4.1`; AppImage needs `patchelf` and, on Arch,
  `NO_STRIP=true`. Windows builds and releases happen in CI, never locally.

## Commands (repo root)

| Task | Command |
|------|---------|
| Install deps | `pnpm install` |
| Dev server / web / desktop | `pnpm dev:server` · `pnpm dev:web` · `pnpm dev:desktop` |
| Build server / web | `pnpm build:server` · `pnpm build:web` |
| Desktop bundle | `pnpm desktop:sidecar` then `NO_STRIP=true pnpm --filter @lantern/desktop tauri build` |
| Verify an AppImage | extract it and start the server inside it (docs/RELEASE_CHECKLIST.md §5) |
| Typecheck / server tests | `pnpm typecheck` · `cd apps/server && bun test` |
| All tests | `pnpm test` |
| Desktop Rust tests | `cd apps/desktop/src-tauri && HOST=$(rustc -vV \| sed -n 's/^host: //p') cargo test` |
| Console smoke / browser checks | `pnpm smoke:console` · `pnpm check:browser` (needs a server on :3300) |
| Cutting a release | see [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) |

## Conventions

- **Package scope:** `@lantern/*` (`server`, `web-client`, `desktop`).
- **Strict TypeScript** everywhere, extending `tsconfig.base.json`. No `any`
  unless unavoidable, with a comment saying why. **Minimal comments** — only
  non-obvious decisions. No new dependencies without explicit confirmation.
- Mirror sibling files; follow the existing layout of each app.
- REST + JSON. Real-time goes through WebSocket (`@fastify/websocket`), never
  long-polling. IDs are server-side UUIDs; join codes are 6 uppercase chars.

## Server rules

- SQLite via `node:sqlite` (`DatabaseSync`). Never add a native driver — it
  breaks `bun build --compile`.
- CLI args: `--port`, `--host`, `--data <dir>`, `--webroot <dir>`. Migrations
  run idempotently at startup; the DB file lives in `--data`.
- Everything must keep working compiled to a single binary.

## Frontend rules (web-client & desktop)

- Tailwind CSS **v4** via `@tailwindcss/vite`. No `tailwind.config.js`.
- Locales in `src/i18n/locales/<locale>.ts`, registered with one import plus
  one entry. English is the fallback. Never hard-code UI strings.
- Mobile-first: narrow screens first, desktop is progressive enhancement.

### Design rules (binding)

Rationale in ROADMAP.md ("Design rules"). **No emoji in the UI** — icons from
Lucide (`lucide-vue-next`) only. One Material 3 Expressive style: cards
`rounded-2xl`, controls `rounded-xl`, chips pill, tonal surfaces, motion
150–250 ms. Colour only through semantic theme tokens (`bg-surface`,
`text-on-surface`, `bg-primary`, …) from the Tailwind v4 `@theme` layer — never
raw palette classes. Exactly **two themes**: light and dark.

## Desktop (Tauri) rules

- Tauri **v2**, Rust in `src-tauri/`. Keep Rust minimal, prefer JS. Never
  assume a running server in dev; handle "server not reachable" states.
- The server binary is a bundle **resource** (`bundle.resources`), not an
  `externalBin`: an externalBin lands in `usr/bin`, which `linuxdeploy` rewrites
  with `patchelf` and thereby corrupts. Run `pnpm desktop:sidecar` first or
  `tauri build` fails on a missing resource.

## Git conventions

- Branch `main`, conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`). Commit only when asked; no scaffolding noise in history.
- Never commit secrets, DB files or build artifacts.

## Quality gate

Scale it to the change — see Working rules, rule 3.

1. `pnpm typecheck` per touched package; `pnpm --filter <pkg> test` for touched
   logic; `pnpm build:server` / `pnpm build:web` when server or web touched.
2. `pnpm check:browser` after touching a screen; `pnpm smoke:console` after
   touching the logger or console; `cargo test` after touching `src-tauri`.
3. Update `CHANGELOG.md` (Unreleased) on user-visible behavior changes.

## Working rules

1. **Two failures on the same error is the limit.** After the second, stop and
   do not repeat the same approach: either add diagnostics (state dump,
   screenshot, verbose output) or ask me.
2. **Before any run longer than a minute, make the script report its state on
   failure** — screenshot, page state, logs. Diagnose from data, not theories.
3. **Verification is proportional.** Cosmetic or UI-only change: typecheck plus
   one targeted check. The full gate runs once, right before a commit, only for
   affected packages. Never between debugging iterations.
4. **Do not invent test infrastructure.** If a mature tool exists (Playwright
   for browser checks), use it. Ask me before adding a tool or dependency.
5. **Never `pkill`/`killall` with a pattern that also appears in your own
   command line** — it kills your own shell. Find the PID first (`ss -lptn`,
   a precise `pgrep`), then kill by PID.
6. **Scope discipline.** Do only what was asked. A useful change outside the
   request is never silent: tell me and let me decide, or make it a separate
   commit and say so explicitly.
7. **More than 3 files touched: write a short plan first** (steps and files)
   and wait for my confirmation before editing.
8. **Batch mechanical edits.** One scripted pass with an expected-match-count
   assertion, not several sequential `sed` calls.
9. **Set a sufficient timeout on the first attempt** for slow commands (commits
   with hooks, builds) instead of retrying.
10. **One session, one task.** If a new request changes what you just finished
    (a rename right after a release), point it out and propose the next version.
11. **Comments in English only. No emoji in any output.**

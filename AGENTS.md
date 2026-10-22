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

### Branding

- The logo artwork lives in `DESIGN/` and is the only source: the crest and the
  wordmark are inlined as `currentColor` in `BrandMark.vue` / `BrandWordmark.vue`
  (byte-identical twins in both apps), and every PNG, `.ico` and `.icns` is
  generated from `logo-icon.svg`. `DESIGN/README.md` has the commands.

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

Scale it to the change. **Tests run only when the user asks for them.**

1. `pnpm typecheck` for the touched package is the default check. Add
   `pnpm build:server` / `pnpm build:web` only when the change touches the
   server, the build or something typecheck cannot see.
2. `pnpm test`, `pnpm check:browser`, `pnpm smoke:console` and `cargo test` are
   run on request only — never "just in case", never after a small UI change.
3. Update `CHANGELOG.md` (Unreleased) on user-visible behavior changes.

## Working rules

1. **Speed is the default.** A minor change is one turn: edit, typecheck the
   touched package, report. Do not narrate, do not re-read what was just
   written, do not re-verify the same thing twice. The user is waiting.
2. **Tests only on request.** `pnpm test`, `pnpm check:browser`,
   `pnpm smoke:console`, `cargo test` and every other suite run only when the
   user asks for them. `typecheck` of the touched package is the normal check.
3. **No screenshots.** Never take a screenshot and never read or analyse an
   image of the screen or of the running app. Judge the change from the code.
4. **No scripted edits.** Change sources with the dedicated file tools only.
   Writing a Python or shell script that rewrites source files is forbidden.
   Read-only commands and one-off data queries (`sqlite3 -readonly`, `grep`,
   `git diff`) stay fine.
5. **No verification loops.** At most one focused check after an edit. If the
   cause of a failure is not obvious, stop and ask — never re-run the same
   check hoping for a different result. Two failures on the same error: stop.
6. **Ask, do not guess.** If a request is ambiguous — how wide "a bit wider"
   is, which state a block is optimised for, where a control goes — ask one
   short question before editing instead of inventing an answer.
7. **Do not invent test infrastructure.** If a mature tool exists (Playwright
   for browser checks), use it, and only when asked. Ask before adding a tool
   or a dependency.
8. **Never `pkill`/`killall` with a pattern that also appears in your own
   command line** — it kills your own shell. Find the PID first (`ss -lptn`,
   a precise `pgrep`), then kill by PID.
9. **Scope discipline.** Do only what was asked. A useful change outside the
   request is never silent: tell me and let me decide, or make it a separate
   commit and say so explicitly.
10. **More than 3 files touched: write a short plan first** (steps and files)
    and wait for my confirmation before editing.
11. **Batch mechanical edits through the file tools.** Rename with one
    `replaceAll` edit rather than a sequence of `sed` calls; assert the result
    by reading the diff, not by scripting the file.
12. **Set a sufficient timeout on the first attempt** for slow commands (commits
    with hooks, builds) instead of retrying.
13. **One session, one task.** If a new request changes what you just finished
    (a rename right after a release), point it out and propose the next version.
14. **Comments in English only. No emoji in any output.**

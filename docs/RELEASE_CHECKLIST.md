# Release checklist

Use this only when cutting a release. It does not apply to ordinary tasks: a fix
or a feature commit is committed and pushed on its own, without any of this.

**A release is atomic.** Once the release is published, nothing is renamed and no
behavior changes. Anything discovered afterwards goes into the next version. If a
rename or a behavior change is wanted right after a release, that is the next
version, not an amendment to this one.

## 1. Decide the version

SemVer. Bump every manifest in one scripted pass with an expected-match-count
assertion (Working rules, rule 8):

- `package.json`
- `apps/server/package.json`
- `apps/web-client/package.json`
- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json` (`version`)
- `apps/desktop/src-tauri/Cargo.toml` (`version`)
- `apps/desktop/src-tauri/Cargo.lock` (the workspace package entry)

## 2. Update the docs

- `CHANGELOG.md` — retitle `Unreleased` to `[x.y.z] — <date>`, write the lead
  paragraph, keep one uniform section style, add the verification note and any
  migrations.
- `ROADMAP.md` — mark the finished phase, leave no checkbox open unless the
  item is a deliberate decision (say so in the item).
- `docs/api.md`, `docs/schema.md`, `README.md` — version numbers and examples
  that quote a version or schema version must match reality.
- Repo description on GitHub, if the name or the pitch changed.

## 3. Run the full gate once

Proportional verification does not apply here — this is the one full pass:

```bash
pnpm typecheck
cd apps/server && bun test
pnpm --filter @lantern/web-client test
cd apps/desktop/src-tauri && HOST=$(rustc -vV | sed -n 's/^host: //p') cargo test
pnpm smoke:console
pnpm check:browser                              # needs a server on :3300
```

## 4. Commit, tag, push

```bash
git add -A && git commit          # conventional commit
git tag -a v<version> -m "v<version> — <title>"
git push origin main && git push origin v<version>
```

Pushing the tag triggers `.github/workflows/release.yml`, which builds the
server, the web client and the desktop bundles and creates a GitHub Release with
placeholder notes.

## 5. Wait for CI

Both workflows must succeed: `Release` and `Build desktop app (Linux +
Windows)`. Watch with `gh run watch <id> --repo flassuu/lantern`.

### The AppImage, and the one thing that can go wrong with it

CI builds the `.deb`, the Windows installers **and the AppImage**. The AppImage
was missing from every release between 0.5.1 and 0.7.5, and the reason is worth
keeping written down, because it is invisible to every check except one:

- `linuxdeploy` assembles the AppImage by running `patchelf` over **every ELF in
  the AppDir's `usr/bin`** to set an rpath. On a `bun build --compile` binary
  that rewrite **corrupts it**: the bundle builds, uploads, and the app segfaults
  in silence on startup.
- Nothing structural notices. `readelf` reads the header, the program headers and
  the dynamic section without complaint; `ldd` is content wherever the libraries
  resolve; a hash comparison can only ever fail, because the bytes are *meant* to
  change. Only running it tells you.
- A `NO_STRIP`, `APPIMAGE_EXTRACT_AND_RUN` or `ldd` shim does not address the
  corruption either — the shim only makes the bundle *build*, which is exactly how
  a broken file once reached the download list.

**The fix is where the binary lives, not what the bundler is told.** The server is
a bundle **resource** now (`bundle.resources` in `tauri.conf.json`, staged by
`scripts/desktop-sidecar.sh` into `apps/desktop/src-tauri/resources/`), so it is
shipped as data in `usr/lib/LANtern/` — a directory `linuxdeploy` never scans. The
Rust host finds it through `resource_dir()`, which it already looked in. Nothing in
`usr/bin` is ours any more except the Tauri app itself, which is an ordinary Rust
ELF and safe to rewrite.

**And the job proves it by running it.** The `appimage` job in `release.yml`
builds the bundle, extracts the produced AppImage, starts the **server out of the
extracted artifact** and asks it for `/api/health` — the failure this whole
section is about is a server that starts and dies, and no log says so. The asset
is uploaded only if that answered. It needs no display, so it needs no `xvfb`.

The job is `continue-on-error` on purpose: a package that might not build must
never be able to take a release down with it. If it fails, the release is still
good — it just has no AppImage, and Linux users take the `.deb`.

To check a locally built AppImage by hand:

```bash
cd apps/desktop/src-tauri/target/release/bundle/appimage
APPIMAGE_EXTRACT_AND_RUN=1 ./LANtern_*_amd64.AppImage --appimage-extract >/dev/null
./squashfs-root/usr/lib/LANtern/lantern-server --port 3499 --data /tmp/lantern-check --no-console &
curl -s http://127.0.0.1:3499/api/health     # version must match, database ok
```

Stop it by PID (`ss -lptn 'sport = :3499'`), never by a `pkill` pattern. On Arch
the AppImage also needs `scripts/run-linux-appimage.sh` to open its window
(WebKitGTK on Mesa 26 + Wayland), which is a rendering problem and not this one.

## 6. Publish the notes

```bash
gh release edit v<version> --repo flassuu/lantern \
  --title "v<version> — <title>" --notes-file <file> --latest
```

The notes explain **why**, not a list of features: what was broken, what the
change is, what a user has to do (migrations, a changed app identifier, a
renamed binary), and what was verified. Draft the file before CI finishes.

## 7. Verify the released assets as a user would

Never trust the CI log alone — download and run it:

```bash
gh release download v<version> --repo flassuu/lantern --pattern 'lantern-server*' --pattern 'lantern-web*'
chmod +x lantern-server_<version>_linux-x64
./lantern-server_<version>_linux-x64 --port 3499 --data ./data --webroot ./dist &
curl -s http://127.0.0.1:3499/api/health     # version must match
curl -s http://127.0.0.1:3499/ | grep '<title>' # LANtern
```

Confirm the asset names match the release conventions: `lantern-server_<v>_linux-x64`,
`lantern-web_<v>.tar.gz`, and `LANtern_<v>_*` for the desktop bundles (those come
from `productName`, so mixed case is correct there) — `.deb`, `.AppImage`, `.exe`
and `.msi`. The AppImage appears only when its job got as far as starting the
server inside it; a release without one is a release whose AppImage job failed,
not a release missing a part nobody built.

Stop the process by PID (`ss -lptn 'sport = :3499'`), never by a `pkill` pattern.
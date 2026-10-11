#!/usr/bin/env bash
#
# Puts the server binary where Tauri bundles it as a **resource**.
#
# It used to be an `externalBin` (a "sidecar"), which Tauri copies into the
# bundle's `usr/bin`. That is what broke the AppImage: `linuxdeploy` runs
# `patchelf` over every ELF in `usr/bin` to set an rpath, and that rewrite
# corrupts a `bun build --compile` binary - the bundle builds, uploads, and the
# app segfaults in silence. A resource is shipped as data, in a directory
# linuxdeploy does not scan, and the Rust host already looks for the server in
# `resource_dir()`; `docs/RELEASE_CHECKLIST.md` has the whole story.
#
# Usage:
#   scripts/desktop-sidecar.sh            # build the server, then copy it
#   scripts/desktop-sidecar.sh --no-build # copy what is already in dist
#
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server_dist="$root/apps/server/dist/lantern-server"
resources="$root/apps/desktop/src-tauri/resources"

if [ "${1:-}" != "--no-build" ]; then
  echo "building the server…"
  (cd "$root" && pnpm build:server)
fi

if [ ! -f "$server_dist" ] && [ ! -f "$server_dist.exe" ]; then
  echo "no server binary at $server_dist" >&2
  echo "run: pnpm build:server" >&2
  exit 1
fi

# On Windows the compiler produces lantern-server.exe, and the name has to match
# what the host looks for next to the resources.
if [ "${OS:-}" = "Windows_NT" ] || [ -f "$server_dist.exe" ]; then
  source="$server_dist.exe"
  target="$resources/lantern-server.exe"
else
  source="$server_dist"
  target="$resources/lantern-server"
fi

mkdir -p "$resources"
cp "$source" "$target"
chmod +x "$target" 2>/dev/null || true

echo "server staged as a resource: apps/desktop/src-tauri/resources/$(basename "$target")"

# Temporarily moved Windows release

This directory contains a placeholder for a Windows build. Building Windows releases on Linux requires a cross-compilation toolchain or a Windows host, which is not configured here. The project's convention is to build Windows, Linux and AppImage bundles in CI (see docs/RELEASE_CHECKLIST.md §5). The actual Windows release will be produced by CI when the tag is pushed.

This folder exists only because the user asked for a Windows build to be placed here temporarily, and it should not be used in production or release.
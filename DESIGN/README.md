# The artwork, and what is generated from it

This folder is the **source** for the brand. Everything else in the repository is
derived from it, so the files here are the ones to edit — never the PNGs and the
`.ico` next to them, which are build output.

## The files

| File | What it is | Where it goes |
|------|-----------|---------------|
| `logo-icon.svg` | The lantern on its purple tile, 128×128. The **app icon**. | Favicon, PWA icons, Tauri icons, the home-screen icon |
| `logo-full-dark.svg`, `logo-full-light.svg` | The crest alone — the lantern outline, no tile, 93×128. | The app header, the About dialog, the server screen |
| `logo-wordmark-dark.svg`, `logo-wordmark-light.svg` | `LANtern`, 272×64. The purple box has "LAN" cut out of it. | The app header (after the crest), above the sign-in card, the README banner |

The two variants of each are the same geometry in the two theme colours, and both
of those colours are the app's `primary` token — so the app uses **one** copy with
`currentColor` and lets the theme do the switching. `BrandMark.vue` and
`BrandWordmark.vue` are those copies; they are byte-identical twins in
`apps/desktop` and `apps/web-client`. Changing the artwork means changing those
two components.

The banner lives in `.github/assets/` instead, because a README cannot run the
theme: `banner-dark.png` and `banner-light.png` are picked between by
`prefers-color-scheme`. `.github/assets/logo-icon.png` is the same tile as a PNG,
for markdown that wants a small mark.

## Regenerating

Everything below assumes the repository root, and needs `rsvg-convert` (librsvg).
The Tauri icons additionally need the Tauri CLI, which is already in the
workspace.

**Web client and PWA icons** — `apps/web-client/public/`:

```bash
cd apps/web-client/public
rsvg-convert -w 192 -h 192 ../../../DESIGN/logo-icon.svg -o icon-192.png
rsvg-convert -w 512 -h 512 ../../../DESIGN/logo-icon.svg -o icon-512.png
# Full bleed, because both of these get masked by the platform: the tile's
# rounded corners are painted in the same purple as the background, so they
# disappear and the mark keeps its safe area.
rsvg-convert -w 512 -h 512 -b '#6750A4' ../../../DESIGN/logo-icon.svg -o icon-maskable-512.png
rsvg-convert -w 180 -h 180 -b '#6750A4' ../../../DESIGN/logo-icon.svg -o apple-touch-icon.png
cp ../../../DESIGN/logo-icon.svg favicon.svg
```

**Desktop icons** — `apps/desktop/src-tauri/icons/`:

```bash
rsvg-convert -w 1024 -h 1024 DESIGN/logo-icon.svg -o /tmp/logo-1024.png
pnpm --filter @lantern/desktop tauri icon /tmp/logo-1024.png
rm -rf apps/desktop/src-tauri/icons/{android,ios}   # not targets of this project
```

That writes `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`, `icon.png`,
`icon.ico`, `icon.icns` and the Windows `Square*Logo.png` / `StoreLogo.png` set —
the names `tauri.conf.json` already lists, plus the mobile sets this project does
not ship.

**The GitHub banner** is not generated here: it is drawn by hand and committed as
a PNG, because GitHub cannot render an SVG in a README and cannot switch a single
image on the reader's theme.

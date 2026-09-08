# Phase 15 — Theming

Every color in the app already routes through named CSS variables, and a Light/Dark/Auto toggle already switches between two full value sets. This phase turns that into an editor, not a new styling mechanism.

## What already exists — build on it

- Every color in `styles.css` is a `:root` custom property: `--bg`, `--panel`, `--panel-2`, `--line`, `--line-strong`, `--text`, `--text-2`, `--text-3`, `--accent`, `--accent-dim`, `--good`, `--bad`, `--warn`, the color-identity pips (`--w --u --b --r --g`), `--m`/`--h` for multicolor and hybrid, `--radius`, and `--mono`.
- Light and dark are two complete value sets, switched by a `data-theme` attribute on the root (`Theme` type in `App.tsx`: `'system' | 'light' | 'dark'`, stored in `localStorage`).

## New: a custom theme editor

- **Lives on the Data page**, as a new section alongside the other global settings (`autoMaintainLands`, `defaultCostMethod`, etc.).
- Exposes every variable above as an editable control — color pickers, a slider for `--radius`, a font-stack picker for `--mono`. Live preview: changing a value updates the custom properties immediately.
- "Save as a skin" — a named preset.
- No shipped presets beyond the built-in Light and Dark.

## Where things live — explicit

| Thing | Where | Why |
|---|---|---|
| `'system' \| 'light' \| 'dark'` mode choice | `localStorage`, per-device (unchanged) | Matches deck-view and density preferences |
| Saved skins (named list) | `app_settings`, server-side | A skin should follow you to every device |
| Slot assignments ("Light mode uses" / "Dark mode uses") | `app_settings`, server-side | A slot assignment is "which skin," so it follows the skin |
| Last-resolved variable set | `localStorage`, as a paint hint | Avoids a flash of default theme before the settings fetch |

Skins are stored as a named list, not a single blob: `[{name, vars: {...}, backgroundImage?: url}, …]`. The picker lists every saved skin; switching or deleting one doesn't touch the others. Settings keys go through the allowlists in `settings.ts` (a JSON-valued setting will need its own small handler alongside `BOOLEAN_SETTINGS` etc.).

## Assigning skins to light and dark

A skin is one flat set of values. The existing mode toggle currently picks between the two built-ins; widen that to two slots — "Light mode uses" and "Dark mode uses" — each a picker over the unified list (built-in Light, built-in Dark, every custom skin), defaulting to the built-ins. Both slots can point at the same skin, at two different custom skins, or stay on the defaults. `system`/`light`/`dark` still only decides which slot is active.

## Backgrounds and images — the drag-and-drop piece

The app can't ship card art, frame art, or branded imagery. The user supplies the image.

- **Layered with the color, not instead of it.** `background-color: var(--bg)` stays underneath; the image is an optional layer on top. The color picker and the drop zone are independent controls.
- A drop zone in the editor — drag a file on, or pick one.
- **A visible "remove image" action** reverting to the plain color.
- **Storage:** a small assets directory on disk, parallel to `image_cache` but separate (user content, not synced data). Reference it from the skin's `backgroundImage` as a URL.
- **Upload route:** no multipart library exists in this codebase. Reuse the backup-restore precedent in `porting.ts` — a raw `application/octet-stream` content-type parser streaming the body to a file. Basic file-type and size check only.
- **Serving route:** a small static-file route scoped to that one directory (e.g. `/assets/user/:file`), not a general file server. Without it the stored URL resolves to nothing.

## Verification

1. Saving a second named skin doesn't alter or remove the first.
2. Assigning different skins to the light and dark slots and toggling mode swaps every CSS variable, not a subset.
3. Removing an uploaded background reverts to the plain `--bg` color with no residual `background-image` reference.
4. A `GET` to the serving route for an uploaded file returns image bytes with the correct content-type.
5. On a fresh load, the `localStorage` hint paints immediately; when the real fetch resolves to the same values, there is no second flash.
6. Uploading a non-image file, or a file over the size limit, is rejected with a clear error.

## Out of scope

- Pre-built themed presets (a holiday skin, a set-themed skin).
- Sharing a skin or any skin gallery.

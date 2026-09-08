# Phase 19 — PWA Install Flow

Makes the web app installable to a home screen with its own icon and a fullscreen window. **Not offline support** — the no-offline rule in CLAUDE.md stands. Offline recording lives in Phase 20's native app; this phase is only the install experience for the web client.

Nothing PWA-related exists in the repo today — no manifest, no icons, no favicon.

## New static files

Create `web/public/` (doesn't exist yet). Vite copies its contents to the build root with no config.

- `manifest.webmanifest`: name, icons, `display: "standalone"`, `start_url`, theme and background colors.
- Icon images — 192px and 512px for Chrome/Android, plus an `apple-touch-icon`. Original artwork made from scratch; no card art, no Wizards branding.

## `index.html` additions

`<link rel="manifest">`, `<link rel="apple-touch-icon">`, `<meta name="apple-mobile-web-app-capable">`, a theme-color meta tag.

## A minimal, no-op service worker

Chrome/Android's installability checklist has historically wanted an active service worker. Register one that does nothing — no `fetch` handler, no Cache API, permanently. Nothing later extends it.

Register it from `web/src/main.tsx` (the four-line client entry point): `navigator.serviceWorker.register('/sw.js')`.

## HTTPS (open decision, deferred)

PWA installability requires HTTPS or exactly `localhost`. The app is served over plain `http://` via Tailscale.

- **Skip it.** iOS "Add to Home Screen" is a manual share-sheet action and works over plain HTTP. Android/Chrome's automatic install banner won't fire; a manual "Install app" from Chrome's menu may. Ship the manifest and icons either way.
- **Add HTTPS with `tailscale serve --https=443 localhost:8080`.** Tailscale terminates TLS itself with a certificate for the tailnet hostname and proxies to the existing app. No app code changes; one new step in `deploy/README.md`, and the served port changes.

## Verification

1. After a production build, `manifest.webmanifest` and every referenced icon are reachable at their paths.
2. The service worker shows as active in DevTools and intercepts zero `fetch` events.
3. Over `tailscale serve` HTTPS, Chrome/Android's install criteria are met; over plain HTTP they are absent or degraded to a manual menu option.
4. iOS Safari "Add to Home Screen" launches standalone (no browser chrome) regardless of the HTTPS decision.

## Out of scope

- Any offline caching.
- Native app packaging or store distribution — Phase 20.
- Push notifications.

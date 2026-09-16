# Phase 31 — PWA Install Flow

> **Shipped 2026-09-16.** Built as specified; what the build decided that the doc left open:
>
> - **Per-page text vs. the banner.** Pages still render a connectivity `ApiError`'s message beside the thing that failed — 62 `setError(e.message)` sites were not taught to special-case it. Instead `CONNECTIVITY_MESSAGE` shrank to the fact ("Couldn't reach the MTG Library server.") and the diagnosis and fix moved to the banner, which is raised from `api.ts`'s `onServerUnreachable` at the two places a connectivity error is built. So a failed write says so where it happened *and* the banner says why; on a cold launch a page shows its own one-line error under the banner rather than a bare empty state.
> - **"Refetch what the page was showing"** is `reconnectEpoch` in `App.tsx`: every page is keyed on it (the mechanism `CollectionPage` already used for `dataEpoch`), so recovery remounts the current view. `DeckBuilder` takes it as `reloadKey` and reloads in place, keeping its undo stack and picker query. The browse search and the boot-time loads (`status`, sets, formats, locations, want lists) depend on it too, which is what makes a cold launch against a dead server come alive without a reload.
> - **`Cache-Control: no-cache` on `sw.js`** is an `onSend` hook in `server/src/routes/webClient.ts`, not `@fastify/static`'s `setHeaders` option — that writes to the raw response and is then overwritten by the plugin's own computed Cache-Control. The static serving moved out of `index.ts` into that module so `app.inject` can prove it.
> - **The worker fills its cache on `install`** — the page and the bundles it names, from the network — not only as a side effect of later loads. Found on the phone: the first load registers the worker but its own requests have already gone out, so the cache stayed empty until a *second* load, and a home-screen launch off Tailscale in between was a white screen (iOS standalone apps have no error page). The same gap reopened on every worker update, because `activate` drops the old cache while the new one was still empty. It also prunes `/assets/*` entries the freshly fetched `index.html` no longer references (the doc's optional step), skips `.map` files, refuses to store an HTML body under anything but the page's key, and does its cache write inside `event.waitUntil` so the page is never made to wait for it.
> - **A missing file under `/assets/` or `/icons/` is a real 404**, and `index.html` is served `no-cache` alongside `sw.js`. Before, the HTML fallback answered a stale page's request for a renamed bundle with `index.html` and a 200 — a white screen the worker then cached under the bundle's name.
> - **iOS status bar style is `default`, not `black-translucent`**: the latter draws white text over the page, which the light theme cannot carry, and would need a top safe-area inset the shell does not pad for.
> - **Icons** are one SVG mark rendered by `web/scripts/render-icons.mjs` with macOS's `qlmanage` (the repo has no image tooling; headless Chrome's `--screenshot` counts the window frame in `--window-size` and clips). The apple-touch-icon is the full-bleed maskable design because iOS discards alpha and applies its own mask.
> - **Verification 2, 4, 5 and 7 were run in real Chrome, and 4 again in WebKit (Playwright's build, the phone's engine, after one load only), via Playwright** against a production build on a copy of the database — the desktop app's embedded browser pane cannot register service workers. Item 3 and the phone halves of 4 and 5 are manual on a phone.

Makes the web app installable to a home screen with its own icon and a fullscreen window, and makes it behave like an installed app when the server is out of reach: its own *reconnect* screen rather than the browser's error page, and recovery on its own when the connection comes back. **Not offline support** — the no-offline rule in CLAUDE.md stands: no data is ever cached on the phone. What is cached is the app's static bundle, and only so the app can render its own "can't reach your library" screen; see *The service worker* for the line and why it is where it is.

Nothing PWA-related exists in the repo today — no manifest, no icons, no favicon.

**First in the track.** It depends on nothing: it is `web/` plus one response header, and it works on the systemd install over Tailscale the day it ships. Two small things land later, when the phase that makes them true exists: Phase 33 adds the *Add to Home Screen* line under its QR code, and appends the "scan the QR code again" clause to the home-wifi message below.

## New static files

Create `web/public/` (doesn't exist yet). Vite copies its contents to the build root with no config.

- `manifest.webmanifest`: name, icons, `display: "standalone"`, `start_url`, theme and background colors.
- Icon images — 192px and 512px for Chrome/Android, plus an `apple-touch-icon`. Original artwork made from scratch; no card art, no Wizards branding.

## `index.html` additions

`<link rel="manifest">`, `<link rel="apple-touch-icon">`, `<meta name="apple-mobile-web-app-capable">`, a theme-color meta tag.

## The service worker: a network-first shell cache

`web/public/sw.js`, registered from `web/src/main.tsx` (the four-line client entry point): `navigator.serviceWorker.register('/sw.js')`.

The case it exists for: the user taps the home-screen icon with the VPN off, or away from home wifi, or with the computer asleep. Without a cached shell the browser cannot fetch `index.html` and shows *its* error page — no message of ours, no retry, and the user's only move is to guess. With the shell cached, the app loads, the first API call fails, and the *Reconnecting* banner below takes over.

The rules, which are what keep this from being an offline mode:

- **Network-first, always.** Every request goes to the server. The cache is read only when the network *fails* — never to skip a round-trip, never for speed. The response to a successful request replaces the cached copy. So the cached shell is only ever seen when a fresh one could not have been had, and a desktop-app update (new `web/dist`) reaches the phone on its next successful load exactly as it does today. This is the mitigation for the one real hazard of shell caching — a stale bundle calling an API whose shape changed.
- **Static bundle only.** Same-origin `GET` for `/`, `/index.html`, `/assets/*`, the manifest, the icons. **`/api/*` is never intercepted** — not cached, not observed, not passed through a handler. The worker's `fetch` listener returns early for it. Nothing of the collection, the decks, or any setting ever touches the Cache API.
- **Versioned cache, old ones deleted on `activate`.** Hashed asset names mean stale entries are harmless but accumulate; keeping only the current cache name bounds it. A prune that drops assets no longer referenced by the cached `index.html` is fine but optional.
- **Serve `sw.js` itself uncached** (`Cache-Control: no-cache` from `fastifyStatic` for that one path), so a changed worker is picked up on the next load rather than after the browser's 24-hour ceiling.

## Reconnecting

What the app does when the server does not answer, whether the page was already open or was just served from the cache. Today `api.ts` has `CONNECTIVITY_MESSAGE` and an `isConnectivity` flag on the error and nothing else — no page listens for the connection returning, so the user has to refresh and hope.

- **One banner, not per-page errors.** A connectivity error anywhere raises a single app-level banner; pages keep whatever they were showing (or an empty state on a cold launch).
- **The message knows which way in it came.** `window.location.hostname` says how the page was reached, and a small pure function (`web/src/reachability.ts`, tested) classifies it:

  | Origin | Read as | Message |
  | --- | --- | --- |
  | `100.64.0.0/10` or `*.ts.net` | Tailscale | *Can't reach your library. Turn on Tailscale and it will reconnect.* |
  | `10/8`, `172.16/12`, `192.168/16`, `*.local` | home wifi | *Can't reach your library. Be on your home wifi — the computer may be asleep, or its address may have changed.* (Phase 33 appends *scan the QR code on it again* once there is a QR to scan.) |
  | `localhost` / `127.0.0.1` | the desktop app's own window | *The MTG Library server has stopped.* (Phase 32's shell restarts it; this is the seconds in between.) |
  | anything else | unknown | the generic message: *Can't reach the MTG Library server. Is it running? Are you on its network?* |

- **Recovery is automatic.** While the banner is up, poll `GET /api/v1/health` every few seconds, and poll *immediately* on the browser's `online` event and on `visibilitychange` to visible — the moment someone flips the VPN on and switches back to the app. When health answers, clear the banner and refetch what the page was showing. No reload. The `online` event alone is not enough: a phone on cellular is "online" while the tailnet address is unreachable, so polling is the mechanism and the events are only triggers for an early poll.
- **No caching of the failed request, no queueing of writes.** A write that failed on connectivity is reported as failed and stays failed; the user redoes it once connected. That is the no-offline rule, and this section does not bend it.

## HTTPS — decided: plain HTTP

PWA installability requires HTTPS or exactly `localhost`. The app is served over plain `http://`, on the home network from the Phase 32 desktop app and over Tailscale from a self-hosted install, and stays that way: the desktop app cannot hand a phone a certificate it trusts without a step a layperson will not do.

What that costs: iOS *Add to Home Screen* is a manual share-sheet action, works over plain HTTP, and launches standalone. Android/Chrome's automatic install banner won't fire; *Add to Home screen* from Chrome's menu gives a shortcut that behaves the same. The service worker registers over plain HTTP on a private address in both browsers. Camera capture through `<input capture>` works over HTTP; a live `getUserMedia` viewfinder would not, and nothing in the web client uses one — keep it that way.

A self-hosted install that wants the automatic Android banner can still put `tailscale serve --https=443 localhost:8080` in front; that is a `deploy/README.md` note, not app code.

## Verification

1. After a production build, `manifest.webmanifest` and every referenced icon are reachable at their paths.
2. The service worker is active in DevTools; a request to any `/api/v1/*` path shows no service-worker involvement in the Network panel; a request to `/assets/*` goes to the network and is served from it while the server is up.
3. Over plain HTTP, Chrome/Android offers *Add to Home screen* from the menu; iOS Safari's *Add to Home Screen* launches standalone (no browser chrome).
4. **Cold launch, server unreachable:** stop the server, open the app from the home-screen icon. The app's own reconnect banner shows with the message for the origin it was installed from — not the browser's error page. Start the server: the banner clears and the page loads its data within a few seconds, with no user action.
5. **Open page, connection drops:** with the app open, turn the VPN off (or the computer's wifi). The banner appears on the next request. Turn it back on and switch back to the app: the banner clears and the page refetches.
6. `reachability.ts` classifies `100.101.102.103`, `foo.tail1234.ts.net`, `192.168.1.20`, `10.0.0.5`, `172.20.0.1`, `mtg-library-ab12.local`, `localhost`, `127.0.0.1`, and `example.com` as the table above says (unit test).
7. After a new `web/dist` is deployed, the next load with the server up serves the new bundle, not the cached one (network-first), and the old cache name is gone after activation.

## Out of scope

- Caching anything from `/api/*`, or queueing a write for later. The shell is cached so the app can say *reconnect*; nothing else is.
- Native app packaging or store distribution — Phase 36 (parked).
- Push notifications.

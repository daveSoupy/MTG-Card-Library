# Build brief — Windows and macOS apps, Android companion, viability cut

How to get a Windows and macOS desktop app and an Android companion app running against the existing code, in three Claude Code sessions, without redoing any UI and without the self-hosted version stopping being the thing you develop. Each session is one phase, per CLAUDE.md's rules; this file is the scope cut and the prompts. `@`-mention it alongside the phase file.

**Targets are Windows, macOS and Android.** The desktop shell ships for both Windows and macOS from the same `desktop/` workspace — Electron makes the second one a build target, not a second app — and macOS is also the development loop since that is where development happens. iOS is not built in this cut and is one added platform in the same `mobile/` project if it is ever wanted. The UI is the React client on every platform, the native code is discovery plumbing, and the Swift that appears in the phase docs has a Kotlin twin named beside it.

## What "viable" means

Three checkpoints, in order. Stop and look at each before the next session.

1. **An installer on a Windows machine, and a `.app` on a Mac, each with no repo, no Node and no terminal, installs, opens, syncs the card database, and works.** (Phase 28, cut down.)
2. **A phone browser scans a QR on that machine and lands in the app.** (Phase 29, essentially whole.)
3. **An Android app scans the same QR once, and from then on opens straight into the app whenever it is on the home wifi — including after the PC's IP changes.** (Phase 20, home mode only.)

Shop mode, the queue, OCR, iOS and the cloud mailbox come after, if the three above feel right. None of them is needed to judge the idea.

## How changes keep flowing from the self-hosted version

This is the property the whole cut is designed around, and it is worth being precise about, because it is the reason the apps can be started now without freezing anything.

- **Neither app contains UI or rules.** `desktop/` and `mobile/` are workspaces beside `server/` and `web/`. They hold a shell, a pairing screen and build config. If a session finds itself copying a component, a type, or a rule into either, that is the mistake to stop and undo.
- **The desktop app is `server/dist` + `web/dist` + a Node binary.** `npm run build` at the root builds both as it does today; `npm run desktop:package` wraps the result. Every change to the self-hosted version is in the next package, unchanged. The systemd and Docker paths are untouched and still the way *you* run it.
- **The Android app loads the UI from the server.** After pairing, its WebView (Chromium) navigates to the PC's origin and renders whatever `web/dist` the PC is serving. A change to `web/` or `server/` reaches the phone the next time the app opens, with no Android Studio build and no store in between. The app is rebuilt only when the pairing screen or a native plugin changes — rarely.
- **The web client is already phone-shaped.** Phase 9's one-handed layouts for trades, wants and collection lookups are what the Android app shows. Nothing is redesigned; the phone gets a home-screen icon and automatic discovery, and that is the whole difference from Chrome.

The one discipline this needs going forward: `web/` must keep working when served from a LAN address rather than `localhost`, and `server/` must keep being configurable purely by environment. Both are true today.

## Platform plumbing to know before the sessions run

These are not design decisions; they are the places a first run fails for reasons that have nothing to do with the idea.

**Windows**
- **The firewall prompt.** The first time the server binds `0.0.0.0`, Windows Defender Firewall asks whether to allow the bundled `node.exe` on private networks. *Cancel* means LAN sharing silently does not work. The shell explains this in a sentence right before flipping the toggle, and *Show logs* is where "the phone can't find it" gets diagnosed.
- **Close hides to the tray; Quit is explicit.** Windows convention is close-means-quit, so the first-launch notice matters most here: a user who "closes" it must not believe it is off.
- **SmartScreen** interposes "Windows protected your PC" for an unsigned installer. Friends click *More info → Run anyway*. A code-signing certificate removes it; not before the idea is judged.
- **Building from a Mac.** electron-builder produces the Windows NSIS installer on macOS. The tray behaviour, the firewall prompt and the close semantics only show on real Windows — verify on a machine or a VM before calling checkpoint 1 met.

**macOS**
- **Gatekeeper is a dead end, not a warning.** An unsigned `.app` downloaded from the internet says *"is damaged and can't be opened"*; the workaround (`xattr -d com.apple.quarantine`) is a terminal command, which is the thing the app exists to avoid. Your own build runs on your own Mac without any of this. Giving it to other Mac users needs Apple's developer program for signing and notarisation — deferred with Windows signing, but it is the harder of the two to skip.
- **Apple silicon only — decided, not deferred.** No Intel build now or later; an Intel Mac runs the self-hosted version. A universal build would double the bundled Node for a platform Apple stopped selling in 2023.
- Close leaves the app running (Dock icon, menu-bar item); ⌘Q quits. Same rule as Windows, and the one Mac users already expect.

**Android**
- **Discovery is `NsdManager`**, and the plugin must hold a `WifiManager.MulticastLock` while browsing or the wifi driver drops the multicast packets. `.local` name resolution is unreliable on Android, so the browse step and the recorded-address fallback in Phase 29's order carry the weight.
- **Cleartext HTTP is blocked by default** in Android apps. A network security config allowing `http://` to private ranges and `.local` is required or the WebView shows nothing. (iOS has the same gate, App Transport Security, if it is ever added.)
- **Use a real phone, not the emulator.** Emulator networking makes mDNS miserable. USB debugging on, same wifi as the PC.
- **Distribution is an APK** on the GitHub release page, sideloaded. No developer account, no expiry. Play Store is optional and later.

## The cut, per phase

**Phase 28 — build:** `desktop/` Electron workspace; server spawned on a bundled official Node binary for the target platform (no ABI rebuild); health-poll splash; window; tray with *Open*, *Allow other devices on this network*, *Keep this computer awake while sharing*, *Launch at login* (default on), *Show data folder*, *Show logs*, *Quit*; close hides, Quit stops, on both platforms; the first-launch background notice; the firewall explanation; persisted port; single instance; `npm run desktop:dev` (runs on the Mac) and `npm run desktop:package` producing a Windows x64 installer and a macOS arm64 `.app`/`.dmg`, both unsigned.
**Defer:** auto-update, signing, Linux packaging, log rotation.

**Phase 29 — build:** all of it. `instance_id`, `GET /api/v1/instance`, `MTG_ADVERTISE` + mDNS, the QR panel in `DataPage.tsx`, the tray item. It is small, and the Android session needs every piece.

**Phase 20 — build:** `mobile/` Capacitor project with the Android platform; a bundled pairing screen (plain HTML/TS, a few hundred lines, not React — it must not import from `web/`); QR scan; Phase 29's discovery order, verified against `instanceId`; navigate the WebView to the server; a "can't find your library" screen with *Retry* and *Re-pair*; the network security config.
**Defer:** shop mode and the snapshot, the queue and idempotency table, the composite trade endpoint, OCR, background sync, share target, iOS, Play Store.

## Before session 1

- Node 22.6+ and the repo building clean (`npm run build && npm test`).
- Android Studio installed (it runs on the Mac), an Android phone with USB debugging on, and the phone on the same wifi as the machine running the server.
- Access to a Windows machine or VM for checkpoint 1's Windows half. Development and the macOS half happen on the Mac.

---

## Session 1 prompt — Phase 28, desktop app (Windows and macOS)

```
@CLAUDE.md @phases/apps/phase-28-desktop-app.md @phases/apps/BUILD-BRIEF.md

Build Phase 28 at the "viability cut" scope in BUILD-BRIEF.md: a desktop app
that runs the existing server and shows the existing web client. Shipped
targets are Windows x64 and macOS arm64, from one workspace; development
happens on the Mac. Nothing in server/src or web/src changes shape.

Concretely:
- A new `desktop/` npm workspace: Electron + electron-builder, TypeScript,
  `main.ts` only — no renderer code. Register it in the root package.json
  workspaces and add root scripts `desktop:dev` and `desktop:package`.
- The server runs as a child process on a bundled official Node binary (the
  release matching root `engines.node`, for the target platform — win-x64
  for the Windows build, darwin-arm64 for the mac build), fetched into
  `desktop/vendor/` by a script at package time and never committed. Do not
  use ELECTRON_RUN_AS_NODE and do not rebuild better-sqlite3. Run
  `server/scripts/check-sqlite.mjs` against the packaged app's node +
  better-sqlite3 as part of `desktop:package` and fail the package if it
  fails.
- Environment the shell sets, per the phase doc: MTG_DATA_DIR under
  app.getPath('userData'); MTG_HOST 127.0.0.1, or 0.0.0.0 when "Allow other
  devices on this network" is on; MTG_PORT 8080 or the next free port,
  persisted in the shell's own config file; server stdout/stderr to a log
  file under userData.
- Poll GET /api/v1/health before loading the window; a plain splash until it
  answers.
- This is a background app with a window, per the doc. Tray item: Open MTG
  Library · Allow other devices on this network (checkbox, restarts the
  child) · Keep this computer awake while sharing (checkbox, default off,
  powerSaveBlocker while sharing is on) · Launch at login (checkbox, default
  on, app.setLoginItemSettings) · Show data folder · Show logs · Quit.
  Closing the window hides it on every platform; the tray/Dock icon reopens
  it; only Quit (or ⌘Q) stops the server — SIGTERM, wait for exit,
  "Finishing up…" if it takes more than a second. First launch shows a
  one-line notice that it runs in the background and where to find it.
  Single-instance lock.
- Before the sharing toggle first turns on, on Windows, a one-paragraph
  dialog: the firewall will ask about node.exe; allow it on private networks
  or phones will not find the app.
- The packaged app keeps the repo's directory shape under resources/ so the
  server's walk-up to schema.sql and web/dist works, with server/**,
  schema.sql and node_modules/better-sqlite3/** outside the asar (or asar
  disabled — your call, say which and why in a comment).
- Skip auto-update, signing/notarisation and Linux for now; leave clear
  TODO markers. Note in the README that the unsigned mac build needs
  `xattr -d com.apple.quarantine` if downloaded rather than built locally.

Update docs/CODEBASE-MAP.md with the new workspace and rerun
`python3 docs/atlas/build.py`. Add a short "Desktop app" section to
README.md: both builds unsigned for now — how SmartScreen is dismissed on
Windows, and the quarantine step on a Mac.

Done means: `npm run desktop:package` produces a Windows installer and a
mac .app that each, on a machine with no Node installed, install, open,
offer the first sync, complete it, and search — and Phase 28's
verification items 1–6 pass on both (7 and 8 are deferred with the features
they test). Verify the mac build yourself on this machine; I will run the
Windows checks — give me the exact list to walk through and what each
should show.
```

## Session 2 prompt — Phase 29, pairing and discovery

```
@CLAUDE.md @phases/apps/phase-29-pairing-and-lan-discovery.md @phases/apps/BUILD-BRIEF.md

Build Phase 29 in full — it is small and the Android session needs every
piece.

- instance_id written to app_settings on first open via setSetting in
  db/index.ts (not through the settings route).
- GET /api/v1/instance per the doc; MTG_ADVERTISE in config.ts; DNS-SD
  advertisement of _mtglibrary._tcp with a pure-JS library, only when the
  flag is on and the bind is not loopback. Confirm the library works on
  Windows as well as macOS (Windows 10+ resolves mDNS natively; the
  advertisement side is the library's). The Phase 28 shell sets the flag
  whenever its sharing toggle is on; add the tray item "Pair a phone…" that
  opens the web app's pairing panel.
- The pairing panel in DataPage.tsx: a client-rendered QR of the URL-with-
  fragment described in the doc, shown only while sharing is on, otherwise a
  sentence pointing at the toggle. The web client must ignore the #pair=
  fragment cleanly.
- Tests for the instance endpoint and for the advertise gate; the mDNS
  browse check is manual — `dns-sd -B _mtglibrary._tcp` on the Mac, and on
  Windows a browser app on the phone (any "Bonjour browser" / "Service
  Browser" from the store) is the easiest check.

Update docs/CODEBASE-MAP.md and the atlas. Walk through the doc's
verification items 1–3 and 7 (4–6 need the phone app) and report.
```

## Session 3 prompt — Phase 20, Android companion (home mode only)

```
@CLAUDE.md @phases/apps/phase-20-native-companion-app.md @phases/apps/phase-29-pairing-and-lan-discovery.md @phases/apps/BUILD-BRIEF.md

Build Phase 20 at the "viability cut" in BUILD-BRIEF.md: Android, home mode
only. No shop mode, no snapshot, no queue, no idempotency table, no OCR, no
background sync, no iOS. Those are later sessions; leave the doc's structure
for them and do not stub them.

- A new `mobile/` workspace: Capacitor with the Android platform,
  TypeScript. A bundled pairing screen written as plain HTML/TS — it must
  not import anything from web/, and it must stay small enough that it is
  obviously not a second UI.
- Pairing: scan the Phase 29 QR (a Capacitor barcode plugin), parse the
  #pair= record, store it. Discovery in the doc's order — last address that
  worked, NSD browse for _mtglibrary._tcp filtered by TXT id (a small Kotlin
  plugin over NsdManager, holding a WifiManager.MulticastLock for the
  duration of the browse), the .local name, then the recorded addresses —
  each hit verified by GET /api/v1/instance matching the paired instanceId.
  Budget a few seconds.
- A network security config that permits cleartext HTTP to private address
  ranges and .local hosts, and nothing else. Capacitor server.allowNavigation
  for the same.
- On success, navigate the WebView to the server's origin. The web app
  renders from the server, unmodified. Check whether Capacitor's bridge is
  present on that origin and note the answer in a comment — home mode does
  not need it, but shop mode later will decide bundled-vs-remote on that
  basis.
- On failure, a "Can't find your library" screen with Retry and Re-pair.
  Re-run discovery on every app foreground.
- The web client's CONNECTIVITY_MESSAGE mentions the tailnet; make it not do
  that when the page is inside the shell, or make the shell catch the
  unreachable case before the page can show it.
- A debug APK build script; the APK is what I sideload.

Update docs/CODEBASE-MAP.md and the atlas. Add a "Phone app (Android)"
section to README.md: what it does today, that it is a sideloaded APK for
now.

Done means: pair once by QR, close the app, change the server machine's IP
(toggle its wifi or renew the DHCP lease), reopen the app, and it lands in
the web app without touching anything. Walk through Phase 29's verification
items 4–6 and Phase 20's item 9 (home mode is the web client byte-for-byte)
and report; tell me which of those need me on the physical phone.
```

---

## After the three sessions

If the checkpoints hold, the next sessions are the rest of Phase 20 in this order — the snapshot and shop-mode surface; the queue, `idempotency_keys` and `POST /api/v1/trades/record`; the pending overlay; background sync (`WorkManager`) and the wifi-join trigger — then signing (Windows certificate, Apple notarisation) and auto-update for Phase 28 — still Apple silicon only — then Phase 30 only if the never-home-together gap actually shows up. OCR (ML Kit on Android) waits on Phase 16. iOS, if ever, is `npx cap add ios`, the Bonjour twin of the discovery plugin, and an Apple developer account.

If they don't hold, the most likely reasons, in the order I would check: the packaged app cannot find `schema.sql` (directory shape); the Windows firewall prompt was dismissed (sharing looks on, nothing answers on the LAN address); the machine was asleep (the phone's *Last synced* age is the tell — see the keep-awake setting); multicast dropped on the phone (no `MulticastLock`, or a router with client isolation — try the recorded addresses, which the doc's fallbacks exist for); cleartext blocked (WebView blank, `ERR_CLEARTEXT_NOT_PERMITTED` in logcat); or `allowNavigation` missing a host pattern. None of those is a sign the idea is wrong.

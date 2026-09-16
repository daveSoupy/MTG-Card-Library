# Build brief — macOS and Windows desktop app, every phone through a browser

How to get a macOS and Windows desktop app running the existing server, reachable from any phone in the house, in four Claude Code sessions, without redoing any UI and without the self-hosted version stopping being the thing you develop. Each session is one phase, per CLAUDE.md's rules; this file is the scope and the prompts. `@`-mention it alongside the phase file.

**Targets are macOS first, then Windows, for the desktop app, and any phone with a browser for the rest.** macOS is primary because it is where development happens and where every check can be run on the spot; Windows ships from the same `desktop/` workspace — Electron makes it a second build target, not a second app — and its checks wait for a Windows machine. The desktop shell is one codebase for both. There is no phone app: the phone opens the web client from the desktop, pins it to the home screen, and gets every update the moment the desktop has it. The companion app that used to be the third leg of this plan is parked; the README says why, and its prompts are in the appendix so nothing is lost if it comes back.

## What "done" means

Four checkpoints, in order. Stop and look at each before the next session.

1. **A `.app` on a Mac, with no repo, no Node and no terminal, installs, opens, syncs the card database, and works.** Verified on this machine, then on a second user account or a second Mac to be sure nothing leaned on the dev environment. (Phase 31.) **1b.** The same for the Windows installer — whenever a Windows machine or VM is to hand; it does not block sessions 2 and 3.
2. **A phone's camera scans a QR on that machine and lands in the app.** (Phase 32.)
3. **The phone pins it to the home screen with its own icon, and from then on opens it like an app whenever it is on the home wifi.** If the PC's address changes, scanning the QR again fixes it, and the app says so. (Phase 33.)
4. **A friend downloads the Mac build and it opens with no warning, and it updates itself; the Windows build installs with at most a SmartScreen click-through.** (Phase 34.) Needs 1b done first.

The fourth is the one that decides whether a layperson can use this. Everything before it works for *you*; it is what makes it work for someone you hand a link to.

## How changes keep flowing from the self-hosted version

This is the property the whole plan is designed around, and it is worth being precise about, because it is the reason the desktop app can be started now without freezing anything.

- **The app contains no UI or rules.** `desktop/` is a workspace beside `server/` and `web/`. It holds a shell and build config. If a session finds itself copying a component, a type, or a rule into it, that is the mistake to stop and undo.
- **The desktop app is `server/dist` + `web/dist` + a Node binary.** `npm run build` at the root builds both as it does today; `npm run desktop:package` wraps the result. Every change to the self-hosted version is in the next package, unchanged. The systemd and Docker paths are untouched and still the way *you* run it.
- **The phone loads the UI from the desktop.** Whatever `web/dist` the desktop is serving is what the phone renders. A change to `web/` reaches every phone in the house on its next page load, with no store, no build and no install in between.
- **The web client is already phone-shaped.** Phase 9's one-handed layouts for trades, wants and collection lookups are what the phone shows. Nothing is redesigned; the phone gets a home-screen icon, and that is the whole difference from Chrome.

The one discipline this needs going forward: `web/` must keep working when served from a LAN address rather than `localhost`, and `server/` must keep being configurable purely by environment. Both are true today.

## Platform plumbing to know before the sessions run

These are not design decisions; they are the places a first run fails for reasons that have nothing to do with the idea.

**macOS** (primary)
- **Gatekeeper is a dead end, not a warning.** An unsigned `.app` downloaded from the internet says *"is damaged and can't be opened"*; the workaround (`xattr -d com.apple.quarantine`) is a terminal command, which is the thing the app exists to avoid. Your own build runs on your own Mac without any of this. Giving it to other Mac users needs Apple's developer program for signing and notarisation — session 4.
- **Apple silicon only — decided, not deferred.** No Intel build now or later; an Intel Mac runs the self-hosted version. A universal build would double the bundled Node for a platform Apple stopped selling in 2023.
- Close leaves the app running (Dock icon, menu-bar item); ⌘Q quits. The rule Mac users already expect, and the same one Windows gets.
- **Testing "no Node installed" on the machine that has Node.** A second macOS user account is the cheap way: nothing from your login's Homebrew or `nvm` is on its `PATH`, so a build that secretly leans on the dev environment fails there first.

**Windows** (second target, same workspace)
- **Building from a Mac.** electron-builder produces the Windows NSIS installer on macOS with no Windows machine and no Wine — it fetches its own tools on first run; the build is part of session 1 even though its checks are not. The tray behaviour, the firewall prompt and the close semantics only show on real Windows — verify on a machine or a VM when one is to hand (checkpoint 1b), and before session 4.
- **The firewall prompt.** The first time the server binds `0.0.0.0`, Windows Defender Firewall asks whether to allow the bundled `node.exe` on private networks. *Cancel* means LAN sharing silently does not work. The shell explains this in a sentence right before flipping the toggle, and *Show logs* is where "the phone can't find it" gets diagnosed.
- **Close hides to the tray; Quit is explicit.** Windows convention is close-means-quit, so the first-launch notice matters most here: a user who "closes" it must not believe it is off.
- **SmartScreen** interposes "Windows protected your PC" for an unsigned installer. Until session 4, friends click *More info → Run anyway*.

**Phones**
- **The QR must carry an IP address, not the `.local` name.** iPhones resolve `mtg-library-XXXX.local` natively; Android browsers often do not. The URL in the QR is the desktop's current LAN IP; the `.local` name is shown beside it as text for anyone who can use it.
- **Plain `http://` on the LAN, and what that costs.** iOS *Add to Home Screen* works over HTTP and launches standalone. Android Chrome's automatic install banner needs HTTPS, so on Android the user adds it from the browser menu and gets a home-screen shortcut that behaves the same. Camera *capture* through `<input capture>` works over HTTP on both; `getUserMedia` (live viewfinder) does not, and nothing in the web client uses it.
- **When the phone can't reach the PC** — VPN off, not on the home wifi, PC asleep, or its IP changed — the pinned icon must open to *our* reconnect screen, not the browser's error page, and recover on its own when the path is back. That is session 3's service worker (a network-first cache of the static bundle, never of `/api/*`) and reconnect banner; the message names the fix for the way the page was installed (turn on Tailscale / get on the home wifi and rescan the QR).
- **Sleep is the outage.** A PC that sleeps is a phone that cannot connect. Phase 31's *Keep this computer awake while sharing* is the setting; the phone's error message is the tell.

## The cut, per phase

**Phase 31 — build:** `desktop/` Electron workspace; server spawned on a bundled official Node binary for the target platform (no ABI rebuild); health-poll splash; window; tray with *Open*, *Allow other devices on this network*, *Keep this computer awake while sharing*, *Launch at login*, *Show data folder*, *Show logs*, *Quit*; close hides, Quit stops, on both platforms; the first-launch background notice; the firewall explanation; persisted port; single instance; `npm run desktop:dev` (runs on the Mac) and `npm run desktop:package` producing a macOS arm64 `.app`/`.dmg` and a Windows x64 installer, both unsigned. macOS verified in-session; Windows built in-session, verified when a machine is to hand.
**Phase 34 — build:** all of it: signing and notarisation, `electron-updater` against GitHub Releases, the release workflow. **Never:** Linux packaging (systemd and Docker cover it), Intel Macs.

**Phase 32 — build:** all of it. `instance_id`, `GET /api/v1/instance`, `MTG_ADVERTISE` + mDNS, the QR panel in `DataPage.tsx`, the tray item. The "Phone: discovery order" section is the parked app's contract and is not built.

**Phase 33 — build:** all of it, over plain HTTP. Manifest, icons, `index.html` tags, the network-first shell cache (never `/api/*`), and the reconnect banner whose message is chosen by the origin the page was reached on — the doc's table covers Tailscale, home wifi, the desktop app's own window and unknown.

## Before session 1

- Node 22.6+ and the repo building clean (`npm run build && npm test`).
- A second macOS user account (System Settings → Users & Groups) for checkpoint 1. A Windows machine or VM for checkpoint 1b, whenever convenient — not before session 1.
- A phone — any — on the same wifi, for checkpoints 2 and 3.
- For session 4: the Apple Developer Program membership is in hand — it needs a *Developer ID Application* certificate in the login keychain, the same certificate exported as a `.p12` for CI (it becomes the `CSC_LINK` secret, base64), an app-specific password for notarisation, and the Team ID. A Windows code-signing certificate is a separate purchase, still undecided; the workflow builds Windows unsigned until one exists.

---

## Session 1 prompt — Phase 31, desktop app (macOS first, Windows second)

```
@CLAUDE.md @phases/apps/phase-31-desktop-app.md @phases/apps/BUILD-BRIEF.md

Build Phase 31 at the scope in BUILD-BRIEF.md's "The cut, per phase": a desktop app
that runs the existing server and shows the existing web client. macOS
arm64 is the primary target and is verified here; Windows x64 is a second
build target from the same workspace whose checks I will run later on a
Windows machine. Nothing in server/src or web/src changes shape.

Concretely:
- A new `desktop/` npm workspace: Electron + electron-builder, TypeScript,
  `main.ts` only — no renderer code. Register it in the root package.json
  workspaces and add root scripts `desktop:dev` and `desktop:package`.
- The server runs as a child process on a bundled official Node binary (the
  release matching root `engines.node`, for the target platform —
  darwin-arm64 for the mac build, win-x64 for the Windows build), fetched into
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
  disabled — your call, say which and why in a comment). Resources come from
  a staging step that mirrors the Dockerfile's runtime stage (production-only
  root node_modules with the @mtg-library workspace symlinks removed,
  schema.sql, server/dist, web/dist) — see the phase doc's "Which
  node_modules" — never from desktop/'s own dependency tree.
- Auto-update, signing and notarisation are Phase 34; leave clear TODO
  markers. Linux is never. Note in the README that the unsigned mac build needs
  `xattr -d com.apple.quarantine` if downloaded rather than built locally.

Update docs/CODEBASE-MAP.md with the new workspace and rerun
`python3 docs/atlas/build.py`. Add a short "Desktop app" section to
README.md: both builds unsigned for now — how SmartScreen is dismissed on
Windows, and the quarantine step on a Mac.

Write desktop/CLAUDE.md (~30 lines, auto-loaded by any later session that
touches desktop/): no renderer code and no Electron branches in web/src;
bundled Node, never ELECTRON_RUN_AS_NODE, no @electron/rebuild, the
check-sqlite gate; the env vars the shell owns and why MTG_HOST is loopback
here while config.ts stays 0.0.0.0; close hides / Quit stops on every
platform; the asar layout and why; a "signing" heading left as a TODO for
session 4. Rules only — not a copy of the phase doc.

Done means: `npm run desktop:package` produces a mac .app/.dmg and a
Windows installer. The mac build, on a machine with no Node on its PATH
(a second macOS user account is fine), installs, opens, offers the first
sync, completes it, and searches — and Phase 31's verification items 1–6
pass on macOS, verified by you on this machine. For Windows, the build
must succeed and the packaged layout must be right; the runtime checks are
mine to do later — give me the exact list to walk through on a Windows
machine and what each should show, and do not block on them.
```

## Session 2 prompt — Phase 32, pairing and discovery

```
@CLAUDE.md @phases/apps/phase-32-pairing-and-lan-discovery.md @phases/apps/BUILD-BRIEF.md

Build Phase 32 in full — it is small, and the QR code it produces is how
every phone reaches the app.

- instance_id written to app_settings on first open via setSetting in
  db/index.ts (not through the settings route).
- GET /api/v1/instance per the doc; MTG_ADVERTISE in config.ts; DNS-SD
  advertisement of _mtglibrary._tcp with a pure-JS library, only when the
  flag is on and the bind is not loopback. Confirm the library works on
  Windows as well as macOS (Windows 10+ resolves mDNS natively; the
  advertisement side is the library's). The Phase 31 shell sets the flag
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
verification items 1–3 and 7 and report; 4–6 describe the parked companion
app and are not in scope. The "Phone: discovery order" section is that
app's contract — leave it in the doc, build none of it.
```

## Session 3 prompt — Phase 33, home-screen install and reconnect

```
@CLAUDE.md @phases/apps/phase-33-pwa-install-flow.md @phases/apps/phase-32-pairing-and-lan-discovery.md @phases/apps/BUILD-BRIEF.md

Build Phase 33 in full, over plain HTTP — the doc's HTTPS section records
the decision. Two halves: the home-screen install, and what the app does
when it cannot reach the server.

Install:
- web/public/ with manifest.webmanifest (name "MTG Library", display
  standalone, start_url "/", theme and background colours matching the
  default theme in styles.css) and icons: 192, 512, maskable 512, and an
  apple-touch-icon. Original artwork — a simple mark, no card art, no
  Wizards marks. Commit the source (SVG) alongside the PNGs.
- index.html: manifest link, apple-touch-icon, apple-mobile-web-app-capable
  and status-bar-style, theme-color.
- The pairing panel in DataPage.tsx (Phase 32) gains one line under the QR:
  "On your phone, open this and choose Add to Home Screen."

Service worker (web/public/sw.js, registered from main.tsx), exactly as the
doc's rules say: network-first for same-origin GET of the static bundle,
cache read only when the network fails, successful responses replace the
cached copy, /api/* returned from the fetch listener before anything else
happens, versioned cache name with old ones deleted on activate, and
fastifyStatic serving sw.js with Cache-Control: no-cache. Put the four rules
in a comment at the top of the file — the next person to open it must not
mistake it for the start of an offline mode.

Reconnecting:
- web/src/reachability.ts: one pure function from a hostname to
  'tailnet' | 'lan' | 'local' | 'unknown' per the doc's table, with the
  message for each; unit-tested with the doc's nine examples.
- One app-level banner in App.tsx, raised by any ApiError with
  isConnectivity, replacing CONNECTIVITY_MESSAGE's per-page use. While up:
  poll GET /api/v1/health every 3s, and immediately on window 'online' and
  on visibilitychange to visible. On a healthy answer, clear the banner and
  refetch the current view. No reload.
- A write that failed on connectivity stays failed and says so. Nothing is
  queued.

Verification per the doc, all seven; 4 and 5 on a real phone — tell me the
steps. For 4, "server unreachable" means the desktop app quit, or the phone
off the home wifi, or Tailscale off — try at least two of the three.
```

## Session 4 prompt — Phase 34, signing and updates

```
@CLAUDE.md @phases/apps/phase-34-signing-and-updates.md @phases/apps/BUILD-BRIEF.md

Build Phase 34: signing, notarisation and auto-update for the Phase 31
desktop app. Nothing in server/src, web/src or the shell's lifecycle
changes; this is the build pipeline and the release workflow.

- macOS: hardened runtime, entitlements for the bundled Node binary (it
  JITs — allow-jit and allow-unsigned-executable-memory at minimum; confirm
  the packaged app runs under the hardened runtime before notarising), the
  bundled node listed under mac.sign.binaries so notarisation sees it signed,
  notarisation through electron-builder's notarize option with APPLE_ID,
  APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID from the environment, the
  certificate itself as CSC_LINK (base64 .p12) + CSC_KEY_PASSWORD on CI,
  stapled. Keep the dmg + zip targets — the updater needs the zip. Verify
  with spctl --assess and by downloading the .dmg on a second Mac.
- Windows: sign with the certificate in the environment if present; if
  absent, build unsigned and say so in the workflow output rather than
  failing. Note in the README what SmartScreen shows for each.
- electron-updater against GitHub Releases: check on launch and daily,
  download in the background, a "Restart to update" tray item, applied on
  next quit. No mid-session prompt, ever. The server's migrations run on the
  next open, which is the whole of the shell's migration story.
- .github/workflows/desktop.yml: on a v* tag, build the mac arm64 .dmg on
  macos-latest and the Windows x64 installer on windows-latest, run
  server/scripts/check-sqlite.mjs against each packaged app's Node +
  better-sqlite3 as a gate, and upload the artifacts (dmg, mac zip, Windows
  installer) plus electron-updater's latest*.yml to the release, publishing
  through the workflow's GITHUB_TOKEN. Leave docker.yml alone.
- README "Desktop app" section: the download links, that it updates itself,
  the size, and the either/or with a home server.

Fill in the "signing" heading session 1 left in desktop/CLAUDE.md.

Done means the doc's six verification items pass. Tell me which steps need
my Apple and GitHub credentials and exactly where each goes.
```

---

## After the four sessions

The desktop app is the product. What changes next comes through `web/` and `server/` as it always has, and reaches every install through the updater and every phone on its next page load.

If a checkpoint doesn't hold, the most likely reasons, in the order I would check: the packaged app cannot find `schema.sql` (directory shape); the Windows firewall prompt was dismissed (sharing looks on, nothing answers on the LAN address); the machine was asleep (the phone's error is the tell — see the keep-awake setting); the router isolates clients (the QR's IP answers from the PC itself but not from the phone — a router setting, and the README should name it); or the phone cached an old address (rescan the QR). None of those is a sign the idea is wrong.

The trigger for un-parking the companion app is one sentence: *I wanted to record a trade at the shop and couldn't.* When that is said, the order is Phase 35 (server, no phone), then Phase 36's Android home-mode session below, then shop mode. Both prompts are kept here as written; the README's parked section has the reasoning.

---

## Appendix — parked prompts (companion app)

Kept verbatim from the earlier plan. The docs live in `parked/`. Do not run without reading the README's parked section first.

### Android plumbing

**Android**
- **Discovery is `NsdManager`**, and the plugin must hold a `WifiManager.MulticastLock` while browsing or the wifi driver drops the multicast packets. `.local` name resolution is unreliable on Android, so the browse step and the recorded-address fallback in Phase 32's order carry the weight.
- **Cleartext HTTP is blocked by default** in Android apps. A network security config allowing `http://` to private ranges and `.local` is required or the WebView shows nothing. (iOS has the same gate, App Transport Security, if it is ever added.)
- **Use a real phone, not the emulator.** Emulator networking makes mDNS miserable. USB debugging on, same wifi as the PC.
- **Distribution is an APK** on the GitHub release page, sideloaded. No developer account, no expiry. Play Store is optional and later.

### Parked session — Phase 35, sync contract (server only)

Pure server work; needs Phase 32 and nothing else. The first thing to run if the app is un-parked.

```
@CLAUDE.md @phases/apps/parked/phase-35-sync-contract.md @phases/apps/parked/phase-36-native-companion-app.md

Build Phase 35 in full: the server side of the companion app's sync
contract. Server and one migration only — nothing in mobile/, nothing in
web/src beyond the new alert kind's type and label. The umbrella Phase 36
doc is context for what the phone will do with this; where the two differ,
35 is the decision and says why.

- New server/src/companion/: snapshot.ts (buildSnapshot) and idempotency.ts
  (withIdempotencyKey). Routes in server/src/routes/companion.ts,
  registered in index.ts. Never use the bare word "snapshot" for a type or
  function — the codebase already has deck snapshots and the collection
  value snapshot, and this is neither.
- GET /api/v1/snapshot: the document shaped exactly as the doc shows,
  gzipped with zlib (no compression plugin). The per-card owned / reserved /
  tradeListed / available / tracked come from allocation.ts, never
  re-derived; decks carry reserves(status); catalog is an array of tuples.
  formatVersion 1, additive-only, with that rule as a comment at the top of
  snapshot.ts.
- idempotency_keys in both schema.sql and migrations.ts, next unused
  user_version. withIdempotencyKey does the lookup, the store call and the
  key insert inside ONE db.transaction, returns { status, body, replayed },
  stores 4xx results as well as successes, and prunes rows older than 30
  days on insert. Not a preHandler — the doc explains the crash window.
- POST /api/v1/trades/record: Idempotency-Key required (400 without);
  create + addItem per item + complete({ conflictMode: 'alert' }) in one
  transaction; 201 { trade, result }. TradeShortfallError → 409 with the
  shortfalls, nothing applied, the 409 stored — and map TradeShortfallError
  to 409 in errorHandler.ts, where it is missing today.
- New alert kind replay_failed: widen the CHECK on alerts.kind by rebuilding
  the table in the migration and recreating idx_alerts_active identically;
  add the kind to AlertKind in alerts/store.ts, its mirror in web/src/api.ts,
  and a label in AlertsBell.tsx. Raised on the 409 only, dedupe_key
  'replay_failed:<key>', payload = the request body.
- POST /api/v1/want-lists/:id/items: Idempotency-Key optional; when present,
  wrap in the helper; when absent, behave exactly as now (existing tests
  unchanged).
- serverVersion read through the same function Phase 32's instance endpoint
  uses.

Tests for every verification item in the doc (1–11), via app.inject where a
route is involved, and migrations.test.ts must pass with the rebuilt alerts
table. Update docs/CODEBASE-MAP.md (new directory and route file, the
"where do I edit" row for idempotency) and rerun python3 docs/atlas/build.py.

Done means all eleven verification items pass as tests, and the three
follow-up edits listed under "After this ships" in the Phase 35 doc are applied
to parked/phase-36-native-companion-app.md and parked/phase-37-cloud-mailbox.md.
```

### Parked session — Phase 36, Android companion (home mode only)

```
@CLAUDE.md @phases/apps/parked/phase-36-native-companion-app.md @phases/apps/phase-32-pairing-and-lan-discovery.md @phases/apps/BUILD-BRIEF.md

Build Phase 36 at the scope in this prompt: Android, home mode
only. No shop mode, no snapshot, no queue, no idempotency table, no OCR, no
background sync, no iOS. Those are later sessions; leave the doc's structure
for them and do not stub them.

- A new `mobile/` workspace: Capacitor with the Android platform,
  TypeScript. A bundled pairing screen written as plain HTML/TS — it must
  not import anything from web/, and it must stay small enough that it is
  obviously not a second UI.
- Pairing: scan the Phase 32 QR (a Capacitor barcode plugin), parse the
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
the web app without touching anything. Walk through Phase 32's verification
items 4–6 and Phase 36's item 9 (home mode is the web client byte-for-byte)
and report; tell me which of those need me on the physical phone.
```

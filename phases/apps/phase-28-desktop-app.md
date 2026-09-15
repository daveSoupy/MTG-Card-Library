# Phase 28 — Desktop App

The server, packaged as an ordinary application: double-click to start, ⌘Q to stop, updates itself. For the person who does not have an always-on Linux box and should never have to open a terminal. The systemd install (`deploy/`) and the Docker image stay exactly as they are — this is a third way to run the *same* `server/dist`, differing from the other two only in how three environment variables get set.

Nothing in `server/src` or `web/src` changes shape. The whole phase is a shell around a process that already exists, and most of the work is in the build pipeline rather than in code.

## Why a shell, not a rewrite

The server already has the three properties a desktop app needs:

- **It finds its own files.** `server/src/index.ts` and `server/src/db/index.ts` walk up from `dist/` to `schema.sql` and `web/dist`. The Dockerfile keeps the repository's directory shape for this reason; the app bundle does the same.
- **It is configured entirely by environment.** `MTG_DATA_DIR`, `MTG_HOST`, `MTG_PORT`, `MTG_LOG_LEVEL` (`server/src/config.ts`). The shell sets them; the server never learns it is inside an app.
- **It shuts down cleanly on SIGTERM.** `index.ts`'s `close` handler stops the sync worker (10s ceiling), closes Fastify, closes the database. Quit is a signal and a wait.

Migrations run on open (`db/index.ts`), so an updated app over an old database is already handled. Scheduled backups (`porting/schedule.ts`) keep running because the data directory is the only thing they care about.

## Shape

A new `desktop/` workspace: Electron, `electron-builder`, a `main.ts` of a few hundred lines. No renderer code — the window loads `http://127.0.0.1:<port>/` and the existing web client renders as it does in a browser. `contextIsolation` on, `nodeIntegration` off; the page has no reason to touch Node.

The server runs as a **separate child process**, not inside Electron's main process: `child_process.spawn(process.execPath, [serverEntry], { env: { ELECTRON_RUN_AS_NODE: '1', ... } })`, or `utilityProcess.fork`. Either way it is the unmodified `server/dist/index.js`. A crash in the server is a restart with a notice, not a dead window; a stuck quit is a killed child, not a hung app.

### Environment the shell sets

| Variable | Value | Why |
| --- | --- | --- |
| `MTG_DATA_DIR` | `<app.getPath('userData')>/library` | Per-platform application-support directory (`~/Library/Application Support/MTG Library/library` on macOS). The server's own default is `~/.local/share/mtg-library`, a Linux convention. An `MTG_DATA_DIR` already in the app's environment wins, so a developer can point the app at an existing library. |
| `MTG_HOST` | `127.0.0.1`, or `0.0.0.0` while *Allow other devices on this network* is on | The server's default of `0.0.0.0` is right behind Tailscale and wrong on a laptop on café wifi: an unauthenticated app on every interface. Off by default; Phase 29 builds pairing on top of the on state. |
| `MTG_PORT` | `8080` if free, else the next free port, **persisted** in the shell's own config | A stable port keeps phone bookmarks and Phase 29 pairing valid across launches. The port is the shell's to remember, not the server's. |
| `MTG_LOG_LEVEL` | `info` | Server stdout/stderr go to `<userData>/logs/server.log`, rotated. *Help → Show logs* opens the folder. |

### Lifecycle

- **Launch.** Single-instance lock (a second launch focuses the first). Spawn the server, then poll `GET /api/v1/health` until it answers; show a splash with the server's own boot messages until then. The first cold start includes `warmCache()` and any pending migrations, so this is seconds, not milliseconds, and the window must not load a connection-refused page in the meantime.
- **Close the window.** On macOS the app stays running — Dock icon, menu-bar item, server up. Clicking the Dock icon reopens the window. On Windows and Linux, closing the window quits **unless** *Allow other devices on this network* is on, in which case it closes to the tray: the only reason to keep a server running with no window is that another device might be using it. That one rule makes the behaviour predictable for someone who does not think in terms of servers.
- **Quit.** SIGTERM to the child, a *Finishing up…* indicator if it takes more than a second (a bulk sync mid-write can take up to the server's 10s ceiling), then exit. Never `SIGKILL` first; the database is in WAL mode and an unclean exit is survivable but pointless.
- **Sleep.** The app does nothing about it. A closed lid is a stopped server, and Phase 20's shop mode is the answer to that, not a power assertion.

### Menu / tray

*Open MTG Library* · *Allow other devices on this network* (checkbox; restarts the child with the new `MTG_HOST`) · *Pair a phone…* (Phase 29; hidden until then) · *Show data folder* · *Show logs* · *Check for updates* · *Quit*.

`Show data folder` matters more than it looks: it is the backup story for someone who will never read `README.md#backups`. The folder holds `library.sqlite`, the image cache, and the scheduled backups.

## Build pipeline

This is where the phase's actual risk lives.

- **Native module ABI.** `better-sqlite3` is compiled against a Node ABI. Running the server with Electron's bundled Node means rebuilding it for Electron's ABI (`@electron/rebuild`). After every rebuild, `server/scripts/check-sqlite.mjs` must run **against the packaged app's copy** — FTS5 and the trigram tokenizer are the things a rebuild silently loses, and nothing works without them. This is a release gate, not a one-time check.
- **Archive layout.** Electron packs the app into an `.asar`; native `.node` binaries and `new Worker(path)` (`sync/syncManager.ts`) cannot load from inside one. `server/**`, `schema.sql`, and `node_modules/better-sqlite3/**` go in `asarUnpack` — or asar is disabled outright; either is fine as long as the walk-up from `server/dist` still lands on `schema.sql` and `web/dist`.
- **Updates.** `electron-updater` against GitHub Releases, checked on launch and daily, applied on next quit. The user sees a *Restart to update* item, never a prompt mid-session. No migration step is needed in the shell; the server does that.
- **Signing and notarisation are part of the deliverable.** An unsigned macOS download is *"damaged and can't be opened"* — a dead end, not a warning — and Windows SmartScreen interposes a scary screen. Apple Developer Program for the Mac build; a code-signing certificate for Windows if it ships. Without these the app is not "dead simple" for anyone, and the phase is not done.
- **Size.** ~150–250 MB. Say so on the download page.

## What this phase does not change

- The server's defaults. `config.ts` keeps `0.0.0.0` and `~/.local/share/mtg-library`; the shell overrides them because it knows its context. Systemd and Docker are unaffected.
- The web client. No Electron-specific branches in `web/src`.
- The one-database rule. Someone with both a home server and the desktop app has two libraries that never reconcile. The README should say plainly: the desktop app is for people *without* a home server; it is either/or.

## Verification

1. A fresh install on a machine with no Node, no repo, and no prior data directory launches, offers the first sync, completes it, and searches — without a terminal.
2. `check-sqlite.mjs` run against the packaged app's `better-sqlite3` reports FTS5, trigram, and a clean schema load. Automated in the release workflow.
3. Quitting during a bulk sync exits cleanly within the server's ceiling; relaunching finds the database intact and the sync resumable (re-runnable).
4. Closing the window on macOS leaves the server answering `/api/v1/health`; ⌘Q stops it. On Windows/Linux, closing the window quits with the sharing toggle off and hides to the tray with it on.
5. With *Allow other devices on this network* off, `curl http://<LAN IP>:8080/api/v1/health` from another machine is refused; on, it answers.
6. Launching with port 8080 occupied picks another port, persists it, loads the window correctly, and reuses that port on the next launch.
7. Installing a newer build over an older data directory runs the migration and opens; `migrations.test.ts` already proves the DDL, this proves the packaging did not break the path to it.
8. The macOS build opens on a second Mac straight from the `.dmg` with no Gatekeeper override.

## Out of scope

- Moving or choosing the data directory from the UI. `MTG_DATA_DIR` in the environment covers the developer case.
- Any remote access. Phase 29 covers the home network; nothing here or there reaches outside it.
- Bundling a standalone Node instead of rebuilding against Electron's ABI — a valid alternative if the rebuild proves fragile, decided at build time.

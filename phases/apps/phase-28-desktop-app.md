# Phase 28 — Desktop App

The server, packaged as an ordinary application: double-click to start, ⌘Q to stop. (Signing, notarisation and self-update are [Phase 28b](phase-28b-signing-and-updates.md), the session after this one.) For the person who does not have an always-on Linux box and should never have to open a terminal. The systemd install (`deploy/`) and the Docker image stay exactly as they are — this is a third way to run the *same* `server/dist`, differing from the other two only in how three environment variables get set.

Nothing in `server/src` or `web/src` changes shape. The whole phase is a shell around a process that already exists, and most of the work is in the build pipeline rather than in code.

## Why a shell, not a rewrite

The server already has the three properties a desktop app needs:

- **It finds its own files.** `server/src/index.ts` and `server/src/db/index.ts` walk up from `dist/` to `schema.sql` and `web/dist`. The Dockerfile keeps the repository's directory shape for this reason; the app bundle does the same.
- **It is configured entirely by environment.** `MTG_DATA_DIR`, `MTG_HOST`, `MTG_PORT`, `MTG_LOG_LEVEL` (`server/src/config.ts`). The shell sets them; the server never learns it is inside an app.
- **It shuts down cleanly on SIGTERM.** `index.ts`'s `close` handler stops the sync worker (10s ceiling), closes Fastify, closes the database. Quit is a signal and a wait.

Migrations run on open (`db/index.ts`), so an updated app over an old database is already handled. Scheduled backups (`porting/schedule.ts`) keep running because the data directory is the only thing they care about.

## Shape

A new `desktop/` workspace: Electron, `electron-builder`, a `main.ts` of a few hundred lines. No renderer code — the window loads `http://127.0.0.1:<port>/` and the existing web client renders as it does in a browser. `contextIsolation` on, `nodeIntegration` off; the page has no reason to touch Node.

The server runs as a **separate child process**, not inside Electron's main process, and it runs on a **bundled official Node binary** — the `node` release matching `engines.node`, downloaded at package time and shipped in the app's resources — not on Electron's Node (`ELECTRON_RUN_AS_NODE`). This costs ~50 MB and buys the removal of the phase's biggest risk: `better-sqlite3`'s prebuilt binary for stock Node works as installed, so there is no `@electron/rebuild` step and no way for a rebuild to silently drop FTS5 or the trigram tokenizer. `check-sqlite.mjs` still runs against the packaged copy as a gate; it just has nothing to catch. Either way it is the unmodified `server/dist/index.js`. A crash in the server is a restart with a notice, not a dead window; a stuck quit is a killed child, not a hung app.

### Environment the shell sets

| Variable | Value | Why |
| --- | --- | --- |
| `MTG_DATA_DIR` | `<app.getPath('userData')>/library` | Per-platform application-support directory (`~/Library/Application Support/MTG Library/library` on macOS). The server's own default is `~/.local/share/mtg-library`, a Linux convention. An `MTG_DATA_DIR` already in the app's environment wins, so a developer can point the app at an existing library. |
| `MTG_HOST` | `127.0.0.1`, or `0.0.0.0` while *Allow other devices on this network* is on | The server's default of `0.0.0.0` is right behind Tailscale and wrong on a laptop on café wifi: an unauthenticated app on every interface. Off by default; Phase 29 builds pairing on top of the on state. |
| `MTG_PORT` | `8080` if free, else the next free port, **persisted** in the shell's own config | A stable port keeps phone bookmarks and Phase 29 pairing valid across launches. The port is the shell's to remember, not the server's. |
| `MTG_LOG_LEVEL` | `info` | Server stdout/stderr go to `<userData>/logs/server.log`, rotated. *Help → Show logs* opens the folder. |

### Lifecycle

- **Launch.** Single-instance lock (a second launch focuses the first). Spawn the server, then poll `GET /api/v1/health` until it answers; show a splash with the server's own boot messages until then. The first cold start includes `warmCache()` and any pending migrations, so this is seconds, not milliseconds, and the window must not load a connection-refused page in the meantime.
- **This is a background app with a window.** The point of it is to be up whenever the machine is up, so the phone can sync without anyone opening anything. It follows the Dropbox/Discord pattern on every platform: **closing the window hides it** (Dock or tray icon reopens it, server keeps running); **Quit is only ever explicit** — ⌘Q, or *Quit* in the tray menu — and is what stops the server. One rule, same on macOS, Windows and Linux; no cleverness about when close means quit.
- **Launch at login, on by default.** `app.setLoginItemSettings`; a checkbox in the tray menu turns it off. Without this the design leans on the user remembering to open an app, which is the thing it exists to remove.
- **Say so once.** First launch shows a single notice: *MTG Library runs in the background — find it in the menu bar / system tray. Quit from there to stop it.* Otherwise a Windows user "closes" it and believes it is off.
- **Quit.** SIGTERM to the child, a *Finishing up…* indicator if it takes more than a second (a bulk sync mid-write can take up to the server's 10s ceiling), then exit. Never `SIGKILL` first; the database is in WAL mode and an unclean exit is survivable but pointless.
- **Sleep is the real outage, and the app is honest about it.** A desktop PC that sleeps after thirty idle minutes is down most of the day; a laptop with the lid closed is down regardless. A setting — *Keep this computer awake while sharing is on*, off by default, one sentence on the power trade — holds an Electron `powerSaveBlocker` (`prevent-app-suspension`) while sharing is on. Right for a desktop tower, wrong to force on a laptop, so it is a choice. Phase 20's snapshot-and-queue design is what makes sleep survivable rather than fatal: the phone syncs the next time both are awake.

### Menu / tray

*Open MTG Library* · *Allow other devices on this network* (checkbox; restarts the child with the new `MTG_HOST`) · *Keep this computer awake while sharing* (checkbox) · *Launch at login* (checkbox, on by default) · *Pair a phone…* (Phase 29; hidden until then) · *Show data folder* · *Show logs* · *Check for updates* (Phase 28b wires it; present but inert until then) · *Quit*.

`Show data folder` matters more than it looks: it is the backup story for someone who will never read `README.md#backups`. The folder holds `library.sqlite`, the image cache, and the scheduled backups.

## Build pipeline

This is where the phase's actual risk lives.

- **Native module ABI.** Avoided by the bundled-Node decision above. If that is ever reversed (to save the 50 MB), `better-sqlite3` must be rebuilt for Electron's ABI with `@electron/rebuild`, and `server/scripts/check-sqlite.mjs` must run **against the packaged app's copy** after every rebuild — FTS5 and the trigram tokenizer are what a rebuild silently loses. Keep the gate in the release workflow regardless; it is cheap.
- **Archive layout.** Electron packs the app into an `.asar`; native `.node` binaries and `new Worker(path)` (`sync/syncManager.ts`) cannot load from inside one. `server/**`, `schema.sql`, and `node_modules/better-sqlite3/**` go in `asarUnpack` — or asar is disabled outright; either is fine as long as the walk-up from `server/dist` still lands on `schema.sql` and `web/dist`.
- **Updates, signing and notarisation are Phase 28b.** This phase produces unsigned installers that work on the machine that built them and on a Windows machine past a SmartScreen click; a downloaded Mac build needs `xattr -d com.apple.quarantine` until 28b. The app is not finished for anyone else until 28b is — the split is about sessions, not about whether it ships.
- **Size.** ~150–250 MB. Say so on the download page.
- **macOS is Apple silicon only.** No Intel or universal build; an Intel Mac runs the self-hosted install. Decided, so a future session does not add the second Node binary out of thoroughness.

## What this phase does not change

- The server's defaults. `config.ts` keeps `0.0.0.0` and `~/.local/share/mtg-library`; the shell overrides them because it knows its context. Systemd and Docker are unaffected.
- The web client. No Electron-specific branches in `web/src`.
- The one-database rule. Someone with both a home server and the desktop app has two libraries that never reconcile. The README should say plainly: the desktop app is for people *without* a home server; it is either/or.

## Verification

1. A fresh install on a machine with no Node, no repo, and no prior data directory launches, offers the first sync, completes it, and searches — without a terminal.
2. `check-sqlite.mjs` run against the packaged app's `better-sqlite3` reports FTS5, trigram, and a clean schema load. Automated in the release workflow.
3. Quitting during a bulk sync exits cleanly within the server's ceiling; relaunching finds the database intact and the sync resumable (re-runnable).
4. Closing the window on every platform leaves the server answering `/api/v1/health` and the tray/Dock icon reopens it; Quit from the tray (or ⌘Q) stops it. A fresh install is registered as a login item; unchecking *Launch at login* removes it.
4a. With *Keep this computer awake while sharing* on and sharing on, the system's idle-sleep timer does not fire; with either off, it does.
5. With *Allow other devices on this network* off, `curl http://<LAN IP>:8080/api/v1/health` from another machine is refused; on, it answers.
6. Launching with port 8080 occupied picks another port, persists it, loads the window correctly, and reuses that port on the next launch.

Migration-over-old-data, Gatekeeper on a second Mac, and the update path are Phase 28b's verification.

## Out of scope

- Moving or choosing the data directory from the UI. `MTG_DATA_DIR` in the environment covers the developer case.
- Any remote access. Phase 29 covers the home network; nothing here or there reaches outside it.
- Running the server on Electron's own Node to save the bundled binary's ~50 MB. Possible later, at the cost of the ABI rebuild and its gate.

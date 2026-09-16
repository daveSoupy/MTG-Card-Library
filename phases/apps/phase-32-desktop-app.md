# Phase 32 — Desktop App

> **Shipped 2026-09-16.** Built as specced, with these departures and findings recorded at build time:
>
> - **Two server edits, not one.** The worker heuristic is now `import.meta.url.endsWith('.ts')` — the module's own extension, which no install path can fool — rather than a path-segment test. The second edit is new: `MTG_SHUTDOWN_ON_STDIN_CLOSE=1` makes `index.ts` run its `close` handler when stdin ends. Windows has no SIGTERM to send a child (`kill()` there is TerminateProcess, straight past the close handler), so the shell owns the child's stdin and closes it to ask for shutdown. Opt-in, because under systemd stdin is `/dev/null` and ends at boot. It also means a shell that dies takes the server with it instead of leaving an orphan on the port. `close` became idempotent for the case where both arrive.
> - **"Free port" is a bind *and* a connect.** On macOS a bind to `127.0.0.1:8080` succeeds while another process holds `*:8080` (SO_REUSEADDR, which Node sets), and the new socket then shadows the old one on loopback — found the moment the dev app was pointed at a machine whose dev server held 8080. Linux refuses that bind. `config.ts` asks both questions.
> - **Packaged layout:** the staged tree is `Resources/mtg-library`, not `Resources/app` — Electron loads a directory of that name as the application. asar stays on for the shell only; the server tree ships as `extraResources`, which is never asar'd, with `node_modules` as its own entry because electron-builder's copy filter drops a root-level `node_modules` from any source unconditionally. Every `.bin` directory is stripped in staging — 7-Zip fails the NSIS build on a dangling symlink. `check-packaged.mjs` caught both.
> - **Electron is pinned exactly** (electron-builder requires it in a hoisted workspace). Sizes: the bundled Node is ~113 MB on disk, not 50; the artifacts are 165 MB (.dmg), 166 MB (.zip), 135 MB (Windows installer).
> - **The first-launch notice is a dialog**, not a system notification — an unsigned app cannot reliably post one on macOS.
> - **The status page** (splash, "stopped unexpectedly", "finishing up") is one inline HTML template in `main.ts` with a three-line text setter. That is the whole of the shell's markup.
> - **Scripted verification.** `MTG_DESKTOP_INSPECT=1` exposes the tray's actions on `globalThis` for `electron --inspect`; `scripts/verify-lifecycle.mjs` walks items 4, 4a, 5 and 6 (26 checks) against the dev app and, with `--app`, the packaged one. Items 1–3 were walked by hand on the built `.app` (see Verification below).

The server, packaged as an ordinary application: double-click to start, ⌘Q to stop. (Signing, notarisation and self-update are [Phase 34](phase-34-signing-and-updates.md), the session after this one.) For the person who does not have an always-on Linux box and should never have to open a terminal. The systemd install (`deploy/`) and the Docker image stay exactly as they are — this is a third way to run the *same* `server/dist`, differing from the other two only in how three environment variables get set.

Nothing in `server/src` or `web/src` changes shape. The whole phase is a shell around a process that already exists, and most of the work is in the build pipeline rather than in code.

**Targets: macOS (Apple silicon) first, Windows x64 second.** One workspace, one `main.ts`, two electron-builder targets. macOS is where development happens and where every verification item can be run on the spot, so it is the platform the phase is judged on; the Windows build is produced in the same session and its runtime checks (tray, firewall prompt, close semantics) are walked through on a Windows machine when one is available — after the session, not blocking the next one.

## Why a shell, not a rewrite

The server already has the three properties a desktop app needs:

- **It finds its own files.** `server/src/index.ts` and `server/src/db/index.ts` walk up from `dist/` to `schema.sql` and `web/dist`. The Dockerfile keeps the repository's directory shape for this reason; the app bundle does the same.
- **It is configured entirely by environment.** `MTG_DATA_DIR`, `MTG_HOST`, `MTG_PORT` (`server/src/config.ts`) and `MTG_LOG_LEVEL` (read where the Fastify logger is built in `index.ts`). The shell sets them; the server never learns it is inside an app.
- **It shuts down cleanly on SIGTERM.** `index.ts`'s `close` handler stops the sync worker (10s ceiling), closes Fastify, closes the database. Quit is a signal and a wait.

Migrations run on open (`db/index.ts`), so an updated app over an old database is already handled. Scheduled backups (`porting/schedule.ts`) keep running because the data directory is the only thing they care about.

## Shape

A new `desktop/` workspace: Electron, `electron-builder`, a `main.ts` of a few hundred lines. No renderer code — the window loads `http://127.0.0.1:<port>/` and the existing web client renders as it does in a browser. `contextIsolation` on, `nodeIntegration` off; the page has no reason to touch Node.

The server runs as a **separate child process**, not inside Electron's main process, and it runs on a **bundled official Node binary** — the `node` release matching `engines.node`, downloaded at package time and shipped in the app's resources — not on Electron's Node (`ELECTRON_RUN_AS_NODE`). This costs ~50 MB and buys the removal of the phase's biggest risk: `better-sqlite3`'s prebuilt binary for stock Node works as installed, so there is no `@electron/rebuild` step and no way for a rebuild to silently drop FTS5 or the trigram tokenizer. `check-sqlite.mjs` still runs against the packaged copy as a gate; it just has nothing to catch. Either way it is the unmodified `server/dist/index.js`. A crash in the server is a restart with a notice, not a dead window; a stuck quit is a killed child, not a hung app.

### Environment the shell sets

| Variable | Value | Why |
| --- | --- | --- |
| `MTG_DATA_DIR` | `<app.getPath('userData')>/library` | Per-platform application-support directory (`~/Library/Application Support/MTG Library/library` on macOS). The server's own default is `~/.local/share/mtg-library`, a Linux convention. An `MTG_DATA_DIR` already in the app's environment wins, so a developer can point the app at an existing library. |
| `MTG_HOST` | `127.0.0.1`, or `0.0.0.0` while *Allow other devices on this network* is on | The server's default of `0.0.0.0` is right behind Tailscale and wrong on a laptop on café wifi: an unauthenticated app on every interface. Off by default; Phase 33 builds pairing on top of the on state. |
| `MTG_PORT` | `8080` if free, else the next free port, **persisted** in the shell's own config | A stable port keeps phone bookmarks and Phase 33 pairing valid across launches. The port is the shell's to remember, not the server's. |
| `MTG_LOG_LEVEL` | `info` | Server stdout/stderr go to `<userData>/logs/server.log`, rotated. *Help → Show logs* opens the folder. |

### Lifecycle

- **Launch.** Single-instance lock (a second launch focuses the first). Spawn the server, then poll `GET /api/v1/health` until it answers; show a splash with the server's own boot messages until then. The first cold start includes `warmCache()` and any pending migrations, so this is seconds, not milliseconds, and the window must not load a connection-refused page in the meantime.
- **This is a background app with a window.** The point of it is to be up whenever the machine is up, so the phone can sync without anyone opening anything. It follows the Dropbox/Discord pattern on every platform: **closing the window hides it** (Dock or tray icon reopens it, server keeps running); **Quit is only ever explicit** — ⌘Q, or *Quit* in the tray menu — and is what stops the server. One rule, same on macOS, Windows and Linux; no cleverness about when close means quit.
- **Launch at login, on by default.** `app.setLoginItemSettings`; a checkbox in the tray menu turns it off. Without this the design leans on the user remembering to open an app, which is the thing it exists to remove.
- **Say so once.** First launch shows a single notice: *MTG Library runs in the background — find it in the menu bar / system tray. Quit from there to stop it.* Otherwise a Windows user "closes" it and believes it is off.
- **Quit.** SIGTERM to the child, a *Finishing up…* indicator if it takes more than a second (a bulk sync mid-write can take up to the server's 10s ceiling), then exit. Never `SIGKILL` first; the database is in WAL mode and an unclean exit is survivable but pointless.
- **Sleep is the real outage, and the app is honest about it.** A desktop PC that sleeps after thirty idle minutes is down most of the day; a laptop with the lid closed is down regardless. A setting — *Keep this computer awake while sharing is on*, off by default, one sentence on the power trade — holds an Electron `powerSaveBlocker` (`prevent-app-suspension`) while sharing is on. Right for a desktop tower, wrong to force on a laptop, so it is a choice. Phase 36's snapshot-and-queue design is what makes sleep survivable rather than fatal: the phone syncs the next time both are awake.

### Menu / tray

*Open MTG Library* · *Allow other devices on this network* (checkbox; restarts the child with the new `MTG_HOST`) · *Keep this computer awake while sharing* (checkbox) · *Launch at login* (checkbox, on by default) · *Pair a phone…* (Phase 33; hidden until then) · *Show data folder* · *Show logs* · *Check for updates* (Phase 34 wires it; present but inert until then) · *Quit*.

`Show data folder` matters more than it looks: it is the backup story for someone who will never read `README.md#backups`. The folder holds `library.sqlite`, the image cache, and the scheduled backups.

## Build pipeline

This is where the phase's actual risk lives.

- **Native module ABI.** Avoided by the bundled-Node decision above. If that is ever reversed (to save the 50 MB), `better-sqlite3` must be rebuilt for Electron's ABI with `@electron/rebuild`, and `server/scripts/check-sqlite.mjs` must run **against the packaged app's copy** after every rebuild — FTS5 and the trigram tokenizer are what a rebuild silently loses. Keep the gate in the release workflow regardless; it is cheap.
- **Archive layout.** Electron packs the app into an `.asar`; native `.node` binaries and `new Worker(path)` (`sync/syncManager.ts`) cannot load from inside one. `server/**`, `schema.sql`, and `node_modules/better-sqlite3/**` go in `asarUnpack` — or asar is disabled outright; either is fine as long as the walk-up from `server/dist` still lands on `schema.sql` and `web/dist`.
- **Which `node_modules`.** The root workspace hoists the server's runtime dependencies (`fastify`, `@fastify/static`, `better-sqlite3`) into the root `node_modules`; `desktop/`'s own `node_modules` holds Electron and the builder and nothing the server needs. So the packaged resources are assembled by a **staging step**, not taken from `desktop/`'s dependency tree. Mirror the Dockerfile's runtime stage: after `npm run build` at the root, produce a production-only root `node_modules` (a fresh `npm ci --omit=dev` into `desktop/staging/`, or a copy after `npm prune --omit=dev`), then `package.json`, `schema.sql`, `server/package.json`, `server/dist`, `web/dist`, and `server/scripts/check-sqlite.mjs` for the gate. Remove the `node_modules/@mtg-library/*` workspace symlinks first — electron-builder follows symlinks, and left in place they package `server/` and `web/` a second time, sources and dev output included. Ship the staging directory as `extraResources`; never point `files` at the workspace.
- **The worker's dev-run heuristic.** `syncManager.ts` loads `syncWorker.ts` instead of `.js` when its own directory path contains the substring `src`. The packaged path (`Contents/Resources/server/dist/sync`, `resources\server\dist\sync`) does not, but a user-chosen install directory could. Make it a path-segment test in this session — a one-line hardening in the server, the only server edit this phase makes.
- **Updates, signing and notarisation are Phase 34.** This phase produces unsigned installers that work on the machine that built them and on a Windows machine past a SmartScreen click; a downloaded Mac build needs `xattr -d com.apple.quarantine` until Phase 34. The app is not finished for anyone else until Phase 34 is — the split is about sessions, not about whether it ships.
- **Building the Windows installer on a Mac.** electron-builder fetches its own tools on macOS on first run; no Wine, no Windows machine. The release workflow (Phase 34) still builds Windows on `windows-latest`, so the in-session build only has to prove the layout.
- **Size.** ~150–250 MB. Say so on the download page.
- **macOS is Apple silicon only.** No Intel or universal build; an Intel Mac runs the self-hosted install. Decided, so a future session does not add the second Node binary out of thoroughness.

## What this phase does not change

- The server's defaults. `config.ts` keeps `0.0.0.0` and `~/.local/share/mtg-library`; the shell overrides them because it knows its context. Systemd and Docker are unaffected.
- The web client. No Electron-specific branches in `web/src`.
- The one-database rule. Someone with both a home server and the desktop app has two libraries that never reconcile. The README should say plainly: the desktop app is for people *without* a home server; it is either/or.

## Verification

**Results at build time (macOS, 2026-09-16):** 1 — the `.dmg` installed to `~/Applications`, launched from Finder (launchd's `PATH`, no `/usr/local/bin`), created `~/Library/Application Support/MTG Library/library`, offered the sync, imported 38,802 cards / 118,035 printings in ~55 s on the bundled Node, and answered searches (fuzzy name and Scryfall syntax). The second-user-account run is Dave's. 2 — `check-packaged.mjs` runs it on the packaged Node against the packaged binary: FTS5, trigram, schema load, user_version 21; part of `desktop:package`. 3 — Quit at "Imported 2,000 cards…" (a forced re-sync): app gone in 783 ms, server exit code 0; relaunch on the same port, `PRAGMA integrity_check` ok, data from the first sync intact, a further sync completed. 4 / 4a / 5 / 6 — `verify-lifecycle.mjs --app` on the installed app: all 26 checks, including the login item registered on first launch and removed by the toggle (`sfltool dumpbtm` agrees), the `NoIdleSleepAssertion` in `pmset -g assertions` only while both toggles are on, the LAN address refused then answering across the sharing restart, and port 8082 chosen (8080 and 8081 were held) then reused. A `SIGKILL` of the server child showed the status page and had the web client back in 2.9 s.

**Windows (checkpoint 2b — to walk on a Windows machine or VM; does not block Phase 33):** the installer builds on the Mac and its layout passes the gate. What to check, and what each should show:

1. Run `MTG Library-1.0.0-win-x64-setup.exe`. SmartScreen: *More info → Run anyway*. The installer offers a directory; keep the default (`%LocalAppData%\Programs\MTG Library`) and let it launch at the end.
2. The window opens on the "Starting MTG Library…" page, then the web client. A single dialog: *MTG Library runs in the background — find it in the system tray.* `%AppData%\MTG Library\desktop-config.json` exists with `"port": 8080` (or the next free one) and `launchAtLogin: true`; `%AppData%\MTG Library\logs\server.log` shows `Server listening`.
3. The first-run sync dialog appears; run it with the default. A minute later, search works.
4. Close the window (the ×). The tray icon (bottom right; may be in the overflow ▲) stays; `http://127.0.0.1:<port>/api/v1/health` in a browser still answers. Click the tray icon: the window returns. Right-click it: the menu with the three checkboxes, *Show data folder*, *Show logs*, *Quit MTG Library*.
5. Tray → *Allow other devices on this network*: **first** the firewall paragraph dialog with *Turn on sharing*; **then** Windows Defender Firewall's own prompt for `node.exe` — allow it on private networks. From a phone on the same wifi, `http://<PC's IPv4>:<port>/` loads the app. Untick it: the phone gets connection refused. (If the firewall prompt was dismissed, sharing looks on and nothing answers — that is the case *Show logs* is for.)
6. *Keep this computer awake while sharing* with sharing on: `powercfg /requests` in an admin prompt lists `MTG Library.exe` under SYSTEM. Off, or sharing off: it does not.
7. *Launch at login* is ticked. Task Manager → Startup apps lists MTG Library, enabled. Untick: it goes. Re-tick: it is back. Sign out and in: the app starts with **no window** (the `--hidden` argument the login entry carries) and the tray icon present; health answers.
8. Tray → *Quit*. Both `MTG Library.exe` and `node.exe` leave Task Manager within a second or two; the log's last lines are `server exited (code 0, signal null)` then `quit` — code 0 is the stdin-close path working (there is no SIGTERM on Windows).
9. Quit during a sync (Data → re-sync, then Quit while importing): exits within ~10 s, code 0; relaunch, the library is intact and a sync runs again.
10. Start a second copy from the Start menu while one is running: the running one's window comes forward; no second tray icon.
11. Occupy 8080 first (any local server), launch: the config shows another port, the window works, and the next launch reuses that port with 8080 free again.

1. A fresh install on a machine with no Node, no repo, and no prior data directory launches, offers the first sync, completes it, and searches — without a terminal.
2. `check-sqlite.mjs` run against the packaged app's `better-sqlite3` reports FTS5, trigram, and a clean schema load. Automated in the release workflow.
3. Quitting during a bulk sync exits cleanly within the server's ceiling; relaunching finds the database intact and the sync resumable (re-runnable).
4. Closing the window on every platform leaves the server answering `/api/v1/health` and the tray/Dock icon reopens it; Quit from the tray (or ⌘Q) stops it. A fresh install is registered as a login item; unchecking *Launch at login* removes it.
4a. With *Keep this computer awake while sharing* on and sharing on, the system's idle-sleep timer does not fire; with either off, it does.
5. With *Allow other devices on this network* off, `curl http://<LAN IP>:8080/api/v1/health` from another machine is refused; on, it answers.
6. Launching with port 8080 occupied picks another port, persists it, loads the window correctly, and reuses that port on the next launch.

Migration-over-old-data, Gatekeeper on a second Mac, and the update path are Phase 34's verification.

## Out of scope

- Moving or choosing the data directory from the UI. `MTG_DATA_DIR` in the environment covers the developer case.
- Any remote access. Phase 33 covers the home network; nothing here or there reaches outside it.
- Running the server on Electron's own Node to save the bundled binary's ~50 MB. Possible later, at the cost of the ABI rebuild and its gate.

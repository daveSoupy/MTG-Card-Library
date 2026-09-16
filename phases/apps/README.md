# App phases — running it and reaching it without a terminal

The phases that turn the server into something people install: a desktop app at home, and a way for every other device in the house to reach it from a browser. Everything in here is a shell, a transport, or an install flow around the unmodified `server/dist`; none of it moves a rule off the server.

## The design in one paragraph

The desktop app runs the server at home. Every other device — a phone, a tablet, a second laptop — reaches it in a browser, and the phone pins it to the home screen so it opens like an app. One QR code on the desktop is how a device finds it the first time; if the desktop's address ever changes, scanning again is the fix. Nothing outside the house is in the path — no VPN, no account, no tunnel, no port forwarding — because each of those is something the user cannot fix when it changes. Live access from away is not built; `deploy/README.md`'s "bring your own Tailscale" remains for anyone who wants it. There is no phone *app*: one client codebase, served from the server, is what keeps this cheap to build and free to update.

## Starting to build

`BUILD-BRIEF.md` is the plan: the desktop app for Windows and macOS, pairing and the QR code, the home-screen install, then signing and updates — with a copy-pasteable prompt for each session. Start there rather than at a phase doc. The targets are Windows and macOS for the desktop app, and any phone with a browser for everything else. The UI is the React client everywhere.

## Reading order

Numbered in build order — the number is the sequence. One phase per session.

| Phase | What | Depends on |
| --- | --- | --- |
| [31 — Desktop App](phase-31-desktop-app.md) | Electron shell around `server/dist`, tray lifecycle, bundled Node. LAN sharing off by default. Unsigned. | nothing |
| [32 — Pairing and LAN Discovery](phase-32-pairing-and-lan-discovery.md) | Instance id, mDNS advertisement, one QR code. The QR opens the web app in the phone's browser. | nothing (31 gives it a menu item) |
| [33 — Home-Screen Install and Reconnect](phase-33-pwa-install-flow.md) | Manifest and icons so the web app pins to a home screen; a network-first shell cache and a reconnect banner so "can't reach your library" is the app's own screen, names the fix (VPN on / home wifi), and recovers by itself. What the QR lands on. | 32 for the QR panel line |
| [34 — Signing and Updates](phase-34-signing-and-updates.md) | Developer ID + notarisation, Windows signing if a cert exists, `electron-updater` against GitHub Releases, the release workflow. What makes 31 downloadable by someone else. | 31 |

31 and 32 are unsequenced with respect to each other; 33 follows 32 and 34 follows 31. In practice: 31, 32, 33, 34.

### Parked — the companion phone app (35–37)

Specced, decided against for now, kept because the specs are sound and the trigger for un-parking is concrete: **someone wants to record a trade at a card shop, away from home, and can't.** That is the one thing a browser cannot do — the server is only reachable at home, and the web client holds nothing offline by design. Everything else the app offered (automatic re-discovery after an IP change, background sync, native OCR) is convenience over a QR rescan, and a sideloaded APK or a TestFlight build is a harder install than *Add to Home Screen*.

| Phase | What | Depends on |
| --- | --- | --- |
| [35 — Sync Contract](phase-35-sync-contract.md) | Server side only: `GET /api/v1/snapshot`, `idempotency_keys`, `POST /api/v1/trades/record`, the `replay_failed` alert. Testable with `app.inject`, no phone. The first thing to build if the app is wanted. | 32 |
| [36 — Companion App](phase-36-native-companion-app.md) | The umbrella: Capacitor over `web/`; home mode and shop mode; the snapshot, the idempotent queue, native OCR and background sync. Its Android home-mode session prompt is in the brief's appendix. | 35; 13 for sale recording; 16 for OCR |
| [37 — Cloud Mailbox](phase-37-cloud-mailbox.md) | A folder in the user's cloud storage as a second transport for the app. Never the only one. | 36 |

If un-parked, build in number order. Phase 32's "Phone: discovery order" section is the contract the app would implement; it stays in that doc for that reason.

**Old numbers.** This track was first numbered 19, 20, 20a, 28, 28b, 29, 30 — the order it was thought of in, not the order it is built in. Renumbered 2026-09-15: 28→31, 29→32, 19→33, 28b→34, 20a→35, 20→36, 30→37. Git history before that date uses the old numbers.

## What these phases must not do

- Add a client-side rule. The phone is the web client byte-for-byte, served from the server.
- Add a second writer, or cache any data. CLAUDE.md's no-offline rule holds in full while the companion app is parked; the carve-out it describes is Phase 36's and comes back only with it. Phase 33's service worker caches the static bundle so the app can show its own reconnect screen — the shell, never `/api/*`; that is the whole of what the browser holds.
- Reach outside the home network by default. Considered in depth and rejected: embedded Tailscale, embedded WireGuard with UPnP, tunnels, relays. Each moves a failure the user cannot repair into the default path.
- Change the server's defaults. `config.ts` stays as it is; the desktop shell overrides by environment because it knows its context, and systemd and Docker are untouched.
- Put a certificate on the LAN. The phone reaches the desktop over plain `http://` on the home network; Phase 33 accepts the degraded Android install for it, because a certificate a layperson's phone trusts is not something the desktop app can hand out without a step they will not do.

# App phases — running it and reaching it without a terminal

The phases that turn the server into things people install: a desktop app at home, a phone app that works at the shop, and the way the two find each other. Everything in here is a shell, a transport, or an install flow around the unmodified `server/dist`; none of it moves a rule off the server.

## The design in one paragraph

The desktop app runs the server at home. The phone app is the web client at home and a snapshot-plus-queue "shop mode" away, syncing whenever it is back on the home wifi. Nothing outside the house is in the path — no VPN, no account, no tunnel, no port forwarding — because each of those is something the user cannot fix when it changes. Live access from away is not built; `deploy/README.md`'s "bring your own Tailscale" remains for anyone who wants it. A cloud folder can optionally carry the same two streams for a household where the devices are never home at the same time.

## Starting to build

`BUILD-BRIEF.md` is the viability cut: three sessions — the desktop app for Windows and macOS, pairing, the Android app in home mode — with the scope trimmed to what is needed to judge the idea and copy-pasteable prompts for each. Start there rather than at a phase doc. The targets are Windows, macOS and Android; the UI is the React client on every platform, and the only Apple-specific item is notarisation, deferred with Windows signing.

## Reading order

| Phase | What | Depends on |
| --- | --- | --- |
| [28 — Desktop App](phase-28-desktop-app.md) | Electron shell, tray lifecycle, auto-update, signed builds. LAN sharing off by default. | nothing |
| [29 — Pairing and LAN Discovery](phase-29-pairing-and-lan-discovery.md) | Instance id, mDNS advertisement, one QR code. | nothing (28 gives it a menu item) |
| [19 — PWA Install Flow](phase-19-pwa-install-flow.md) | Manifest and icons so the web app installs to a home screen. What the QR opens on a phone with no app. | nothing |
| [20 — Companion App](phase-20-native-companion-app.md) | Capacitor over `web/`; home mode and shop mode; the snapshot, the idempotent queue, native OCR and background sync. | 29; 13 for sale recording; 16 for OCR |
| [30 — Cloud Mailbox](phase-30-cloud-mailbox.md) (optional) | A folder in the user's cloud storage as a second transport. Never the only one. | 20, 28, 29 |

28 and 29 are unsequenced with respect to each other and to the rest of the project. 19 can be built any time. 20 is the big one. 30 only if someone hits the gap it closes.

## What these phases must not do

- Add a client-side rule. Home mode is the web client byte-for-byte; shop mode adjusts counts from a queue and applies no allocation, legality or basic-land logic.
- Add a second writer. The phone's queue is inserts with idempotency keys; the snapshot is never edited on the phone; the mailbox is immutable files. CLAUDE.md's no-offline rule has exactly the carve-out Phase 20 describes and no other.
- Reach outside the home network by default. Considered in depth and rejected: embedded Tailscale, embedded WireGuard with UPnP, tunnels, relays. Each moves a failure the user cannot repair into the default path.
- Change the server's defaults. `config.ts` stays as it is; the desktop shell overrides by environment because it knows its context, and systemd and Docker are untouched.

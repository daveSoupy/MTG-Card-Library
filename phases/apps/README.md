# App phases — running it and reaching it without a terminal

The phases that turn the server into something people install: a desktop app at home, and a way for every other device in the house to reach it from a browser. Everything in here is a shell, a transport, or an install flow around the unmodified `server/dist`; none of it moves a rule off the server.

## The design in one paragraph

The desktop app runs the server at home. Every other device — a phone, a tablet, a second laptop — reaches it in a browser, and the phone pins it to the home screen so it opens like an app. One QR code on the desktop is how a device finds it the first time; if the desktop's address ever changes, scanning again is the fix. Nothing outside the house is in the path — no VPN, no account, no tunnel, no port forwarding — because each of those is something the user cannot fix when it changes. Live access from away is not built; `deploy/README.md`'s "bring your own Tailscale" remains for anyone who wants it. There is no phone *app*: one client codebase, served from the server, is what keeps this cheap to build and free to update.

## Starting to build

`BUILD-BRIEF.md` is the plan: the desktop app for Windows and macOS, pairing and the QR code, the home-screen install, then signing and updates — with a copy-pasteable prompt for each session. Start there rather than at a phase doc. The targets are Windows and macOS for the desktop app, and any phone with a browser for everything else. The UI is the React client everywhere.

## Reading order

| Phase | What | Depends on |
| --- | --- | --- |
| [28 — Desktop App](phase-28-desktop-app.md) | Electron shell, tray lifecycle, auto-update, signed builds. LAN sharing off by default. Built in two sessions: the app, then signing and updates. | nothing |
| [29 — Pairing and LAN Discovery](phase-29-pairing-and-lan-discovery.md) | Instance id, mDNS advertisement, one QR code. The QR opens the web app in the phone's browser. | nothing (28 gives it a menu item) |
| [19 — PWA Install Flow](phase-19-pwa-install-flow.md) | Manifest and icons so the web app pins to a home screen with its own icon and no browser chrome. What the QR lands on. | nothing |

28 and 29 are unsequenced with respect to each other and to the rest of the project. 19 can be built any time, but it is what makes the QR's landing feel like an app, so it belongs right after 29.

### Parked — the companion phone app

Specced, decided against for now, kept because the specs are sound and the trigger for un-parking is concrete: **someone wants to record a trade at a card shop, away from home, and can't.** That is the one thing a browser cannot do — the server is only reachable at home, and the web client holds nothing offline by design. Everything else the app offered (automatic re-discovery after an IP change, background sync, native OCR) is convenience over a QR rescan, and a sideloaded APK or a TestFlight build is a harder install than *Add to Home Screen*.

| Phase | What | Depends on |
| --- | --- | --- |
| [20 — Companion App](phase-20-native-companion-app.md) | The umbrella: Capacitor over `web/`; home mode and shop mode; the snapshot, the idempotent queue, native OCR and background sync. | 29; 13 for sale recording; 16 for OCR |
| [20a — Sync Contract](phase-20a-sync-contract.md) | Server side only: `GET /api/v1/snapshot`, `idempotency_keys`, `POST /api/v1/trades/record`, the `replay_failed` alert. Testable with `app.inject`, no phone. Buildable on its own the day the app is wanted. | 29 |
| [30 — Cloud Mailbox](phase-30-cloud-mailbox.md) | A folder in the user's cloud storage as a second transport for the app. Never the only one. | 20, 28, 29 |

If the app is ever un-parked: 20a first (it is pure server work), then the Android home-mode session whose prompt is in the brief's appendix, then shop mode. Phase 29's "Phone: discovery order" section is the contract the app would implement; it stays in that doc for that reason.

## What these phases must not do

- Add a client-side rule. The phone is the web client byte-for-byte, served from the server.
- Add a second writer, or an offline cache. CLAUDE.md's no-offline rule holds in full while the companion app is parked; the carve-out it describes is Phase 20's and comes back only with it.
- Reach outside the home network by default. Considered in depth and rejected: embedded Tailscale, embedded WireGuard with UPnP, tunnels, relays. Each moves a failure the user cannot repair into the default path.
- Change the server's defaults. `config.ts` stays as it is; the desktop shell overrides by environment because it knows its context, and systemd and Docker are untouched.
- Put a certificate on the LAN. The phone reaches the desktop over plain `http://` on the home network; Phase 19 accepts the degraded Android install for it, because a certificate a layperson's phone trusts is not something the desktop app can hand out without a step they will not do.

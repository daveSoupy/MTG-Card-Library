# Phase 34 — Signing, Notarisation and Auto-Update

What turns the Phase 31 build from "works on my Mac" into something a friend can download and open. Split out of Phase 31 because it is its own session: credential-dependent, fiddly in ways that have nothing to do with the shell's code, and the one part of the desktop app that decides whether a layperson can use it at all. Nothing in `server/src`, `web/src` or the shell's lifecycle changes; this phase is the build pipeline and the release workflow.

**Prerequisite:** Phase 31 built and its verification items 1–6 passing on both platforms.

## Why this is not optional

- **macOS Gatekeeper is a dead end, not a warning.** An unsigned `.app` downloaded from the internet says *"is damaged and can't be opened."* The workaround is a terminal command (`xattr -d com.apple.quarantine`), which is the thing the app exists to avoid. Your own build on your own Mac never hits this; a build someone else downloads always does.
- **Windows SmartScreen is a warning, not a dead end.** An unsigned installer shows *"Windows protected your PC"* with *More info → Run anyway* behind it. A signed installer from a new certificate still shows it until the certificate accrues reputation; an EV certificate skips it. Unsigned Windows is shippable with a sentence in the README; unsigned macOS is not.
- **Without auto-update, every server fix needs every user to find the download page again.** The systemd and Docker installs pull; the desktop app has to bring the update to the user.

## macOS

- **Identity.** A *Developer ID Application* certificate in the login keychain — the kind for distribution outside the App Store. *Mac App Distribution* / *Apple Distribution* certificates are App Store-only and produce a build that notarisation rejects with an unhelpful error; this is the most common first-run failure.
- **Hardened runtime and entitlements.** Required for notarisation. The bundled Node binary is re-signed with *our* identity and *our* entitlements, so it needs what Node needs: `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory` at minimum (V8 JITs). Confirm the packaged app runs under the hardened runtime *before* submitting for notarisation — a JIT crash on launch is a five-second local test and a twenty-minute notarisation round-trip.
- **Notarisation.** electron-builder's `notarize` option, driven by `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` from the environment — never from a file in the repo. The app-specific password is made at appleid.apple.com; the real Apple ID password never enters a build environment. Staple the ticket so the app opens offline on first launch.
- **Verify** with `spctl --assess --type execute -v` on the `.app`, `stapler validate` on the `.dmg`, and — the only test that counts — downloading the `.dmg` in a browser on a second Mac and opening it.
- **Apple silicon only**, as Phase 31 decided. One `.dmg`.

## Windows

- **Sign if a certificate is present, build unsigned if not, and say which in the workflow output.** The certificate is a separate purchase from a separate vendor and undecided; the workflow must not fail for its absence. electron-builder reads `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` (or a `certificateSubjectName` for a store-installed cert); when neither is set it builds unsigned.
- **README says what SmartScreen shows** for the unsigned case and how to get past it, in two sentences, so the friend who hits it has something to read.

## Auto-update

- **`electron-updater` against GitHub Releases.** Check on launch and once a day. Download in the background. A *Restart to update* item appears in the tray when one is ready; the update applies on the next quit. **Never a prompt mid-session** — a dialog over the deck builder is the wrong thing at any moment.
- **The shell does no migration.** A new build over an old data directory is the server's `migrations.ts` running on next open, exactly as it does for systemd and Docker. Verification item 1 below proves the packaging did not break the path to it.
- **`Check for updates` in the tray** (Phase 31 listed it; this phase wires it) runs the check now and reports *up to date* or *downloading*.
- The updater needs the release to carry electron-builder's `latest-mac.yml` and `latest.yml` beside the installers; the workflow uploads them.

## The release workflow

`.github/workflows/desktop.yml`, on a `v*` tag — the same tag that already triggers `docker.yml`, so one `git tag` produces the Docker image, the `.dmg` and the Windows installer as one GitHub Release. `docker.yml` is not touched.

- `macos-latest` builds and notarises the arm64 `.dmg`; `windows-latest` builds the x64 NSIS installer. Both run `npm ci && npm run build` at the root first so the packaged `server/dist` and `web/dist` are the tag's.
- **`server/scripts/check-sqlite.mjs` runs against each packaged app's Node and `better-sqlite3`** as a gate, and fails the job if FTS5 or the trigram tokenizer is missing. The bundled-Node decision means this has nothing to catch; it stays because it is cheap and because the day someone reverses that decision is the day it matters.
- Uploads: both installers, both `latest*.yml`, and a `SHA256SUMS`.
- Secrets: the four Apple values above, the optional Windows pair. The workflow documents each in a comment at the top.

## README

A *Desktop app* section: the download links (the Releases page), that it updates itself, the size (~150–250 MB, most of it the card database's runtime and a Node binary), the either/or with a home server (someone with both has two libraries that never reconcile; the desktop app is for people *without* a server), and the SmartScreen note.

## Verification

1. Installing a newer build over an older data directory runs the migration and opens; `migrations.test.ts` already proves the DDL, this proves the packaging did not break the path to it.
2. The macOS build opens on a second Mac straight from a browser-downloaded `.dmg` with no Gatekeeper override; `spctl --assess` accepts it; `stapler validate` passes.
3. The packaged app runs under the hardened runtime: a full sync completes and search works, on a build produced by the workflow, not a local one.
4. A tagged release produces both installers and both `latest*.yml` files on the GitHub Release, and `check-sqlite.mjs` passed in both jobs' logs.
5. An installed older build detects the new release within a day (or on *Check for updates*), shows *Restart to update*, and after quit reopens on the new version with the data directory intact.
6. With no Windows certificate configured, the Windows job succeeds, the log says the build is unsigned, and the README's SmartScreen note matches what the installer shows.

## Out of scope

- Intel Macs, Linux packaging. Decided in Phase 31.
- The Mac App Store or Microsoft Store. Direct download is the path; a store listing is a different set of rules and a different sandbox.
- Delta updates. Full-installer updates at ~200 MB are fine for a daily check that downloads in the background.

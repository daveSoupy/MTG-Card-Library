# Phase 34 — Signing, Notarisation and Auto-Update

> **Shipped 2026-09-16.** Built and verified on a locally signed build (Developer ID, hardened runtime, `spctl`-less because not notarised locally); the notarised, published release is what the first `v*` tag produces. Where the build differed from this doc, the paragraph says so under *At build time*. The rules that came out of it are in `desktop/CLAUDE.md`.

What turns the Phase 32 build from "works on my Mac" into something a friend can download and open. Split out of Phase 32 because it is its own session: credential-dependent, fiddly in ways that have nothing to do with the shell's code, and the one part of the desktop app that decides whether a layperson can use it at all. Nothing in `server/src`, `web/src` or the shell's lifecycle changes; this phase is the build pipeline and the release workflow.

**Prerequisite:** Phase 32 built and its verification items 1–6 passing on both platforms.

## Why this is not optional

- **macOS Gatekeeper is a dead end, not a warning.** An unsigned `.app` downloaded from the internet says *"is damaged and can't be opened."* The workaround is a terminal command (`xattr -d com.apple.quarantine`), which is the thing the app exists to avoid. Your own build on your own Mac never hits this; a build someone else downloads always does.
- **Windows SmartScreen is a warning, not a dead end.** An unsigned installer shows *"Windows protected your PC"* with *More info → Run anyway* behind it. A signed installer from a new certificate still shows it until the certificate accrues reputation; an EV certificate skips it. Unsigned Windows is shippable with a sentence in the README; unsigned macOS is not.
- **Without auto-update, every server fix needs every user to find the download page again.** The systemd and Docker installs pull; the desktop app has to bring the update to the user.

## macOS

- **Identity.** A *Developer ID Application* certificate in the login keychain — the kind for distribution outside the App Store. *Mac App Distribution* / *Apple Distribution* certificates are App Store-only and produce a build that notarisation rejects with an unhelpful error; this is the most common first-run failure. The keychain covers a local build only: a `macos-latest` runner has no keychain, so the certificate travels to CI as `CSC_LINK` (the `.p12` exported from Keychain Access, base64-encoded) and `CSC_KEY_PASSWORD`, and electron-builder imports it into a temporary keychain for the job.
- **electron-builder's option layout.** Since v27 every macOS signing option — `hardenedRuntime`, `entitlements`, `entitlementsInherit`, `binaries`, `identity` — lives under `mac.sign`; `notarize` stays on `mac`. Older examples use the flat keys and `electron-builder migrate-schema` rewrites them.
  *At build time:* no v27 existed on npm (26.15.3 was latest), and in 26 `mac.sign` is a custom sign *function*. The flat keys are what shipped; the yml's header says so, for whoever upgrades.
- **Hardened runtime and entitlements.** Required for notarisation. The bundled Node binary is re-signed with *our* identity and *our* entitlements, so it needs what Node needs: `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory` at minimum (V8 JITs). Confirm the packaged app runs under the hardened runtime *before* submitting for notarisation — a JIT crash on launch is a five-second local test and a twenty-minute notarisation round-trip.
- **Every Mach-O in the bundle must be signed, and the signer does not walk `Resources/` on its own.** electron-builder signs the Electron frameworks, helpers and unpacked `.node` files; a bare `node` executable shipped as an extra resource is exactly the "binary is not signed with a valid Developer ID certificate" notarisation rejection. List it under `mac.sign.binaries` (or sign it in an `afterSign` hook) so it carries our identity and the entitlements above.
  *At build time:* the opposite problem. `@electron/osx-sign` **does** walk `Resources/` and signs every file whose content looks binary — the web client's PNG icons, a `.jpg` and a `.zip` in some package's test fixtures. codesign stores a non-Mach-O file's signature as an extended attribute, and the outer bundle then refuses to seal `Resources/` over it (*"resource fork, Finder information, or similar detritus not allowed"*). `mac.signIgnore` now spares everything under `Resources/mtg-library/` except `.node`; `binaries` still lists the bare `node` so the intent is explicit. A second finding of the same kind: build output inside an iCloud-synced folder cannot be signed — the File Provider re-stamps every `.app` with `com.apple.FinderInfo` within seconds of it being cleared — so `package.mjs` symlinks `out/` to `~/Library/Caches` when it detects one. Neither would show on a CI runner; both showed here.
- **Notarisation.** electron-builder's `notarize: true`, driven by `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` from the environment — never from a file in the repo. The app-specific password is made at appleid.apple.com; the real Apple ID password never enters a build environment. electron-builder staples the ticket itself when `notarize` is on, so the app opens offline on first launch; `stapler validate` is how to check it did.
- **Verify** with `spctl --assess --type execute -v` on the `.app`, `stapler validate` on the `.dmg`, and — the only test that counts — downloading the `.dmg` in a browser on a second Mac and opening it.
  *At build time:* `check-packaged.mjs --require-notarized` runs `spctl` and `stapler validate` on the `.app` (electron-builder staples the app, then builds the `.dmg` from it; the `.dmg` itself is not stapled and Gatekeeper does not need it to be — the ticket travels inside the bundle). The workflow runs both; locally, with no `APPLE_*` in the environment, the build is signed but not notarised and only the signature checks run.
- **Apple silicon only**, as Phase 32 decided. One `.dmg` for people, and one `.zip` for the updater — see *Auto-update*.

## Windows

- **Sign if a certificate is present, build unsigned if not, and say which in the workflow output.** The certificate is a separate purchase from a separate vendor and undecided; the workflow must not fail for its absence. electron-builder reads `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` (or a `certificateSubjectName` for a store-installed cert); when neither is set it builds unsigned.
- **README says what SmartScreen shows** for the unsigned case and how to get past it, in two sentences, so the friend who hits it has something to read.

## Auto-update

- **`electron-updater` against GitHub Releases.** Check on launch and once a day. Download in the background. A *Restart to update* item appears in the tray when one is ready; the update applies on the next quit. **Never a prompt mid-session** — a dialog over the deck builder is the wrong thing at any moment.
  *At build time:* "applies on the next quit" needed one change to the shell — `shutdown()` now ends in `app.quit()` rather than `app.exit(0)`. electron-updater's install-on-quit is a listener on Electron's `quit` event, which `app.exit()` skips; on macOS Squirrel's ShipIt would have swapped the bundle after the process exited regardless, but Windows would never have installed. The one dialog the updater shows is the answer to *Check for updates…* — the user clicked it.
- **Why this could not be Phase 32.** electron-updater refuses to update an unsigned app on macOS, so the updater only works once signing does.
- **The macOS updater downloads a `.zip`, not the `.dmg`.** `latest-mac.yml` cannot be generated without one. Keep electron-builder's default `dmg` + `zip` targets and upload both; the `.dmg` is what a person downloads, the `.zip` is what the installed app fetches.
- **Publish config.** `publish: { provider: 'github', owner: 'daveSoupy', repo: 'MTG-Card-Library' }`. The repository is public, so installed apps need no token to check for releases; the only token involved is the workflow's own `GITHUB_TOKEN` (passed as `GH_TOKEN`), which lets electron-builder create the release and upload to it.
  *At build time:* electron-builder's own publisher is not used. It uploads *before* the gates run, and a build whose gate fails must not be on the release page. The workflow builds with `--publish never` (the `latest*.yml` files are written regardless when `publish` is configured), runs the gates, and uploads with `gh` into a draft release that a final job publishes once both platforms have passed. Artifact names lost their space (`MTG-Library-…`): GitHub rewrites a space in an asset name to a dot and electron-updater to a hyphen.
- **The shell does no migration.** A new build over an old data directory is the server's `migrations.ts` running on next open, exactly as it does for systemd and Docker. Verification item 1 below proves the packaging did not break the path to it.
- **`Check for updates` in the tray** (Phase 32 listed it; this phase wires it) runs the check now and reports *up to date* or *downloading*.
- The updater needs the release to carry electron-builder's `latest-mac.yml` and `latest.yml` beside the installers; the workflow uploads them.

## The release workflow

`.github/workflows/desktop.yml`, on a `v*` tag — the same tag that already triggers `docker.yml`, so one `git tag` produces the Docker image, the `.dmg` and the Windows installer as one GitHub Release. `docker.yml` is not touched.

- `macos-latest` builds and notarises the arm64 `.dmg`; `windows-latest` builds the x64 NSIS installer. Both run `npm ci && npm run build` at the root first so the packaged `server/dist` and `web/dist` are the tag's.
  *At build time:* the Windows job is the first time `desktop/scripts/*.mjs` run on Windows at all (Phase 32 built the installer on a Mac). Every script resolved its own location with `new URL(...).pathname`, which is `/C:/…` on Windows; all now use `fileURLToPath`. A first job checks the tag against `desktop/package.json`'s version — that version is what the installed app compares against `latest*.yml` — and creates the draft release.
- **`server/scripts/check-sqlite.mjs` runs against each packaged app's Node and `better-sqlite3`** as a gate, and fails the job if FTS5 or the trigram tokenizer is missing. The bundled-Node decision means this has nothing to catch; it stays because it is cheap and because the day someone reverses that decision is the day it matters.
- Uploads: the `.dmg`, the macOS `.zip`, the Windows installer, both `latest*.yml`, and a `SHA256SUMS`.
- Secrets: five for macOS — `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — and the optional Windows pair `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`. `GITHUB_TOKEN` is provided by Actions. The workflow documents each in a comment at the top.

## README

A *Desktop app* section: the download links (the Releases page), that it updates itself, the size (~150–250 MB, most of it the card database's runtime and a Node binary), the either/or with a home server (someone with both has two libraries that never reconcile; the desktop app is for people *without* a server), and the SmartScreen note.

## Verification

*At build time:* 1 and 3 are covered on the locally signed build — `verify-lifecycle.mjs --app` launches it, the bundled Node comes up under the hardened runtime, serves the web client, answers a manual update check (an honest error until a release exists), and exits 0 through `app.quit()`; `check-sqlite.mjs` loads the schema on the packaged Node, which is the migration path. 2, 4 and 5 need the first tagged release and a second Mac; 6 needs the workflow's Windows job. The workflow itself runs `spctl` and `stapler` (2) and `check-sqlite.mjs` on both runners (4).

1. Installing a newer build over an older data directory runs the migration and opens; `migrations.test.ts` already proves the DDL, this proves the packaging did not break the path to it.
2. The macOS build opens on a second Mac straight from a browser-downloaded `.dmg` with no Gatekeeper override; `spctl --assess` accepts it; `stapler validate` passes.
3. The packaged app runs under the hardened runtime: a full sync completes and search works, on a build produced by the workflow, not a local one.
4. A tagged release produces both installers and both `latest*.yml` files on the GitHub Release, and `check-sqlite.mjs` passed in both jobs' logs.
5. An installed older build detects the new release within a day (or on *Check for updates*), shows *Restart to update*, and after quit reopens on the new version with the data directory intact.
6. With no Windows certificate configured, the Windows job succeeds, the log says the build is unsigned, and the README's SmartScreen note matches what the installer shows.

## Out of scope

- Intel Macs, Linux packaging. Decided in Phase 32.
- The Mac App Store or Microsoft Store. Direct download is the path; a store listing is a different set of rules and a different sandbox.
- Delta updates. Full-installer updates at ~200 MB are fine for a daily check that downloads in the background.

<!--
  The body of every desktop release, with VERSION substituted for the tag's
  version by the `release` job in workflows/desktop.yml. Edit it here, not on
  a release page: a re-run of the workflow leaves an existing release's notes
  alone, but the next tag takes whatever this file says.
-->

**Which file do I download?**

- **macOS, Apple silicon** (M1 and later) — `MTG-Library-VERSION-mac-arm64.dmg`. Signed and notarised, so it opens with no warning.
- **macOS, Intel** — `MTG-Library-VERSION-mac-x64.dmg`. Same, for a Mac with an Intel processor. Not sure which you have? Apple menu → **About This Mac**: a line reading *Chip* means take the first one, *Processor* means take this one.
- **Windows** (x64) — `MTG-Library-VERSION-win-x64-setup.exe`. Not signed yet, so SmartScreen shows *"Windows protected your PC"*: click **More info → Run anyway**.

Open it once and it sets itself up — there is nothing else to install. **The app updates itself** from here: it checks on launch and once a day, downloads in the background and applies the update the next time you quit. An installed app needs nothing from this page.

The rest of the files are machinery: `latest-mac.yml` and `latest.yml` are how an installed app spots a new version, the `.blockmap`s let it download only what changed instead of the whole 165 MB, the `.zip` is the Mac build in the form the updater fetches, and `SHA256SUMS` is there if you want to verify a download.

Running it on a server instead? The Docker image for this version is `ghcr.io/davesoupy/mtg-card-library:VERSION`.

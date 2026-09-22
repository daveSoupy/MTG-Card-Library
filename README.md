# MTG Library

A self-hosted Magic: The Gathering collection, deck and trade manager. Runs on a
machine at home; open it from your desktop to build decks and from your phone at
a card shop to record a trade. All your data lives in one SQLite file on your
own box.

> **Download the desktop app** (latest release, updates itself):
> [**macOS, Apple silicon**](https://github.com/daveSoupy/MTG-Card-Library/releases/latest/download/MTG-Library-1.0.7-mac-arm64.dmg) (signed and notarised) ·
> [**macOS, Intel**](https://github.com/daveSoupy/MTG-Card-Library/releases/latest/download/MTG-Library-1.0.7-mac-x64.dmg) ·
> [**Windows**](https://github.com/daveSoupy/MTG-Card-Library/releases/latest/download/MTG-Library-1.0.7-win-x64-setup.exe) (unsigned for now — click *More info → Run anyway*) ·
> [all releases](https://github.com/daveSoupy/MTG-Card-Library/releases).
> Prefer a server? See [Running it](#running-it).

- **Full card database** synced from [Scryfall](https://scryfall.com) bulk data,
  so search never touches the internet and works with Scryfall's syntax
  (`c:ur t:instant cmc<=2`, `o:"draw a card"`, plus `owned:`, `available:` and
  `loc:` filters against your own collection)
- **Deck builder** with format rules (Standard through Vintage, Pauper,
  Commander and its singleton/colour-identity rules, Pauper Commander, Duel
  Commander, PreDH), mana curve and mana-base analysis, templates, snapshots
  with undo/redo, and a decklist import/export that round-trips with Moxfield
  and Archidekt
- **Collection tracking** per printing, per condition, per physical location
  (binder, box, deck box), with market prices from Scryfall and optional manual
  overrides — so "what is this box worth?" has an answer
- **Allocation honesty** — a physical card can only be in one deck at a time.
  The app knows which decks are claiming which copies, how buildable each deck is
  from what you actually own, what it would cost to finish, and which decks are
  fighting over the same card
- **Pull sheets** for assembling a deck from your storage, grouped by where the
  cards are, and a disassembly flow that puts them back
- **Trades, want lists and trade lists** — completing a trade moves the cards in
  and out of your collection automatically
- **Game and draft log**, price-target alerts, scheduled backups, a phone layout
  for the parts you'd use standing up

It is a **single-user** app with **no login**: it is built to sit on your home
network (or a [Tailscale](https://tailscale.com) tailnet) and never be exposed
to the public internet. See [Security](#security-read-this) before you put it
anywhere else.

---

## Just want to run it?

You don't need to know anything about programming for this. Four steps, about
ten minutes, most of it waiting for downloads.

**1. Install Docker Desktop** from <https://www.docker.com/products/docker-desktop/>
and open it once so it finishes setting itself up. (Windows may ask to restart.
You can skip creating a Docker account — close that prompt.) It's the thing
that runs the app; you won't have to do anything else in it.

**2. Get the one file the app needs.** Make a new folder somewhere sensible —
say `mtg-library` in your Documents — and save
[this file](https://raw.githubusercontent.com/daveSoupy/MTG-Card-Library/main/docker-compose.yml)
into it (right-click the link → *Save Link As…*). Keep the name
`docker-compose.yml`.

**3. Open a terminal in that folder** and paste one command.

- *Windows:* open the folder in File Explorer, right-click an empty spot →
  **Open in Terminal**.
- *Mac:* open the folder in Finder, then right-click it → **Services → New
  Terminal at Folder**. (Or open Terminal and drag the folder onto it.)

Then paste this and press Enter:

```bash
docker compose up -d
```

The first time, it downloads the app (a few hundred MB). When you get your prompt
back, it's running.

**4. Open <http://localhost:8080>** in your browser. The app asks to download
the card database on its first run — click through with the default option and
give it about half a minute.

That's it. It keeps running in the background and comes back by itself when
you restart your computer. Docker Desktop's window shows it as `mtg-library`
with a stop/start button if you ever want to pause it.

**Is it working?** If the browser page doesn't load, run this in the same
terminal and include the output when you tell me:

```bash
docker compose logs --tail=50
```

**Updating later** — same folder, same terminal:

```bash
docker compose pull && docker compose up -d
```

**Your data** (collection, decks, trades) is kept by Docker and survives
updates and restarts. What deletes it is `docker compose down -v` — the `-v`
is the dangerous part — or removing the volume in Docker Desktop. Backups are
covered [below](#backups).

---

## Desktop app

The same server as an ordinary application for a Mac — Apple silicon or Intel
— or a Windows PC: double-click to start, quit from the menu bar or system
tray to stop. No Docker, no Node, no terminal. It is for people *without* a home
server — it keeps its own library, and there is no syncing between it and a
self-hosted install, so it is one or the other.

**Download:** the latest release on the
[Releases page](https://github.com/daveSoupy/MTG-Card-Library/releases/latest) —
`MTG-Library-<version>-mac-arm64.dmg` for an Apple silicon Mac,
`MTG-Library-<version>-mac-x64.dmg` for an Intel one (Apple menu → *About This
Mac*: *Chip* means the first, *Processor* the second), and
`MTG-Library-<version>-win-x64-setup.exe` for Windows (**unsigned for now** —
see below for the one extra click). It is 150–250 MB, most of it the bundled
runtime. The Intel build needs macOS 13, which is as far back as Electron
goes; a 2017-or-later Mac can run it. **It updates
itself:** the app checks for a new release when it opens and once a day,
downloads it in the background, and applies it the next time you quit (or
sooner from *Restart to update* in the menu). Nothing interrupts you
mid-session, and your library is untouched by an update — the database
migrates itself on the next open, exactly as a server install does.

It runs in the background: closing the window keeps the server up (the
menu-bar / tray icon reopens it), and only **Quit** stops it. It starts at
login by default. The tray menu also has *Allow other devices on this network*
(off by default — phones on your wifi can then open it), *Pair a phone…* (a
QR code: point the phone's camera at it, it opens the app in the phone's
browser, then *Add to Home Screen*; if the computer's address ever changes,
scan it again), *Keep this computer awake while sharing*, *Show data folder*
(the `library.sqlite` in there is your whole backup), *Show logs* and *Check
for updates…*. The QR lives on the Data page, so any browser already on the
app can show it too.

What the two operating systems say on first open:

- **macOS** — nothing. The build is signed with a Developer ID and notarised
  by Apple, so the `.dmg` opens straight from the browser download with no
  warning and no terminal.
- **Windows** — the installer is **unsigned for now** (a code-signing
  certificate is a separate purchase, not yet made), so SmartScreen shows
  *"Windows protected your PC"*. Click **More info → Run anyway**; that is the
  whole of it — the app installs, runs and updates itself exactly as a signed
  one would, and a later signed release installs over it without any extra
  step. The first time
  you turn on *Allow other devices on this network*, Windows Defender Firewall
  asks about `node.exe`; allow it on private networks or phones will not find
  the app.

To build it yourself (macOS, with the repository set up as under
[Development](#development)):

```bash
npm run desktop:package
```

That produces `desktop/out/MTG-Library-<version>-mac-arm64.dmg` and
`-mac-x64.dmg` (plus the `.zip`s the updater uses) and
`desktop/out/MTG-Library-<version>-win-x64-setup.exe` — the Intel Mac build
and the Windows installer are both cross-built from whichever Mac you are on. Your own build is signed if
a *Developer ID Application* certificate is in your keychain and notarised if
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are in the
environment; without a certificate it is unsigned and runs only where it was
built. `npm run desktop:dev` runs the app from the working tree. Releases are
cut by tagging: `.github/workflows/desktop.yml` builds, signs, notarises and
publishes both installers on a `v*` tag (its header lists the secrets it
needs).

---

## Running it

The sections above are the whole story if you're happy with Docker or the
desktop app. The rest of this README is for people who'd rather run it under
Node, host it as a service, reach it from a phone, or work on the code.

### Option A — Docker

The [`docker-compose.yml`](docker-compose.yml) pulls a ready-made image from
GitHub Container Registry, built for both Intel/AMD and ARM (Apple Silicon,
Raspberry Pi, most NAS boxes). `latest` is the most recent tagged release;
`edge` is whatever's on `main`.

```bash
git clone https://github.com/daveSoupy/MTG-Card-Library.git
cd MTG-Card-Library
docker compose up -d
```

To build the image yourself instead — you've changed the code, or don't want
to trust a prebuilt image — build it under the same name and Compose will use
the local copy:

```bash
docker build -t ghcr.io/davesoupy/mtg-card-library:latest .
docker compose up -d
```

Useful commands:

```bash
docker compose logs -f          # watch the server log
docker compose restart          # restart the app
docker compose down             # stop it (your data stays in the volume)
docker compose down -v          # stop it AND delete the volume — this erases your data
docker compose pull && docker compose up -d   # update to the latest release
```

### Option B — Node directly

Needs **Node.js 20 or newer** (`node --version`). 20 is the oldest release
still getting security updates; the server itself only uses APIs that landed
in 18, so a NAS box or an LTS distro a couple of years behind will run it.

Three things here still want a newer Node, none of them on the path below:
`npm test` and the Electron shell need **22.12**, and the command-line tools
under `server/scripts/` need **22.6**, because they load the TypeScript source
through `--experimental-strip-types`. On 20 or 21 `npm install` prints an
`EBADENGINE` warning about the first two; building and running the server are
unaffected.

```bash
git clone https://github.com/daveSoupy/MTG-Card-Library.git
cd MTG-Card-Library
npm install
npm run build
node server/scripts/check-sqlite.mjs   # must report FTS5 + trigram OK
npm start                              # http://localhost:8080
```

`check-sqlite.mjs` matters: `better-sqlite3` is a native module compiled on
install, and the app's search depends on SQLite having been built with FTS5 and
the trigram tokenizer. If the check fails, run
`npm rebuild better-sqlite3 --build-from-source` and try again.

Data goes to `~/.local/share/mtg-library` by default (see
[Configuration](#configuration)). To keep it running after you log out, see
[`deploy/README.md`](deploy/README.md) for a systemd unit.

### First run

When the app opens with no card data it shows the sync dialog by itself. Keep
the default, **`default_cards`**, and hit download. The two options are:

| Bulk file | Size | What you get |
|---|---|---|
| `default_cards` | ~80 MB | Every printing of every card. Needed to price your collection per printing. **Pick this one.** |
| `oracle_cards` | ~25 MB | One printing per card. Fine for trying the deck builder, but you'll want to re-sync before adding a collection. |

You can re-sync any time from the **Data** tab — Scryfall refreshes prices daily,
so a weekly sync keeps collection values roughly current. Card images are
downloaded on demand and cached; the Data tab can pre-download them in bulk if
you would rather.

---

## Using it from your phone

The server binds to all interfaces (`0.0.0.0:8080`), so anything on the same
network can reach it at `http://<your-machine>:8080`.

To reach it away from home — at a card shop, say — install
[Tailscale](https://tailscale.com/download) on the machine running the app and
on your phone, sign both into the same tailnet, and the app is at
`http://<machine-name>:8080` from anywhere. No port forwarding, no
certificates, no accounts to manage. The app has a proper phone layout for
trades, want lists and quick collection lookups.

## Security (read this)

**There is no login.** The app assumes the network it is on *is* the access
control: your LAN, or your tailnet. That is a deliberate trade — one user, one
database, zero auth code to get wrong.

So: do **not** forward port 8080 on your router, and do not put it behind a
Cloudflare Tunnel or a public reverse proxy. Anyone who can reach the port can
read and edit your collection. If you genuinely need it on the open internet,
put an authenticating proxy (Authelia, Cloudflare Access, Tailscale Funnel with
an identity check…) in front of it first.

---

## Configuration

All configuration is environment variables. With Docker, set them under
`environment:` in `docker-compose.yml`; with Node, export them before `npm start`.

| Variable | Default | Meaning |
|---|---|---|
| `MTG_DATA_DIR` | `~/.local/share/mtg-library` (Node) · `/data` (Docker) | Database, cached card images and scheduled backups |
| `MTG_PORT` | `8080` | Listen port |
| `MTG_HOST` | `0.0.0.0` | Bind address. Set to `127.0.0.1` to restrict to the local machine |
| `MTG_ADVERTISE` | unset | `1` announces the server on the local network over mDNS (`_mtglibrary._tcp`) so a phone that scanned the QR on the Data page finds it after its address changes. Ignored on a loopback bind. Multicast has to reach the network — see the note in `docker-compose.yml` |
| `MTG_LOG_LEVEL` | `info` | Fastify log level (`debug`, `info`, `warn`, `error`) |
| `MTG_SHUTDOWN_ON_STDIN_CLOSE` | unset | `1` makes the server shut down cleanly when its stdin closes. Set by the desktop app, which owns the server's stdin — Windows has no SIGTERM to send — and never under systemd, where stdin is `/dev/null` and would end at once |

## Backups

Everything irreplaceable is one file: `$MTG_DATA_DIR/library.sqlite`. The card
database inside it re-downloads from Scryfall in seconds, so a backup is really
about your collection, decks and trades.

The server takes a backup on its own once a day into `$MTG_DATA_DIR/backups/`
and keeps the last seven. You can also take one, download one, or restore one
from the **Data** tab in the app.

To copy the live database by hand, don't `cp` it — a running SQLite database can
be mid-write. Use SQLite's own snapshot instead:

```bash
sqlite3 /path/to/library.sqlite "VACUUM INTO '/somewhere/safe/mtg-$(date +%F).sqlite'"
```

Or with Docker:

```bash
docker compose exec mtg-library node -e "require('better-sqlite3')('/data/library.sqlite').exec(\"VACUUM INTO '/data/backups/manual-$(date +%F).sqlite'\")"
```

The `images/` folder next to the database is a cache and does not need backing up.

## Testing it — found a bug?

This is being shared for testing, so please do report things. Open an
[issue](https://github.com/daveSoupy/MTG-Card-Library/issues) with:

- what you did and what you expected instead
- Docker or Node, and which OS
- the server log around the time it happened — `docker compose logs --tail=100`
  for Docker, or the terminal running `npm start` — and anything in the
  browser console (F12 → Console) if the page itself misbehaved

Nothing in your collection ever leaves your machine, so paste freely. The only
outbound traffic the app makes is to Scryfall for card data, prices and images.

### Not there yet

The core loop — search, decks, collection, allocation, trades — is built and
is what needs testing. Planned but not built, so not bugs:

- price *history* and live price refresh (prices update on sync only)
- sales tracking and event costs
- shopping-cart export to TCGplayer / Card Kingdom
- theming beyond light/dark, an onboarding tour, install-as-app (PWA)
- shareable decklist links (the server is private by design — export is text)
- a native phone app with OCR card scanning
- importing friends' collections to trade against

---

## Development

The server and the web client run separately in development so both hot-reload:

```bash
npm install
npm run dev                    # Fastify API on :8080, restarts on change
npm run dev --workspace=web    # Vite dev server on :5173, proxies /api to :8080
```

Open <http://localhost:5173> for the live-reloading UI. `MTG_API` points the
Vite proxy somewhere other than `127.0.0.1:8080` if you need it.

```bash
npm test                       # server (node --test) and web (node --test + vitest)
npm run typecheck --workspace=server
```

Command-line tools, all under `server/scripts/` (they import the TypeScript
source directly, hence the flag):

```bash
node server/scripts/check-sqlite.mjs                                        # verify the SQLite build
node --experimental-strip-types server/scripts/sync.mjs --type default_cards  # sync without the UI
node --experimental-strip-types server/scripts/search-check.mjs             # exercise the search layer
node --experimental-strip-types server/scripts/repair-claims.mjs --dry-run  # re-derive deck claims
```

### How it's put together

**One server owns the data and the rules.** Deck validation, search parsing,
allocation maths and format rules all live in `server/`; the web client only
renders what the API hands it. That's the whole architecture — and it's what
would keep a future phone app cheap, since it would hit the same `/api/v1`
endpoints and reimplement nothing.

- `server/` — Fastify + `better-sqlite3`. Per-domain stores under `src/decks`,
  `src/collection`, `src/trades`, `src/search`, `src/sync`, and so on; routes
  hold no rules, they call a store.
- `web/` — React + Vite. One codebase, desktop and phone layouts.
- `desktop/` — the Electron shell around the unmodified server: a bundled
  Node runs `server/dist`, the window shows `web/dist`. No UI or rules of its
  own.
- `schema.sql` — the complete database schema for fresh installs;
  `server/src/db/migrations.ts` upgrades existing databases, and a test proves
  the two produce identical databases.

### Publishing the Docker image

[`.github/workflows/docker.yml`](.github/workflows/docker.yml) builds the image
on GitHub's runners — natively on both amd64 and arm64, then merged into one
multi-arch tag — and pushes it to `ghcr.io/davesoupy/mtg-card-library`. A push
to `main` publishes `edge`; a tag like `v1.2.0` publishes `1.2.0`, `1.2` and
moves `latest`. So cutting a release that friends will get on their next
`docker compose pull` is:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

---

## Why it works this way

A few choices in here look like limitations until you know what they buy.
These are the ones people ask about.

**One server owns the data _and_ the rules.** Deck legality, search parsing,
allocation maths, format rules — all of it lives on the server, and every
client only renders what it is told. That is why the phone layout and the
desktop layout are one codebase, and why the desktop app is just a window
around the same server you would run in Docker. Nothing is implemented twice,
so nothing can disagree with itself.

**Search never touches the internet.** Scryfall publishes daily bulk exports
precisely so that applications cache locally instead of calling the API on
every keystroke. A full import takes about 17 seconds and runs in a worker
thread, so the app keeps serving while it happens and a failed sync leaves the
previous data completely usable. The cost is that prices are around a day old
— fine for "what is this box worth", not for arbitrage.

**There is no offline mode, on purpose.** Clients are always connected; there
is no local cache to reconcile and no sync layer. That sounds like a missing
feature, but it is what buys zero conflict-resolution code — the class of bug
where two devices each believe they are right and your collection quietly ends
up wrong. One database, one writer, no merge logic to get subtly wrong.

**It only works on your own network, and that is not an oversight.** Reaching a
machine at home from somewhere else means getting through NAT, and every method
of doing that needs a publicly reachable third party: a tunnel, a relay, a
coordination server. Someone has to operate it, and it becomes a part of the
path that can break in a way you cannot fix. Tailscale is the honest version of
that trade — you install it, you control it, and it is one app rather than
something buried in here pretending to be free. So the default is your own LAN,
and access from away stays opt-in and yours. See
[Security](#security-read-this).

**A card can only be in one deck at a time, and that is enforced by
recalculating rather than remembering.** Each deck's claim on your collection is
derived — from what you own, and from what every other deck has already taken
— and recomputed on every write that could change the answer. Nothing stores
"this deck holds these two copies" as a standalone fact that could drift. So the
numbers cannot rot: delete a deck and its cards are free immediately, trade one
away and every deck that wanted it updates at once. Only decks marked
*building* or *assembled* reserve anything — a brew holds a list without
starving the decks you actually intend to put on the table.

**Your whole library is one file.** `library.sqlite` is the entirety of it —
no directory of state, no external service holding a piece. The card database is
not in the backup because it re-downloads from Scryfall in seconds.

---

## License

[MIT](LICENSE). Run it, fork it, change it.

## Credits

Card data, images and prices are from [Scryfall](https://scryfall.com), used
under their [API terms](https://scryfall.com/docs/api). Prices are Scryfall's
daily figures from TCGplayer and Cardmarket; treat them as roughly a day old.

This project is unaffiliated with Scryfall or Wizards of the Coast. Magic: The
Gathering is a trademark of Wizards of the Coast LLC.

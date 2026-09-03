# Deploying MTG Library

Runs on an always-on Linux box and is reached over Tailscale, so nothing is exposed to the public internet.

## 1. Install

Node 22 or newer is required.

```bash
sudo useradd --system --home /opt/mtg-library --shell /usr/sbin/nologin mtg
sudo mkdir -p /opt/mtg-library /var/lib/mtg-library
sudo chown -R mtg:mtg /opt/mtg-library /var/lib/mtg-library

sudo -u mtg git clone https://github.com/daveSoupy/MTG-Card-Library.git /opt/mtg-library
cd /opt/mtg-library
sudo -u mtg npm install
sudo -u mtg npm run build
```

`better-sqlite3` is a native module. It compiles on install for the machine it lands on, so verify the SQLite it ends up with actually has what the schema needs:

```bash
node server/scripts/check-sqlite.mjs
```

That must report FTS5, the trigram tokenizer, and a clean schema load. If it fails, `npm rebuild better-sqlite3 --build-from-source` and run it again. Nothing else will work until it passes.

## 2. Run it as a service

```bash
sudo cp deploy/mtg-library.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mtg-library
sudo systemctl status mtg-library
```

Logs: `journalctl -u mtg-library -f`

## 3. Reach it from anywhere

```bash
sudo tailscale up
```

Install Tailscale on your phone and sign in to the same tailnet. The app is then at `http://<machine-name>:8080` from any device on the tailnet, at home or at a card shop, with no port forwarding and no certificates.

> **If you ever move off Tailscale** — a Cloudflare Tunnel, or forwarding a port — the app becomes reachable by strangers. It ships with **no authentication** because the tailnet is the security boundary. Add a login before doing that.

## 4. First run

Open the app and it will offer to download the card database. Or from the command line:

```bash
sudo -u mtg MTG_DATA_DIR=/var/lib/mtg-library \
  node --experimental-strip-types server/scripts/sync.mjs --type default_cards
```

`oracle_cards` (~24 MB) is enough for search and deck building. `default_cards` (~78 MB) carries every printing and is needed before the collection can price individual printings — pick that one unless you are just trying things out.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MTG_DATA_DIR` | `~/.local/share/mtg-library` | Database and cached card images |
| `MTG_PORT` | `8080` | Listen port |
| `MTG_HOST` | `0.0.0.0` | Bind address |
| `MTG_LOG_LEVEL` | `info` | Fastify log level |

## Backups

Everything irreplaceable is in one file: `$MTG_DATA_DIR/library.sqlite`. The card cache inside it re-downloads from Scryfall in about 17 seconds, so a backup is really about your collection, decks and trades.

Copy it safely while the server is running — a plain `cp` of a live SQLite database can capture a torn write:

```bash
sqlite3 /var/lib/mtg-library/library.sqlite \
  "VACUUM INTO '/backups/mtg-$(date +%F).sqlite'"
```

The `images/` directory alongside it is a pure cache and does not need backing up.

## Updating

```bash
cd /opt/mtg-library
sudo -u mtg git pull
sudo -u mtg npm install
sudo -u mtg npm run build
node server/scripts/check-sqlite.mjs   # in case better-sqlite3 was rebuilt
sudo systemctl restart mtg-library
```

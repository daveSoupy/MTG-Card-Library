# MTG Library

Self-hosted Magic: The Gathering collection, deck and trade manager.

One server owns the database and the rules; clients only render. Runs on a machine at
home and is reached over Tailscale, so the deck builder works at a desk and trades can
be recorded from a phone at a card shop.

- **Server** — Node + TypeScript, Fastify, SQLite (`better-sqlite3`), REST under `/api/v1`
- **Client** — React + Vite, one codebase, desktop and phone layouts
- **Card data** — [Scryfall](https://scryfall.com) bulk data, synced locally so search
  never touches the network

## Quick start

```bash
npm install
npm run build
node server/scripts/check-sqlite.mjs   # confirm FTS5 + trigram are available
npm run dev                            # http://127.0.0.1:8080
```

The app offers to download the card database on first run — about 38,000 cards in
roughly 17 seconds.

See [`deploy/README.md`](deploy/README.md) for running it as a service, and
[`CLAUDE.md`](CLAUDE.md) for the data model and build plan.

Card data and images courtesy of Scryfall. This project is unaffiliated with Scryfall
or Wizards of the Coast.

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDataDir, resolveHost, resolvePort } from './config.ts';
import { openLibrary, libraryStatus } from './db/index.ts';
import { CardSearchStore } from './search/store.ts';
import { DeckStore } from './decks/store.ts';
import { CollectionStore } from './collection/store.ts';
import { SyncManager } from './sync/syncManager.ts';
import { registerCardRoutes } from './routes/cards.ts';
import { registerSyncRoutes } from './routes/sync.ts';
import { registerImageRoutes } from './routes/images.ts';
import { registerDeckRoutes } from './routes/decks.ts';
import { registerPresetRoutes } from './routes/presets.ts';
import { registerCollectionRoutes } from './routes/collection.ts';
import { registerPortingRoutes } from './routes/porting.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerStorageRoutes } from './routes/storage.ts';
import { registerTradeRoutes } from './routes/trades.ts';
import { registerWantRoutes } from './routes/wants.ts';
import { registerTradeListRoutes } from './routes/tradeLists.ts';
import { registerAlertRoutes } from './routes/alerts.ts';
import { ImageDownloadManager } from './images/downloadManager.ts';
import { AlertStore } from './alerts/store.ts';
import { TradeStore } from './trades/store.ts';
import { WantStore } from './collection/wants.ts';
import { TradeListStore } from './tradelists/store.ts';
import { startBackupSchedule } from './porting/schedule.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(moduleDir, '..', '..');

const dataDir = resolveDataDir();
const library = openLibrary({ dataDir });
const store = new CardSearchStore(library.db);
const decks = new DeckStore(library.db);
const collection = new CollectionStore(library.db);
const alerts = new AlertStore(library.db);
const trades = new TradeStore(library.db, collection, alerts);
const wants = new WantStore(library.db);
const tradeLists = new TradeListStore(library.db);
const sync = new SyncManager(dataDir);
const downloads = new ImageDownloadManager(library.db, library.imageDir);
const backups = startBackupSchedule(library.db, dataDir);

const app = Fastify({
  logger: { level: process.env.MTG_LOG_LEVEL ?? 'info' },
});

registerCardRoutes(app, store);
registerSyncRoutes(app, library.db, sync);
registerImageRoutes(app, library.db, library.imageDir);
registerDeckRoutes(app, decks, library.db);
registerPresetRoutes(app, library.db);
registerCollectionRoutes(app, library.db, collection);
registerPortingRoutes(app, library.db, decks, collection, backups);
registerSettingsRoutes(app, library.db);
registerStorageRoutes(app, library.db, library.databasePath, downloads);
registerTradeRoutes(app, trades);
registerWantRoutes(app, wants);
registerTradeListRoutes(app, tradeLists);
registerAlertRoutes(app, alerts);

app.get('/api/v1/health', async () => ({ ok: true, dataDir }));

// The built front end, when there is one. In development Vite serves the UI on
// its own port and proxies /api here, so a missing dist/ is not an error.
const webDist = join(repoRoot, 'web', 'dist');
if (existsSync(webDist)) {
  // Wildcard on purpose: with it disabled, @fastify/static enumerates the
  // directory once at registration, so a rebuild's new hashed filenames are
  // unknown and fall through to the HTML fallback — which the browser then
  // rejects as a module script.
  await app.register(fastifyStatic, { root: webDist });
  // Client-side routing: anything not under /api falls back to index.html.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'No such endpoint.' });
    }
    return reply.sendFile('index.html');
  });
}

/**
 * Touch the hot tables once at boot.
 *
 * The first query against a cold database pages it in and measured over a
 * second; every subsequent one was 70ms. Paying that here means the first
 * person to type in the search box does not.
 */
function warmCache(): void {
  try {
    library.db.prepare('SELECT count(*) FROM oracle_cards').get();
    store.search('', {}, 'name', 1);
  } catch {
    // An empty database before the first sync — nothing to warm.
  }
}

const close = async () => {
  await sync.stop();
  await app.close();
  library.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

const port = resolvePort();
const host = resolveHost();
await app.listen({ port, host });

const status = libraryStatus(library.db);
warmCache();

app.log.info(
  status.hasCardData
    ? `Card library ready: ${status.oracleCards.toLocaleString()} cards, ` +
      `${status.printings.toLocaleString()} printings, ${status.sets.toLocaleString()} sets.`
    : 'No card data yet — run a sync from the web interface to download it.',
);
app.log.info(`Data directory: ${dataDir}`);

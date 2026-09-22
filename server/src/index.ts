import Fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAdvertise, resolveDataDir, resolveHost, resolvePort, resolveServerVersion } from './config.ts';
import { instanceId, openLibrary, libraryStatus } from './db/index.ts';
import { CardSearchStore } from './search/store.ts';
import { DeckStore } from './decks/store.ts';
import { CollectionStore } from './collection/store.ts';
import { SyncManager } from './sync/syncManager.ts';
import { registerCardRoutes } from './routes/cards.ts';
import { registerSyncRoutes } from './routes/sync.ts';
import { registerImageRoutes } from './routes/images.ts';
import { registerDeckRoutes } from './routes/decks.ts';
import { registerAssemblyRoutes } from './routes/assembly.ts';
import { registerAllocationRoutes } from './routes/allocation.ts';
import { registerSubstituteRoutes } from './routes/substitutes.ts';
import { registerPresetRoutes } from './routes/presets.ts';
import { registerTemplateRoutes } from './routes/templates.ts';
import { TemplateStore } from './decks/templates.ts';
import { registerCollectionRoutes } from './routes/collection.ts';
import { registerPortingRoutes } from './routes/porting.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerStorageRoutes } from './routes/storage.ts';
import { registerTradeRoutes } from './routes/trades.ts';
import { registerWantRoutes } from './routes/wants.ts';
import { registerTradeListRoutes } from './routes/tradeLists.ts';
import { registerAlertRoutes } from './routes/alerts.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerWebClient } from './routes/webClient.ts';
import { registerInstanceRoutes } from './routes/instance.ts';
import { describeInstance } from './discovery/instance.ts';
import { advertiseDecision, startAdvertisement, type Advertisement } from './discovery/advertise.ts';
import { errorHandler } from './routes/errorHandler.ts';
import { ImageDownloadManager } from './images/downloadManager.ts';
import { AlertStore } from './alerts/store.ts';
import { TradeStore } from './trades/store.ts';
import { WantStore } from './collection/wants.ts';
import { TradeListStore } from './tradelists/store.ts';
import { EventStore } from './events/store.ts';
import { startBackupSchedule } from './porting/schedule.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(moduleDir, '..', '..');

const dataDir = resolveDataDir();
const library = openLibrary({ dataDir });
const store = new CardSearchStore(library.db);
const decks = new DeckStore(library.db);
const templates = new TemplateStore(library.db);
const collection = new CollectionStore(library.db);
const alerts = new AlertStore(library.db);
const trades = new TradeStore(library.db, collection, alerts);
const wants = new WantStore(library.db);
const tradeLists = new TradeListStore(library.db);
const events = new EventStore(library.db);
const sync = new SyncManager(dataDir);
const downloads = new ImageDownloadManager(library.db, library.imageDir);
const backups = startBackupSchedule(library.db, dataDir);

const app = Fastify({
  logger: { level: process.env.MTG_LOG_LEVEL ?? 'info' },
});

// Known error classes become their 4xx; anything else is a bare 500 with the
// stack in the log and nothing in the response.
app.setErrorHandler(errorHandler);

// Compress every response big enough to be worth it. Measured on the real
// library: a 60-card search page is 46KB raw and 7KB gzipped, /api/v1/sets is
// 96KB raw and 14KB gzipped — 6.6x, on the responses a phone waits for most.
//
// gzip is listed before brotli deliberately, which is the reverse of this
// plugin's default. Brotli wins a few percent on size and costs several times
// the CPU to produce, and this server is expected to run on a Pi or an old
// NAS; for a response generated fresh on every request that trade is the wrong
// way round. The *static* bundle is the opposite case — compressed once at
// build time, served thousands of times — so it is pre-compressed to both and
// served by @fastify/static, which picks the best one the browser accepts.
//
// Two things are deliberately not compressed, and neither needs configuring:
// card images, because mime-db marks JPEG and PNG incompressible, and the sync
// progress stream, because it writes to reply.raw and so never reaches an
// onSend hook at all. Compressing SSE would buffer it and stall the progress
// bar — worth knowing before anyone "fixes" that route to use reply.send.
await app.register(fastifyCompress, {
  encodings: ['gzip', 'br', 'deflate'],
  threshold: 1024,
});

registerCardRoutes(app, store);
registerSyncRoutes(app, library.db, sync);
registerImageRoutes(app, library.db, library.imageDir);
registerDeckRoutes(app, decks, library.db);
registerAssemblyRoutes(app, library.db);
registerAllocationRoutes(app, library.db);
registerSubstituteRoutes(app, library.db);
registerPresetRoutes(app, library.db);
registerTemplateRoutes(app, templates);
registerCollectionRoutes(app, library.db, collection);
registerPortingRoutes(app, library.db, decks, collection, backups);
registerSettingsRoutes(app, library.db);
registerStorageRoutes(app, library.db, library.databasePath, downloads);
registerTradeRoutes(app, trades);
registerWantRoutes(app, wants);
registerTradeListRoutes(app, tradeLists);
registerAlertRoutes(app, alerts);
registerEventRoutes(app, events);

const port = resolvePort();
const host = resolveHost();
const version = resolveServerVersion();
registerInstanceRoutes(app, library.db, { port, host, version });

app.get('/api/v1/health', async () => ({ ok: true, dataDir }));

// The built front end, when there is one. In development Vite serves the UI on
// its own port and proxies /api here, so a missing dist/ is not an error.
const webDist = join(repoRoot, 'web', 'dist');
if (existsSync(webDist)) await registerWebClient(app, webDist);

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

let advertisement: Advertisement | null = null;

let closing = false;
const close = async () => {
  // SIGTERM and a closed stdin can both arrive; the second is a no-op.
  if (closing) return;
  closing = true;
  // Goodbye packets first, so a browsing phone drops the record now rather
  // than when its TTL runs out — but a socket that will not close must not
  // hold up the exit, so a second is all it gets.
  if (advertisement) {
    await Promise.race([advertisement.stop(), new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
  }
  // A running sync worker should terminate quickly, but never let a stuck
  // one hang shutdown indefinitely — Tailscale/systemd expect the process to
  // actually exit.
  let timer: NodeJS.Timeout;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), 10_000);
  });
  const stopped = sync.stop().then(() => false);
  const didTimeOut = await Promise.race([stopped, timedOut]);
  clearTimeout(timer!);
  if (didTimeOut) {
    app.log.error('Sync did not stop within 10s during shutdown; exiting immediately.');
    process.exit(1);
  }
  await app.close();
  library.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
// The desktop shell (Phase 32) owns this process's stdin and closes it to ask
// for shutdown — Windows has no SIGTERM to send a child — and if the shell
// itself dies the pipe closes and the server follows instead of lingering on
// the port. Opt-in: under systemd stdin is /dev/null, which ends immediately.
if (process.env.MTG_SHUTDOWN_ON_STDIN_CLOSE === '1') {
  process.stdin.on('end', () => void close());
  process.stdin.on('error', () => void close());
  process.stdin.resume();
}

await app.listen({ port, host });

// Phase 33: tell the local link where we are, when asked to and when it
// could matter. The decision is pure and tested; this is only the wiring.
switch (advertiseDecision(resolveAdvertise(), host)) {
  case 'advertise': {
    const info = describeInstance({ instanceId: instanceId(library.db), version, port, host });
    advertisement = startAdvertisement(info, app.log);
    break;
  }
  case 'loopback':
    app.log.info(`MTG_ADVERTISE is set but the server is bound to ${host}; nothing to advertise.`);
    break;
  case 'off':
    break;
}

const status = libraryStatus(library.db);
warmCache();

app.log.info(
  status.hasCardData
    ? `Card library ready: ${status.oracleCards.toLocaleString()} cards, ` +
      `${status.printings.toLocaleString()} printings, ${status.sets.toLocaleString()} sets.`
    : 'No card data yet — run a sync from the web interface to download it.',
);
app.log.info(`Data directory: ${dataDir}`);

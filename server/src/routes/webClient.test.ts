import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

import { registerWebClient } from './webClient.ts';

/**
 * Phase 31. A stand-in web/dist with the files the install flow references,
 * so the test needs no build: the worker is served uncached, hashed assets
 * are not, the manifest has its media type, and the fallback rules that
 * predate this phase still hold.
 */

function fixture() {
  const dist = mkdtempSync(join(tmpdir(), 'mtg-webdist-'));
  mkdirSync(join(dist, 'assets'));
  mkdirSync(join(dist, 'icons'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><script type="module" src="/assets/index-abc123.js"></script>');
  writeFileSync(join(dist, 'sw.js'), "self.addEventListener('fetch', () => {});");
  writeFileSync(join(dist, 'manifest.webmanifest'), '{"name":"MTG Library"}');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dist, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return dist;
}

test('sw.js is served with Cache-Control: no-cache; nothing else is', async () => {
  const dist = fixture();
  const app = Fastify();
  try {
    await registerWebClient(app, dist);
    const sw = await app.inject({ method: 'GET', url: '/sw.js' });
    assert.equal(sw.statusCode, 200);
    assert.equal(sw.headers['cache-control'], 'no-cache');
    assert.match(String(sw.headers['content-type']), /javascript/);

    const asset = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    assert.equal(asset.statusCode, 200);
    assert.notEqual(asset.headers['cache-control'], 'no-cache', 'a hashed bundle is a new name per build');

    const page = await app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.notEqual(page.headers['cache-control'], 'no-cache');
  } finally {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  }
});

test('the manifest and icons are reachable at the paths index.html names', async () => {
  const dist = fixture();
  const app = Fastify();
  try {
    await registerWebClient(app, dist);
    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    assert.equal(manifest.statusCode, 200);
    assert.match(String(manifest.headers['content-type']), /manifest\+json/);
    assert.equal(manifest.json().name, 'MTG Library');

    const icon = await app.inject({ method: 'GET', url: '/icons/icon-192.png' });
    assert.equal(icon.statusCode, 200);
    assert.match(String(icon.headers['content-type']), /image\/png/);
  } finally {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  }
});

test('client routes fall back to index.html; unknown API paths stay a JSON 404', async () => {
  const dist = fixture();
  const app = Fastify();
  try {
    await registerWebClient(app, dist);
    const route = await app.inject({ method: 'GET', url: '/decks/12' });
    assert.equal(route.statusCode, 200);
    assert.match(route.body, /<!doctype html>/);

    const api = await app.inject({ method: 'GET', url: '/api/v1/nothing-here' });
    assert.equal(api.statusCode, 404);
    assert.deepEqual(api.json(), { error: 'No such endpoint.' });
  } finally {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  }
});

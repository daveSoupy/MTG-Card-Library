import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';

import { SCHEMA_PATH, instanceId } from '../db/index.ts';
import { resolveServerVersion } from '../config.ts';
import { registerInstanceRoutes } from './instance.ts';

/**
 * `GET /api/v1/instance` over an in-memory library: the id the database
 * holds, the version from server/package.json, the bound port, and an
 * address list that is empty on a loopback bind — the shape the pairing
 * panel and a paired phone both read.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function fixture(bound: { port: number; host: string }) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const app = Fastify();
  registerInstanceRoutes(app, db, { ...bound, version: resolveServerVersion() });
  return { db, app };
}

test('the instance endpoint reports the stored id, the package version and the bind', async () => {
  const { db, app } = fixture({ port: 8090, host: '127.0.0.1' });
  const id = instanceId(db);

  const res = await app.inject({ method: 'GET', url: '/api/v1/instance' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.instanceId, id);
  assert.match(body.version, /^\d+\.\d+\.\d+/, 'a semver from server/package.json');
  assert.equal(body.port, 8090);
  assert.equal(typeof body.name, 'string');
  assert.ok(body.name.length > 0, 'the OS hostname');
  assert.deepEqual(body.addresses, [], 'a loopback bind exposes no address — the UI reads that as sharing off');
  assert.equal(body.mdnsName, `mtg-library-${id.slice(0, 4)}.local`);

  const again = await app.inject({ method: 'GET', url: '/api/v1/instance' });
  assert.equal(again.json().instanceId, id, 'stable across requests');

  await app.close();
  db.close();
});

test('a wildcard bind lists this machine\'s addresses, each one a bare IP', async () => {
  const { db, app } = fixture({ port: 8080, host: '0.0.0.0' });
  const body = (await app.inject({ method: 'GET', url: '/api/v1/instance' })).json();
  assert.ok(Array.isArray(body.addresses));
  for (const address of body.addresses) {
    assert.match(address, /^\d{1,3}(\.\d{1,3}){3}$/, `IPv4 only on a 0.0.0.0 bind: ${address}`);
    assert.doesNotMatch(address, /^127\./);
    assert.doesNotMatch(address, /^169\.254\./);
  }
  await app.close();
  db.close();
});

test('the version the endpoint reports is the one config.ts resolves, read once', () => {
  assert.equal(resolveServerVersion(), resolveServerVersion());
  assert.equal(resolveServerVersion(), JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
});

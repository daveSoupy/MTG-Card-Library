import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INSTANCE_ID, getSetting, instanceId, openLibrary } from '../db/index.ts';
import { boundAddresses, describeInstance, isLoopbackHost, mdnsHostname, type InterfaceAddress } from './instance.ts';
import { advertiseDecision } from './advertise.ts';

/**
 * Phase 33's verification item 1 and the two pure rules the endpoint and the
 * advertisement rest on: which addresses a bind exposes, in which order, and
 * when the flag alone is not enough to advertise.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('instanceId is minted on first open, stable across reopens, fresh on a new data directory', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'mtg-instance-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'mtg-instance-b-'));
  try {
    const first = openLibrary({ dataDir: dirA, createImageDir: false });
    const idA = getSetting(first.db, INSTANCE_ID);
    assert.ok(idA && UUID.test(idA), 'written to app_settings at open, as a v4 UUID');
    assert.equal(instanceId(first.db), idA, 'reading it back returns the stored one, not a new one');
    first.close();

    const again = openLibrary({ dataDir: dirA, createImageDir: false });
    assert.equal(instanceId(again.db), idA, 'a restart keeps the identity');
    again.close();

    const other = openLibrary({ dataDir: dirB, createImageDir: false });
    assert.notEqual(instanceId(other.db), idA, 'a different data directory is a different library');
    other.close();
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('a restore that dropped the row gets a new id on the next read rather than none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtg-instance-restore-'));
  try {
    const lib = openLibrary({ dataDir: dir, createImageDir: false });
    const before = instanceId(lib.db);
    // What restoring a pre-Phase-33 backup does to app_settings.
    lib.db.prepare("DELETE FROM app_settings WHERE key = ?").run(INSTANCE_ID);
    const after = instanceId(lib.db);
    assert.ok(UUID.test(after));
    assert.notEqual(after, before);
    assert.equal(instanceId(lib.db), after, 'and that one sticks');
    lib.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the mDNS hostname is the first four characters of the id, lower-cased', () => {
  assert.equal(mdnsHostname('AB12cd34-0000-4000-8000-000000000000'), 'mtg-library-ab12.local');
});

test('loopback binds are recognised in every spelling', () => {
  for (const host of ['127.0.0.1', '127.0.0.53', '::1', '[::1]', 'localhost', 'LOCALHOST ']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.20', '100.101.102.103']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

// A laptop on home wifi, with Tailscale up, a link-local leftover, and a
// Docker-style bridge — in the order the OS happened to list them.
const INTERFACES: Record<string, InterfaceAddress[]> = {
  lo0: [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
    { address: '::1', family: 'IPv6', internal: true },
    { address: 'fe80::1%lo0', family: 'IPv6', internal: true },
  ],
  utun3: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
  en0: [
    { address: 'fe80::1c2b:3d4e:5f60:7a8b%en0', family: 'IPv6', internal: false },
    { address: '192.168.1.20', family: 'IPv4', internal: false },
    { address: '2001:db8:1234::42', family: 'IPv6', internal: false },
  ],
  en5: [{ address: '169.254.10.10', family: 'IPv4', internal: false }],
  bridge100: [{ address: '192.168.64.1', family: 'IPv4', internal: false }],
};

test('a wildcard IPv4 bind lists every non-loopback IPv4 address, home network first', () => {
  assert.deepEqual(boundAddresses('0.0.0.0', INTERFACES), [
    '192.168.1.20', // RFC 1918 before the Tailscale address, whatever the OS order
    '192.168.64.1',
    '100.101.102.103',
  ]);
});

test('a wildcard IPv6 bind adds routable IPv6 after IPv4, never link-local', () => {
  assert.deepEqual(boundAddresses('::', INTERFACES), [
    '192.168.1.20', '192.168.64.1', '100.101.102.103', '2001:db8:1234::42',
  ]);
});

test('a specific bind lists just that address; loopback lists nothing', () => {
  assert.deepEqual(boundAddresses('192.168.1.20', INTERFACES), ['192.168.1.20']);
  assert.deepEqual(boundAddresses('100.101.102.103', INTERFACES), ['100.101.102.103']);
  assert.deepEqual(boundAddresses('127.0.0.1', INTERFACES), []);
  assert.deepEqual(boundAddresses('::1', INTERFACES), []);
  // Bound to an address no interface has (a stale MTG_HOST): nothing to offer,
  // which the panel reports rather than inventing one.
  assert.deepEqual(boundAddresses('10.9.9.9', INTERFACES), []);
});

test('describeInstance assembles the endpoint shape from its inputs', () => {
  const info = describeInstance({
    instanceId: 'ab12cd34-0000-4000-8000-000000000000',
    version: '1.0.0',
    port: 8080,
    host: '0.0.0.0',
    interfaces: INTERFACES,
    name: 'Daves-Mac',
  });
  assert.deepEqual(info, {
    instanceId: 'ab12cd34-0000-4000-8000-000000000000',
    name: 'Daves-Mac',
    version: '1.0.0',
    port: 8080,
    addresses: ['192.168.1.20', '192.168.64.1', '100.101.102.103'],
    mdnsName: 'mtg-library-ab12.local',
  });
});

test('the advertise gate: off without the flag, loopback when there is nothing to reach, else on', () => {
  assert.equal(advertiseDecision(false, '0.0.0.0'), 'off');
  assert.equal(advertiseDecision(false, '127.0.0.1'), 'off');
  assert.equal(advertiseDecision(true, '127.0.0.1'), 'loopback');
  assert.equal(advertiseDecision(true, 'localhost'), 'loopback');
  assert.equal(advertiseDecision(true, '::1'), 'loopback');
  assert.equal(advertiseDecision(true, '0.0.0.0'), 'advertise');
  assert.equal(advertiseDecision(true, '::'), 'advertise');
  assert.equal(advertiseDecision(true, '192.168.1.20'), 'advertise');
});

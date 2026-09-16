import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG, DEFAULT_PORT, choosePort, isPortFree, parseConfig, readConfig, writeConfig } from './config.ts';

test('parseConfig: missing, corrupt and non-object input all yield the defaults', () => {
  assert.deepEqual(parseConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig(''), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig('{not json'), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig('[1,2]'), { ...DEFAULT_CONFIG });
  assert.deepEqual(parseConfig('42'), DEFAULT_CONFIG);
});

test('parseConfig: keeps valid values, drops malformed ones and unknown keys', () => {
  const parsed = parseConfig(
    JSON.stringify({
      port: 8081,
      sharing: true,
      keepAwake: 'yes',
      launchAtLogin: false,
      windowBounds: { width: 1000, height: 700, x: 10 },
      somethingElse: 1,
    }),
  );
  assert.equal(parsed.port, 8081);
  assert.equal(parsed.sharing, true);
  assert.equal(parsed.keepAwake, false, 'a string is not a boolean');
  assert.equal(parsed.launchAtLogin, false);
  assert.deepEqual(parsed.windowBounds, { width: 1000, height: 700, x: 10 });
  assert.equal('somethingElse' in parsed, false);
});

test('parseConfig: rejects out-of-range ports and zero-size bounds', () => {
  assert.equal(parseConfig('{"port": 70000}').port, null);
  assert.equal(parseConfig('{"port": "8080"}').port, null);
  assert.equal(parseConfig('{"windowBounds": {"width": 0, "height": 5}}').windowBounds, null);
});

test('writeConfig then readConfig round-trips, creating the directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtg-desktop-config-'));
  try {
    const path = join(dir, 'nested', 'desktop-config.json');
    const config = { ...DEFAULT_CONFIG, port: 8090, sharing: true };
    writeConfig(path, config);
    assert.deepEqual(readConfig(path), config);
    assert.match(readFileSync(path, 'utf8'), /"port": 8090/);
    // A corrupt file on disk reads as defaults rather than throwing.
    writeFileSync(path, '{{{');
    assert.deepEqual(readConfig(path), DEFAULT_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('choosePort: keeps a remembered free port even when 8080 is free', async () => {
  const probe = async () => true;
  assert.equal(await choosePort(8123, '127.0.0.1', probe), 8123);
});

test('choosePort: falls back to 8080, then the next free port above it', async () => {
  const busy = new Set([8080, 8081, 8123]);
  const probe = async (port: number) => !busy.has(port);
  assert.equal(await choosePort(null, '127.0.0.1', probe), 8082);
  assert.equal(await choosePort(8123, '127.0.0.1', probe), 8082, 'remembered port taken → search from 8080');
  assert.equal(await choosePort(8081, '127.0.0.1', async (p) => p !== 8081), DEFAULT_PORT);
});

test('choosePort: gives up with a clear error when nothing is free', async () => {
  await assert.rejects(choosePort(null, '127.0.0.1', async () => false), /No free port/);
});

test('isPortFree: a port held on the wildcard address is taken on loopback too', async () => {
  const { createServer } = await import('node:net');
  const holder = createServer();
  // Bound to 0.0.0.0, as the dev server and the Docker image are. On macOS a
  // plain bind probe on 127.0.0.1 would still succeed here.
  await new Promise<void>((resolve) => holder.listen(0, '0.0.0.0', resolve));
  const address = holder.address();
  assert.ok(address && typeof address === 'object');
  try {
    assert.equal(await isPortFree(address.port, '127.0.0.1'), false);
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
  assert.equal(await isPortFree(address.port, '127.0.0.1'), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REACHABILITY_MESSAGE, classifyHost, reconnectMessage } from './reachability.ts';

/**
 * Phase 31's table, one row per way the page can have been reached. The
 * message is chosen from this — a wrong row tells the user to turn on a VPN
 * they are not using, so every example in the doc is pinned here.
 */

test('the nine hostnames from the phase doc classify as the table says', () => {
  const expected: Array<[string, ReturnType<typeof classifyHost>]> = [
    ['100.101.102.103', 'tailnet'],
    ['foo.tail1234.ts.net', 'tailnet'],
    ['192.168.1.20', 'lan'],
    ['10.0.0.5', 'lan'],
    ['172.20.0.1', 'lan'],
    ['mtg-library-ab12.local', 'lan'],
    ['localhost', 'local'],
    ['127.0.0.1', 'local'],
    ['example.com', 'unknown'],
  ];
  for (const [host, kind] of expected) {
    assert.equal(classifyHost(host), kind, host);
  }
});

test('the CGNAT and 172.16/12 ranges have edges', () => {
  // 100.64.0.0/10 runs 100.64 – 100.127; the neighbours are public space.
  assert.equal(classifyHost('100.64.0.1'), 'tailnet');
  assert.equal(classifyHost('100.127.255.254'), 'tailnet');
  assert.equal(classifyHost('100.63.255.255'), 'unknown');
  assert.equal(classifyHost('100.128.0.1'), 'unknown');
  // 172.16/12 runs 172.16 – 172.31.
  assert.equal(classifyHost('172.16.0.1'), 'lan');
  assert.equal(classifyHost('172.31.255.1'), 'lan');
  assert.equal(classifyHost('172.15.0.1'), 'unknown');
  assert.equal(classifyHost('172.32.0.1'), 'unknown');
  // 192.169 is not 192.168.
  assert.equal(classifyHost('192.169.1.1'), 'unknown');
});

test('IPv6 loopback, link-local, ULA and the Tailscale prefix', () => {
  // Browsers report an IPv6 hostname with its brackets on.
  assert.equal(classifyHost('[::1]'), 'local');
  assert.equal(classifyHost('::1'), 'local');
  assert.equal(classifyHost('[fe80::1%en0]'), 'lan');
  assert.equal(classifyHost('[fd12:3456:789a::1]'), 'lan');
  assert.equal(classifyHost('[fd7a:115c:a1e0::ab12:cd34]'), 'tailnet');
  assert.equal(classifyHost('[2001:db8::1]'), 'unknown');
});

test('case and whitespace do not matter, and a public name is unknown', () => {
  assert.equal(classifyHost('  MTG-Library-AB12.LOCAL '), 'lan');
  assert.equal(classifyHost('LOCALHOST'), 'local');
  assert.equal(classifyHost('mtg.example.org'), 'unknown');
  // A name that merely contains the suffix is not the suffix.
  assert.equal(classifyHost('ts.net.example.com'), 'unknown');
  assert.equal(classifyHost('notlocal'), 'unknown');
});

test('each way in gets its own message, and the lan one ends before the QR clause', () => {
  assert.equal(reconnectMessage('100.101.102.103'), REACHABILITY_MESSAGE.tailnet);
  assert.equal(reconnectMessage('192.168.1.20'), REACHABILITY_MESSAGE.lan);
  assert.equal(reconnectMessage('localhost'), REACHABILITY_MESSAGE.local);
  assert.equal(reconnectMessage('example.com'), REACHABILITY_MESSAGE.unknown);
  assert.match(REACHABILITY_MESSAGE.tailnet, /Tailscale/);
  // Phase 33 appends "scan the QR code on it again" once there is a QR.
  assert.ok(REACHABILITY_MESSAGE.lan.endsWith('its address may have changed.'));
  assert.doesNotMatch(REACHABILITY_MESSAGE.lan, /QR/);
});

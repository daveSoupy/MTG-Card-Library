import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAIR_FRAGMENT_PREFIX, pairingHost, pairingRecord, pairingTarget, pairingUrl, parsePairingFragment } from './pairing.ts';
import type { InstanceInfo } from './api.ts';

/**
 * The QR's URL and the record inside it. Both halves of Phase 33's contract
 * live in one module so a phone reading the fragment gets back exactly what
 * the panel put in.
 */

const INFO: InstanceInfo = {
  instanceId: 'ab12cd34-0000-4000-8000-000000000000',
  name: 'Daves-Mac',
  version: '1.0.0',
  port: 8080,
  addresses: ['192.168.1.20', '100.101.102.103', '2001:db8::42'],
  mdnsName: 'mtg-library-ab12.local',
};

test('the QR URL is a plain http link to the first IPv4 address with the record in the fragment', () => {
  const url = pairingUrl(INFO);
  assert.ok(url);
  assert.ok(url.startsWith('http://192.168.1.20:8080/#pair='), url);
  assert.doesNotMatch(url, /\.local/, 'the host is an address, never the mDNS name');
  const payload = url.slice(url.indexOf(PAIR_FRAGMENT_PREFIX) + PAIR_FRAGMENT_PREFIX.length);
  assert.doesNotMatch(payload, /[+/=]/, 'base64url, so nothing in the fragment needs escaping');
});

test('the record round-trips through the fragment', () => {
  const url = pairingUrl(INFO)!;
  const hash = url.slice(url.indexOf('#'));
  assert.deepEqual(parsePairingFragment(hash), pairingRecord(INFO));
  assert.deepEqual(parsePairingFragment(hash), {
    v: 1,
    id: INFO.instanceId,
    mdns: 'mtg-library-ab12.local',
    port: 8080,
    addresses: ['192.168.1.20', '100.101.102.103', '2001:db8::42'],
  });
});

test('a hostname with non-ASCII survives the encoding', () => {
  const info = { ...INFO, mdnsName: 'mtg-library-ab12.local', name: 'Dàve’s Mac' };
  const url = pairingUrl(info)!;
  assert.deepEqual(parsePairingFragment(url.slice(url.indexOf('#'))), pairingRecord(info));
});

test('no IPv4 address means no QR — sharing is off, or only IPv6 is bound', () => {
  assert.equal(pairingHost({ addresses: [], port: 8080 }), null);
  assert.equal(pairingUrl({ ...INFO, addresses: [] }), null);
  assert.equal(pairingHost({ addresses: ['2001:db8::42'], port: 8080 }), null);
  assert.equal(pairingHost({ addresses: ['2001:db8::42', '10.0.0.5'], port: 8080 }), '10.0.0.5');
});

test('a page opened at a home-network address is the QR target, ahead of what the server lists', () => {
  // Docker's default bridge: the server sees only the container's address and
  // inside port; the browser reached it at the host's LAN address and port.
  const docker = { ...INFO, addresses: ['172.17.0.2'], port: 8080 };
  const page = { hostname: '192.168.1.20', port: '8095' };
  assert.deepEqual(pairingTarget(docker, page), { host: '192.168.1.20', port: 8095 });
  const url = pairingUrl(docker, page)!;
  assert.ok(url.startsWith('http://192.168.1.20:8095/#pair='), url);
  assert.deepEqual(parsePairingFragment(url.slice(url.indexOf('#'))), {
    v: 1, id: INFO.instanceId, mdns: INFO.mdnsName, port: 8095, addresses: ['192.168.1.20', '172.17.0.2'],
  });
  // The default port is 80 when the URL carries none.
  assert.deepEqual(pairingTarget(docker, { hostname: '10.0.0.7', port: '' }), { host: '10.0.0.7', port: 80 });
  // A page host already in the list just moves to the front, without a duplicate.
  assert.deepEqual(pairingRecord(INFO, { hostname: '100.101.102.103', port: '8080' }).addresses, INFO.addresses, 'a Tailscale page host does not win');
  assert.deepEqual(pairingRecord({ ...INFO, addresses: ['10.0.0.5', '192.168.1.20'] }, { hostname: '192.168.1.20', port: '8080' }).addresses, ['192.168.1.20', '10.0.0.5']);
});

test('the page origin is ignored when it is not a home-network IPv4 address', () => {
  const expected = { host: '192.168.1.20', port: 8080 };
  assert.deepEqual(pairingTarget(INFO, { hostname: 'localhost', port: '8080' }), expected, 'the desktop app window');
  assert.deepEqual(pairingTarget(INFO, { hostname: '127.0.0.1', port: '8082' }), expected);
  assert.deepEqual(pairingTarget(INFO, { hostname: '100.101.102.103', port: '8080' }), expected, 'Tailscale');
  assert.deepEqual(pairingTarget(INFO, { hostname: 'mtg-library-ab12.local', port: '8080' }), expected, 'an mDNS name — not for a camera');
  assert.deepEqual(pairingTarget(INFO, { hostname: '[fd12:3456:789a::1]', port: '8080' }), expected, 'IPv6, even a home one');
  assert.deepEqual(pairingTarget(INFO, { hostname: 'mtg.example.org', port: '' }), expected);
  assert.equal(pairingUrl({ ...INFO, addresses: [] }, { hostname: 'localhost', port: '8080' }), null, 'no fallback to loopback');
});

test('anything that is not a pairing fragment parses to null rather than throwing', () => {
  assert.equal(parsePairingFragment(''), null);
  assert.equal(parsePairingFragment('#pair'), null);
  assert.equal(parsePairingFragment('#other=abc'), null);
  assert.equal(parsePairingFragment(`${PAIR_FRAGMENT_PREFIX}not-base64!!`), null);
  assert.equal(parsePairingFragment(`${PAIR_FRAGMENT_PREFIX}${btoa('"a string"')}`), null);
  assert.equal(parsePairingFragment(`${PAIR_FRAGMENT_PREFIX}${btoa('{"v":2,"id":"x","mdns":"m","port":1,"addresses":[]}')}`), null, 'an unknown version');
  assert.equal(parsePairingFragment(`${PAIR_FRAGMENT_PREFIX}${btoa('{"v":1,"id":"x","mdns":"m","port":"1","addresses":[]}')}`), null, 'a wrong type');
  assert.equal(parsePairingFragment(`${PAIR_FRAGMENT_PREFIX}${btoa('{"v":1,"id":"x","mdns":"m","port":1,"addresses":[1]}')}`), null, 'a wrong element type');
});

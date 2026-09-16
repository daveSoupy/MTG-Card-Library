/**
 * Phase 33. The pairing record a phone carries away from the QR code, and
 * the URL the QR encodes.
 *
 * The URL is `http://<address>:<port>/#pair=<base64url JSON>` — a plain
 * link, so a phone's camera opens it in the browser with nothing installed
 * and lands in this web app, ready for *Add to Home Screen*. The web client
 * ignores the fragment (`router.ts` reads only the path and the query); the
 * parked companion app registers the same URL pattern and reads the fragment
 * as its pairing record. Both halves are here so they agree, and both are
 * pure so `node --test` covers them.
 *
 * The host is an IP address, never the `.local` name: iPhones resolve mDNS
 * names natively, Android browsers often do not, and the QR has to work from
 * a camera app. The `.local` name rides along inside the record for the
 * phone that can use it.
 *
 * This is discovery, not a credential — see the phase doc's "Trust model".
 */

import type { InstanceInfo } from './api.ts';
import { classifyHost } from './reachability.ts';

export interface PairingRecord {
  /** Record format version. Additive changes keep 1. */
  v: 1;
  /** The library's `instanceId`; a phone syncs only with this one. */
  id: string;
  /** The advertised mDNS hostname, e.g. `mtg-library-ab12.local`. */
  mdns: string;
  port: number;
  /** Every address the server answered on when the QR was drawn, LAN first. */
  addresses: string[];
}

export const PAIR_FRAGMENT_PREFIX = '#pair=';

/** Where this page was loaded from — `window.location`'s hostname and port. */
export interface PageOrigin {
  hostname: string;
  /** `location.port`, which is '' for the scheme's default. */
  port: string;
}

/** Four dotted decimal octets. The QR's host has to be one a camera app can open. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The address and port the QR points at, or null when there is none to offer.
 *
 * The page's own origin wins when it is a home-network IPv4 address: it is
 * proven to work from at least the device showing the panel, and it is the
 * only right answer when the server cannot know its outside address —
 * Docker's default bridge network reports the container's `172.17.0.2:8080`,
 * not the host's `192.168.1.20:8080` that a phone can actually open. The
 * desktop app's window (loopback), a Tailscale address, a `.local` name or
 * an IPv6 page all fall back to the server's list, whose first IPv4 entry
 * is its best home-network guess.
 */
export function pairingTarget(info: Pick<InstanceInfo, 'addresses' | 'port'>, page?: PageOrigin): { host: string; port: number } | null {
  if (page && IPV4.test(page.hostname) && classifyHost(page.hostname) === 'lan') {
    return { host: page.hostname, port: page.port === '' ? 80 : Number(page.port) };
  }
  const host = info.addresses.find((a) => IPV4.test(a));
  return host === undefined ? null : { host, port: info.port };
}

/** The address the QR points at, or null when there is none. */
export function pairingHost(info: Pick<InstanceInfo, 'addresses' | 'port'>, page?: PageOrigin): string | null {
  return pairingTarget(info, page)?.host ?? null;
}

/**
 * The record a phone keeps. The QR's own target leads the address list and
 * sets the port, so a phone tries the proven address first (the parked
 * companion app's discovery order, step 4) and the port is the one that
 * answered, not a container's inside port.
 */
export function pairingRecord(info: InstanceInfo, page?: PageOrigin): PairingRecord {
  const target = pairingTarget(info, page);
  const addresses = target === null
    ? [...info.addresses]
    : [target.host, ...info.addresses.filter((a) => a !== target.host)];
  return { v: 1, id: info.instanceId, mdns: info.mdnsName, port: target?.port ?? info.port, addresses };
}

// base64url without Buffer, so this runs in the browser and under node --test
// alike. `btoa` wants a binary string, so the JSON is UTF-8 encoded first;
// the record is ASCII in practice, but a hostname need not be.
function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (encoded.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The full URL the QR encodes, or null when there is no address to offer (sharing off). */
export function pairingUrl(info: InstanceInfo, page?: PageOrigin): string | null {
  const target = pairingTarget(info, page);
  if (target === null) return null;
  return `http://${target.host}:${target.port}/${PAIR_FRAGMENT_PREFIX}${base64url(JSON.stringify(pairingRecord(info, page)))}`;
}

/**
 * Reads a pairing record back out of a URL fragment (`location.hash`), or
 * null for any fragment that is not one — including a malformed one, which
 * the web client must shrug at rather than throw on.
 */
export function parsePairingFragment(hash: string): PairingRecord | null {
  if (!hash.startsWith(PAIR_FRAGMENT_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64url(hash.slice(PAIR_FRAGMENT_PREFIX.length)));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (r.v !== 1 || typeof r.id !== 'string' || typeof r.mdns !== 'string' || typeof r.port !== 'number') return null;
    if (!Array.isArray(r.addresses) || !r.addresses.every((a) => typeof a === 'string')) return null;
    return { v: 1, id: r.id, mdns: r.mdns, port: r.port, addresses: r.addresses as string[] };
  } catch {
    return null;
  }
}

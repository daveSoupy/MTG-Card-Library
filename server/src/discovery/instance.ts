import { hostname, networkInterfaces } from 'node:os';

/**
 * Phase 33. What a phone needs to know to find this server again: a stable
 * identity, the addresses it is reachable on right now, and the mDNS name it
 * advertises under. Pure over its inputs — `describeInstance` takes the
 * interface table as an argument so the address rules run under `node --test`
 * on a machine whose real interfaces are whatever they are.
 *
 * None of this is authentication. The pairing record lets a phone *find* the
 * server; it gates nothing. See the phase doc's "Trust model" before adding a
 * token here.
 */

export interface InstanceInfo {
  instanceId: string;
  /** The OS hostname — enough to tell two libraries apart in a Bonjour browser. */
  name: string;
  /** `server/package.json`'s version, for the companion app's skew contract. */
  version: string;
  port: number;
  /**
   * Non-loopback addresses the server is bound on, LAN-first: RFC 1918 IPv4,
   * then any other IPv4 (Tailscale's CGNAT range, a public address), then
   * routable IPv6. Empty on a loopback bind, which the UI reads as "sharing
   * is off". Link-local addresses are left out — a phone cannot use one
   * without a zone id, and a QR that opens on `169.254.x.x` is worse than
   * one that says to turn sharing on.
   */
  addresses: string[];
  /** `mtg-library-<first 4 of instanceId>.local`, the advertised hostname. */
  mdnsName: string;
}

/** The hostname advertised over mDNS. Two libraries on one network never collide. */
export function mdnsHostname(instanceId: string): string {
  return `mtg-library-${instanceId.slice(0, 4).toLowerCase()}.local`;
}

/** The DNS-SD service type, as `dns-sd -B _mtglibrary._tcp` would name it. */
export const SERVICE_TYPE = 'mtglibrary';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** True for a bind address only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(bare) || bare.startsWith('127.');
}

function ipv4Octets(address: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return null;
  return m.slice(1, 5).map(Number) as [number, number, number, number];
}

/** RFC 1918 — the home network, which a QR must prefer over a Tailscale address. */
function isPrivateIpv4(address: string): boolean {
  const o = ipv4Octets(address);
  if (!o) return false;
  const [a, b] = o;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isLinkLocal(address: string, family: string): boolean {
  if (family === 'IPv4') return address.startsWith('169.254.');
  return address.toLowerCase().startsWith('fe80:');
}

/** One row of `os.networkInterfaces()`, narrowed to what the address rules read. */
export interface InterfaceAddress {
  address: string;
  family: string;
  internal: boolean;
}

/**
 * The addresses the server answers on, given the address it bound. A wildcard
 * bind (`0.0.0.0`, `::`) means every interface of that family — `::` on Node
 * accepts IPv4 too, so it lists both; a specific address means just that
 * address; loopback means none. The returned order is the order the QR and
 * the pairing record use, so the first entry has to be the one a phone on
 * the home wifi can reach.
 */
export function boundAddresses(host: string, interfaces: Record<string, InterfaceAddress[] | undefined>): string[] {
  if (isLoopbackHost(host)) return [];

  const all = Object.values(interfaces).flatMap((rows) => rows ?? [])
    .filter((row) => !row.internal && !isLinkLocal(row.address, row.family))
    // Drop an IPv6 zone suffix (`fe80::1%en0`); the link-local filter above
    // already removed most of these, but a scoped ULA would carry one too.
    .map((row) => ({ ...row, address: row.address.split('%')[0]! }));

  const wildcardV4 = host === '0.0.0.0';
  const wildcardV6 = host === '::';
  let chosen: InterfaceAddress[];
  if (wildcardV4) chosen = all.filter((row) => row.family === 'IPv4');
  else if (wildcardV6) chosen = all;
  else chosen = all.filter((row) => row.address === host.replace(/^\[|\]$/g, ''));

  const v4 = chosen.filter((row) => row.family === 'IPv4').map((row) => row.address);
  const v6 = chosen.filter((row) => row.family !== 'IPv4').map((row) => row.address);
  return [
    ...v4.filter(isPrivateIpv4),
    ...v4.filter((a) => !isPrivateIpv4(a)),
    ...v6,
  ].filter((address, index, list) => list.indexOf(address) === index);
}

export interface DescribeInput {
  instanceId: string;
  version: string;
  port: number;
  host: string;
  /** Defaults to the live table; tests pass their own. */
  interfaces?: Record<string, InterfaceAddress[] | undefined>;
  /** Defaults to `os.hostname()`, less the `.local` macOS appends to it. */
  name?: string;
}

export function describeInstance(input: DescribeInput): InstanceInfo {
  const interfaces = input.interfaces ?? (networkInterfaces() as Record<string, InterfaceAddress[] | undefined>);
  return {
    instanceId: input.instanceId,
    name: input.name ?? hostname().replace(/\.local$/i, ''),
    version: input.version,
    port: input.port,
    addresses: boundAddresses(input.host, interfaces),
    mdnsName: mdnsHostname(input.instanceId),
  };
}

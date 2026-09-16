/**
 * Which way in the page was reached, read off its hostname.
 *
 * When the server stops answering, the useful message is not "can't connect"
 * but the fix — and the fix depends on how this page got here. A Tailscale
 * address means "turn the VPN on"; a home-wifi address means "be on that
 * wifi, and the computer may be asleep"; the desktop app's own window means
 * the server process died and the shell is restarting it. Nothing here
 * decides *whether* the server is reachable — `ReconnectBanner` does that by
 * polling — this only chooses the words once it is not.
 *
 * Pure so it runs under `node --test` with the doc's nine examples.
 */

export type Reachability = 'tailnet' | 'lan' | 'local' | 'unknown';

/** The banner's text for each way in. The `lan` clause about the QR is Phase
 *  33's: a changed address is fixed by scanning the code on the computer again. */
export const REACHABILITY_MESSAGE: Record<Reachability, string> = {
  tailnet: "Can't reach your library. Turn on Tailscale and it will reconnect.",
  lan: "Can't reach your library. Be on your home wifi — the computer may be asleep, or its address may have changed; scan the QR code on it again.",
  local: 'The MTG Library server has stopped.',
  unknown: "Can't reach the MTG Library server. Is it running? Are you on its network?",
};

/** Four dotted decimal octets, or null. Rejects anything with a letter in it. */
function ipv4Octets(hostname: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number) as [number, number, number, number];
  return octets.every((o) => o <= 255) ? octets : null;
}

/**
 * Classifies `window.location.hostname` (or any hostname).
 *
 * - `100.64.0.0/10` is the CGNAT block Tailscale hands out; `*.ts.net` is a
 *   MagicDNS name. Tailscale's IPv6 range is `fd7a:115c:a1e0::/48`.
 * - RFC 1918 (`10/8`, `172.16/12`, `192.168/16`) and `*.local` (mDNS) are the
 *   home network. IPv6 link-local and other ULAs are read the same way.
 * - `localhost` and loopback are the desktop app's own window (Phase 32).
 *
 * Browsers report an IPv6 hostname in brackets (`[::1]`); those are stripped.
 */
export function classifyHost(hostname: string): Reachability {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'local';
  if (host === '::1') return 'local';

  const v4 = ipv4Octets(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return 'local';
    if (a === 100 && b >= 64 && b <= 127) return 'tailnet';
    if (a === 10) return 'lan';
    if (a === 172 && b >= 16 && b <= 31) return 'lan';
    if (a === 192 && b === 168) return 'lan';
    if (a === 169 && b === 254) return 'lan';
    return 'unknown';
  }

  if (host.endsWith('.ts.net')) return 'tailnet';
  if (host.endsWith('.local')) return 'lan';

  if (host.includes(':')) {
    if (host.startsWith('fd7a:115c:a1e0:')) return 'tailnet';
    if (/^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) return 'lan';
  }
  return 'unknown';
}

/** The banner's message for the page at `hostname`. */
export const reconnectMessage = (hostname: string): string =>
  REACHABILITY_MESSAGE[classifyHost(hostname)];

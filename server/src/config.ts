import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where the database and cached images live.
 *
 * `MTG_DATA_DIR` is what the systemd unit sets on the Linux host; the default
 * keeps a development run self-contained under the user's home directory.
 */
export function resolveDataDir(): string {
  const configured = process.env.MTG_DATA_DIR;
  if (configured && configured.length > 0) return resolve(configured);
  return join(homedir(), '.local', 'share', 'mtg-library');
}

export function resolvePort(): number {
  const configured = Number.parseInt(process.env.MTG_PORT ?? '', 10);
  return Number.isFinite(configured) ? configured : 8080;
}

/**
 * Bind address. Defaults to all interfaces so the Tailscale address works
 * without extra configuration; the server is never meant to be exposed
 * publicly, and Tailscale is the security perimeter.
 */
export function resolveHost(): string {
  return process.env.MTG_HOST ?? '0.0.0.0';
}

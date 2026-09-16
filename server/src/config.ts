import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * Phase 33. Whether to advertise this server on the local link over DNS-SD
 * (`_mtglibrary._tcp`) so a phone can find it after its address changes.
 * Off by default: the desktop shell sets it whenever its sharing toggle is
 * on, and a systemd install opts in through the unit file. The flag alone is
 * not enough — `discovery/advertise.ts` also refuses a loopback bind, because
 * advertising an address nobody else can reach is noise.
 */
export function resolveAdvertise(): boolean {
  return process.env.MTG_ADVERTISE === '1';
}

/**
 * The server's own version, from `server/package.json`, found by walking up
 * from this module the way `db/index.ts` finds `schema.sql` — so it works
 * from `src/` under tsx, from `dist/` under Node, and from the staged tree
 * inside the desktop app or the Docker image, all of which keep the file.
 * Read once; it cannot change while the process runs. The instance endpoint
 * reports it today, and the parked companion app's skew contract (Phase 35)
 * is meant to read it through this same function rather than the file again.
 */
let serverVersion: string | null = null;
export function resolveServerVersion(): string {
  if (serverVersion === null) {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(moduleDir, '..', 'package.json'), 'utf8')) as { version?: string };
    serverVersion = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  }
  return serverVersion;
}

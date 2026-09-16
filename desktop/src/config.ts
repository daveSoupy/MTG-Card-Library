/**
 * The shell's own settings — the handful of things the desktop app decides
 * that the server does not: which port it was given, whether it answers on
 * the LAN, whether the machine may sleep, whether it starts at login, and
 * which one-time notices have been shown.
 *
 * One JSON file under the app's userData directory, written atomically
 * (temp file + rename). The server's settings live in its own database and
 * are never touched from here.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname } from 'node:path';

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface DesktopConfig {
  /**
   * The port the server was last started on, or null before the first
   * launch. Remembered so phone bookmarks (and Phase 33's pairing record)
   * survive a relaunch: the port is the shell's to keep stable, not the
   * server's, which only ever sees `MTG_PORT`.
   */
  port: number | null;
  /**
   * "Allow other devices on this network." False binds `127.0.0.1`; true
   * binds `0.0.0.0`. Off by default — the server's own default of all
   * interfaces is right behind Tailscale and wrong on café wifi.
   */
  sharing: boolean;
  /**
   * "Keep this computer awake while sharing." Holds a powerSaveBlocker while
   * `sharing` is also on. Off by default: right for a desktop tower, wrong to
   * force on a laptop.
   */
  keepAwake: boolean;
  /** Registered as a login item. On by default — the app exists to be up. */
  launchAtLogin: boolean;
  /** The one-time "runs in the background" notice has been shown. */
  backgroundNoticeShown: boolean;
  /** The Windows firewall paragraph has been shown before the first sharing toggle. */
  firewallExplained: boolean;
  /** Last window position and size, restored on the next show. */
  windowBounds: WindowBounds | null;
}

export const DEFAULT_CONFIG: DesktopConfig = {
  port: null,
  sharing: false,
  keepAwake: false,
  launchAtLogin: true,
  backgroundNoticeShown: false,
  firewallExplained: false,
  windowBounds: null,
};

/** The server's own default; the first port tried when nothing is remembered. */
export const DEFAULT_PORT = 8080;
/** How far past the preferred port the search goes before giving up. */
const PORT_SEARCH_SPAN = 100;

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536;
}

function isBounds(value: unknown): value is WindowBounds {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  const optional = (v: unknown) => v === undefined || typeof v === 'number';
  return (
    typeof b.width === 'number' && typeof b.height === 'number' && b.width > 0 && b.height > 0 &&
    optional(b.x) && optional(b.y)
  );
}

/**
 * Parses the config file's text. Unknown keys are dropped, malformed values
 * fall back to their defaults, and unparseable JSON is the default config —
 * a corrupt file must never stop the app from launching.
 */
export function parseConfig(text: string | null): DesktopConfig {
  const config: DesktopConfig = { ...DEFAULT_CONFIG };
  if (!text) return config;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return config;
  }
  if (typeof raw !== 'object' || raw === null) return config;
  const r = raw as Record<string, unknown>;
  if (isPort(r.port)) config.port = r.port;
  for (const key of ['sharing', 'keepAwake', 'launchAtLogin', 'backgroundNoticeShown', 'firewallExplained'] as const) {
    if (typeof r[key] === 'boolean') config[key] = r[key];
  }
  if (isBounds(r.windowBounds)) config.windowBounds = r.windowBounds;
  return config;
}

export function readConfig(path: string): DesktopConfig {
  let text: string | null = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // First launch, or the file was removed; defaults apply.
  }
  return parseConfig(text);
}

export function writeConfig(path: string, config: DesktopConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

function answersOnLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * True if nothing is listening on `port` right now.
 *
 * Two probes, because a bind alone lies on macOS: with SO_REUSEADDR (which
 * Node sets) a bind to `127.0.0.1:8080` succeeds while another process holds
 * `*:8080`, and the new socket then shadows the old one on loopback — the
 * window would open on the wrong server. So: can we bind on the host we
 * mean to use, and does anything already answer a loopback connection.
 */
export async function isPortFree(port: number, host: string): Promise<boolean> {
  if (await answersOnLoopback(port)) return false;
  return canBind(port, host);
}

/**
 * The port to start the server on: the remembered one if it is still free,
 * else 8080, else the next free port above it. A remembered port that is
 * free is kept even when 8080 has come free again, because a port that
 * moves under a phone's bookmark is the thing being avoided.
 */
export async function choosePort(
  remembered: number | null,
  host: string,
  probe: (port: number, host: string) => Promise<boolean> = isPortFree,
): Promise<number> {
  if (remembered !== null && (await probe(remembered, host))) return remembered;
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_SEARCH_SPAN; port += 1) {
    if (port === remembered) continue;
    if (await probe(port, host)) return port;
  }
  throw new Error(`No free port between ${DEFAULT_PORT} and ${DEFAULT_PORT + PORT_SEARCH_SPAN - 1}`);
}

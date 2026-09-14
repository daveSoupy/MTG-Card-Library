/**
 * The message a failed sync reports.
 *
 * Node's fetch reports every kind of network failure — DNS, refused
 * connection, a timeout — as `TypeError: fetch failed`, with the reason on
 * `cause`. "fetch failed" is the text that used to reach the sync dialog, and
 * it names nothing a person can act on. This turns that family of errors into
 * one sentence that does, keeping the code (ENOTFOUND, ECONNREFUSED) on the
 * end for whoever is reading the server log alongside it. Anything else —
 * Scryfall answering with a 503, a bad bulk file, a database error — already
 * says what happened and passes through unchanged.
 */

export const SCRYFALL_UNREACHABLE =
  "Couldn't reach Scryfall — check the server's internet connection and try again.";

/** Error codes from `dns`, `net` and undici that all mean "no connection". */
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

interface ErrorLike { name?: unknown; message?: unknown; code?: unknown; cause?: unknown }

/** Walks `cause` links for the first recognisable network code. */
function networkCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 5) return null;
  const { code, cause } = error as ErrorLike;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return code;
  return networkCode(cause, depth + 1);
}

function isNetworkFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message, cause } = error as ErrorLike;
  if (name === 'TypeError' && (message === 'fetch failed' || message === 'Failed to fetch')) return true;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (cause && typeof cause === 'object') {
    const causeName = (cause as ErrorLike).name;
    if (causeName === 'AbortError' || causeName === 'TimeoutError') return true;
  }
  return false;
}

export function describeSyncFailure(error: unknown): string {
  const code = networkCode(error);
  if (code !== null || isNetworkFailure(error)) {
    return code === null ? SCRYFALL_UNREACHABLE : `${SCRYFALL_UNREACHABLE} (${code})`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

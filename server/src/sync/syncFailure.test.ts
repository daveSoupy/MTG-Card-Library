import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCRYFALL_UNREACHABLE, describeSyncFailure } from './syncFailure.ts';

test('the bare "fetch failed" TypeError reads as an unreachable Scryfall', () => {
  assert.equal(describeSyncFailure(new TypeError('fetch failed')), SCRYFALL_UNREACHABLE);
});

test('DNS, refused and timeout causes keep their code on the end', () => {
  const dns = new TypeError('fetch failed', {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.scryfall.com'), { code: 'ENOTFOUND' }),
  });
  assert.equal(describeSyncFailure(dns), `${SCRYFALL_UNREACHABLE} (ENOTFOUND)`);

  const refused = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
  assert.equal(describeSyncFailure(refused), `${SCRYFALL_UNREACHABLE} (ECONNREFUSED)`);

  const timeout = new TypeError('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  });
  assert.equal(describeSyncFailure(timeout), `${SCRYFALL_UNREACHABLE} (UND_ERR_CONNECT_TIMEOUT)`);

  // AbortSignal.timeout() rejects with a DOMException named TimeoutError.
  const signalTimeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(describeSyncFailure(signalTimeout), SCRYFALL_UNREACHABLE);
});

test('a failure that already explains itself passes through unchanged', () => {
  assert.equal(
    describeSyncFailure(new Error('Scryfall returned 503 for the bulk-data listing.')),
    'Scryfall returned 503 for the bulk-data listing.',
  );
  assert.equal(describeSyncFailure(new TypeError('Cannot read properties of undefined')),
    'Cannot read properties of undefined');
  assert.equal(describeSyncFailure('disk full'), 'disk full');
});

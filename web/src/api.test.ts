import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError, CONNECTIVITY_MESSAGE, fetchStatus, formatRecord, isConnectivityError,
  onServerUnreachable, probeHealth, startSync,
} from './api.ts';

/** How a record is written on a chip: "12–4", or "12–4–1" once there is a draw. */
test('a record reads as wins–losses, with draws only when there are some', () => {
  assert.equal(formatRecord({ wins: 12, losses: 4, draws: 0, games: 16 }), '12–4');
  assert.equal(formatRecord({ wins: 12, losses: 4, draws: 1, games: 17 }), '12–4–1');
  assert.equal(formatRecord({ wins: 0, losses: 0, draws: 0, games: 0 }), '0–0');
});

// ---------------------------------------------------------------------------
// Failure mapping. A stubbed global fetch stands in for the network; the
// question each case asks is what the page will be told, and whether it is
// allowed to fall back to its "nothing here yet" copy.

const realFetch = globalThis.fetch;
const withFetch = async (stub: typeof fetch, run: () => Promise<void>) => {
  globalThis.fetch = stub;
  try { await run(); } finally { globalThis.fetch = realFetch; }
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const text = (status: number, body: string) => new Response(body, { status });

const rejects = async (run: () => Promise<unknown>): Promise<ApiError> => {
  try { await run(); } catch (e) { return e as ApiError; }
  throw new Error('expected a rejection');
};

test('a fetch that never got a response is a connectivity error with the friendly text', async () => {
  await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
    const error = await rejects(() => fetchStatus());
    assert.ok(error instanceof ApiError);
    assert.equal(error.isConnectivity, true);
    assert.equal(error.status, null);
    assert.equal(error.message, CONNECTIVITY_MESSAGE);
    assert.equal(isConnectivityError(error), true);
  });
});

test('a 5xx with no server JSON body — the dev proxy, a gateway — is connectivity too', async () => {
  await withFetch(async () => text(500, 'Error occurred while trying to proxy: localhost:5174/api/v1/status'), async () => {
    const error = await rejects(() => fetchStatus());
    assert.equal(error.isConnectivity, true);
    assert.equal(error.status, 500);
    assert.equal(error.message, CONNECTIVITY_MESSAGE);
  });
  await withFetch(async () => text(502, '<html>502 Bad Gateway</html>'), async () => {
    const error = await rejects(() => fetchStatus());
    assert.equal(error.isConnectivity, true);
    assert.equal(error.message, CONNECTIVITY_MESSAGE);
  });
});

test('a 5xx the server itself sent keeps its message: the server was reached', async () => {
  await withFetch(async () => json(502, { error: 'Scryfall returned 503.' }), async () => {
    const error = await rejects(() => fetchStatus());
    assert.equal(error.isConnectivity, false);
    assert.equal(error.status, 502);
    assert.equal(error.message, 'Scryfall returned 503.');
  });
});

test('a 4xx is never connectivity, and reads the server error and detail', async () => {
  await withFetch(async () => json(404, { error: 'No such deck.', detail: 'Deck 9 was deleted.' }), async () => {
    const error = await rejects(() => fetchStatus());
    assert.equal(error.isConnectivity, false);
    assert.equal(error.message, 'No such deck. Deck 9 was deleted.');
  });
  await withFetch(async () => text(404, 'Not Found'), async () => {
    const error = await rejects(() => fetchStatus());
    assert.equal(error.isConnectivity, false);
    assert.equal(error.message, 'Request failed with status 404');
  });
});

test('an abort is the caller\'s own doing and passes through unmapped', async () => {
  // What a browser's fetch throws for an aborted request.
  const aborted = async () => { throw new DOMException('The user aborted a request.', 'AbortError'); };
  await withFetch(aborted, async () => {
    const error = await rejects(() => fetchStatus(new AbortController().signal));
    assert.equal(error.name, 'AbortError');
    assert.equal(isConnectivityError(error), false);
  });
});

test('writes map the same way as reads', async () => {
  await withFetch(async () => { throw new TypeError('Load failed'); }, async () => {
    const error = await rejects(() => startSync('oracle_cards'));
    assert.equal(error.isConnectivity, true);
    assert.equal(error.message, CONNECTIVITY_MESSAGE);
  });
  await withFetch(async () => json(409, { error: 'A sync is already running.' }), async () => {
    // 409 on the sync endpoint means "already running" and is not a failure.
    await startSync('oracle_cards');
  });
});

// ---------------------------------------------------------------------------
// Phase 31. The reconnect banner is raised from here, not from any page: each
// path that builds a connectivity error tells the listeners first.

test('every connectivity failure reports to onServerUnreachable; nothing else does', async () => {
  let raised = 0;
  const off = onServerUnreachable(() => { raised += 1; });
  try {
    await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
      await rejects(() => fetchStatus());
    });
    assert.equal(raised, 1, 'no response at all');
    await withFetch(async () => text(502, 'Bad Gateway'), async () => {
      await rejects(() => fetchStatus());
    });
    assert.equal(raised, 2, 'a gateway 5xx with no server body');
    await withFetch(async () => json(404, { error: 'No such endpoint.' }), async () => {
      await rejects(() => fetchStatus());
    });
    await withFetch(async () => json(500, { error: 'Something broke.' }), async () => {
      await rejects(() => fetchStatus());
    });
    assert.equal(raised, 2, 'the server answering, even with an error, is not unreachable');
    const controller = new AbortController();
    controller.abort();
    await withFetch(async () => { throw new DOMException('aborted', 'AbortError'); }, async () => {
      await rejects(() => fetchStatus(controller.signal));
    });
    assert.equal(raised, 2, 'an abort is the caller\'s doing');
  } finally {
    off();
  }
  await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
    await rejects(() => fetchStatus());
  });
  assert.equal(raised, 2, 'unsubscribed');
});

test('probeHealth answers true only for a healthy server, and never reports unreachable', async () => {
  let raised = 0;
  const off = onServerUnreachable(() => { raised += 1; });
  try {
    await withFetch(async () => json(200, { ok: true, dataDir: '/x' }), async () => {
      assert.equal(await probeHealth(), true);
    });
    await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
      assert.equal(await probeHealth(), false);
    });
    await withFetch(async () => text(502, 'Bad Gateway'), async () => {
      assert.equal(await probeHealth(), false);
    });
    await withFetch(async () => text(200, '<html>captive portal</html>'), async () => {
      assert.equal(await probeHealth(), false, 'a 200 that is not our JSON is not our server');
    });
    assert.equal(raised, 0);
  } finally {
    off();
  }
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHECK_INTERVAL_MS, manualCheckMessage, updateStatusLine, type UpdateState } from './updateState.ts';

describe('updateStatusLine', () => {
  it('says nothing when there is no news', () => {
    assert.equal(updateStatusLine({ kind: 'idle' }), null);
    assert.equal(updateStatusLine({ kind: 'up-to-date', checkedAt: 0 }), null);
    // An error is logged, never shown in the menu.
    assert.equal(updateStatusLine({ kind: 'error', message: 'ENOTFOUND' }), null);
  });

  it('names the version while downloading, with progress once known', () => {
    assert.equal(updateStatusLine({ kind: 'downloading', version: '1.2.0', percent: null }), 'Downloading 1.2.0…');
    assert.equal(updateStatusLine({ kind: 'downloading', version: '1.2.0', percent: 42.7 }), 'Downloading 1.2.0… 42%');
  });

  it('says a ready update waits for quit', () => {
    assert.equal(updateStatusLine({ kind: 'ready', version: '1.2.0' }), 'Update ready: 1.2.0 — applied when you quit');
  });
});

describe('manualCheckMessage', () => {
  it('reports up to date with the running version', () => {
    const { message, detail } = manualCheckMessage({ kind: 'up-to-date', checkedAt: 0 }, '1.0.0');
    assert.equal(message, "You're up to date");
    assert.match(detail, /1\.0\.0/);
  });

  it('reports downloading and ready with the new version', () => {
    assert.match(manualCheckMessage({ kind: 'downloading', version: '1.2.0', percent: 5 }, '1.0.0').message, /1\.2\.0/);
    assert.match(manualCheckMessage({ kind: 'ready', version: '1.2.0' }, '1.0.0').detail, /Restart to update/);
  });

  it('passes the error through', () => {
    const state: UpdateState = { kind: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' };
    assert.equal(manualCheckMessage(state, '1.0.0').detail, 'net::ERR_INTERNET_DISCONNECTED');
  });
});

describe('CHECK_INTERVAL_MS', () => {
  it('is one day', () => {
    assert.equal(CHECK_INTERVAL_MS, 86_400_000);
  });
});

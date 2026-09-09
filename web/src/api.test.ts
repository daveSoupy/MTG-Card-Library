import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRecord } from './api.ts';

/** How a record is written on a chip: "12–4", or "12–4–1" once there is a draw. */
test('a record reads as wins–losses, with draws only when there are some', () => {
  assert.equal(formatRecord({ wins: 12, losses: 4, draws: 0, games: 16 }), '12–4');
  assert.equal(formatRecord({ wins: 12, losses: 4, draws: 1, games: 17 }), '12–4–1');
  assert.equal(formatRecord({ wins: 0, losses: 0, draws: 0, games: 0 }), '0–0');
});

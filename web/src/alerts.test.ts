import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Alert } from './api.ts';
import { alertKindLabel, alertRoute, groupByKind } from './alerts.ts';

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: 1, kind: 'allocation_conflict', state: 'active', subjectType: null, subjectId: null,
  title: 'Title', message: null, payload: null, createdAt: '', acknowledgedAt: null,
  ...over,
});

test('an allocation_conflict alert links to the card in Browse', () => {
  const route = alertRoute(alert({ payload: { name: 'Sol Ring', oracleId: 'x' } }));
  assert.deepEqual(route, { name: 'browse', q: 'Sol Ring' });
});

test('an allocation_conflict alert with no name on its payload links nowhere', () => {
  assert.equal(alertRoute(alert({ payload: {} })), null);
  assert.equal(alertRoute(alert({ payload: null })), null);
});

test('want_fulfilled and price_target point at the wants tab', () => {
  assert.deepEqual(alertRoute(alert({ kind: 'want_fulfilled' })), { name: 'collection', tab: 'wants' });
  assert.deepEqual(alertRoute(alert({ kind: 'price_target' })), { name: 'collection', tab: 'wants' });
});

test('trade_list_clamped points at the trade-lists tab', () => {
  assert.deepEqual(alertRoute(alert({ kind: 'trade_list_clamped' })), { name: 'collection', tab: 'tradelists' });
});

test('an unknown kind links nowhere rather than guessing', () => {
  assert.equal(alertRoute(alert({ kind: 'something_new' })), null);
});

test('alertKindLabel falls back to the raw kind for anything unlabelled', () => {
  assert.equal(alertKindLabel('allocation_conflict'), 'Deck conflicts');
  assert.equal(alertKindLabel('mystery_kind'), 'mystery_kind');
});

test('groupByKind buckets by kind, in a stable kind order, each bucket in list order', () => {
  const alerts = [
    alert({ id: 1, kind: 'price_target' }),
    alert({ id: 2, kind: 'allocation_conflict' }),
    alert({ id: 3, kind: 'allocation_conflict' }),
    alert({ id: 4, kind: 'want_fulfilled' }),
  ];
  const groups = groupByKind(alerts);
  assert.deepEqual(groups.map((g) => g.kind), ['allocation_conflict', 'price_target', 'want_fulfilled']);
  assert.deepEqual(groups[0].alerts.map((a) => a.id), [2, 3]);
});

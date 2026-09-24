import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TradesPage } from './TradesPage.tsx';
import type { Trade, TradeItem, TradeSummary } from '../api.ts';

const trade = (id: number, name: string, status: TradeSummary['status'] = 'completed'): TradeSummary => ({
  id, counterpartyName: name, counterpartyContact: null, status, tradeDate: '2026-01-01',
  completedAt: status === 'completed' ? '2026-01-01T00:00:00Z' : null, locationNote: null, notes: null,
  valueOutUsd: 10, valueInUsd: 12, createdAt: '', updatedAt: '',
});

const item = (over: Partial<TradeItem>): TradeItem => ({
  id: 1, direction: 'out', printingId: 'p1', oracleId: 'o1', name: 'Card',
  setCode: 'tst', collectorNumber: '1', manaCost: null, quantity: 1, ownedQuantity: 0,
  finish: 'nonfoil', condition: 'NM', language: 'en', sourceCollectionItemId: null,
  destinationLocationId: null, unitValueUsd: null, marketUsd: null, imageSmall: null, notes: null,
  ...over,
});

const api = vi.hoisted(() => ({
  fetchTrades: vi.fn(),
  fetchTrade: vi.fn(),
  fetchLocations: vi.fn(),
}));
vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  fetchTrades: api.fetchTrades,
  fetchTrade: api.fetchTrade,
  fetchLocations: api.fetchLocations,
}));

describe('TradesPage log', () => {
  beforeEach(() => {
    api.fetchTrades.mockImplementation(async (params: { q?: string }) => {
      const all = [trade(1, 'Alex'), trade(2, 'Bo'), trade(3, 'Alex', 'cancelled')];
      const trades = all.filter((t) => !params.q || t.counterpartyName.toLowerCase().includes(params.q.toLowerCase()));
      const completed = trades.filter((t) => t.status === 'completed');
      return {
        trades,
        totals: {
          count: trades.length, completedCount: completed.length,
          valueOutUsd: 10 * completed.length, valueInUsd: 12 * completed.length, unvaluedCount: 0,
        },
      };
    });
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('searches by person on the server and shows its totals for the match', async () => {
    render(<TradesPage openId={null} onOpen={() => {}} />);
    expect(await screen.findByText(/3 trades · 2 completed · gave \$20\.00 · got \$24\.00/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find trades by person' }), { target: { value: 'alex' } });
    await waitFor(() => expect(api.fetchTrades).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'alex', sort: 'date' }), expect.anything(),
    ));
    expect(await screen.findByText(/2 trades · 1 completed · gave \$10\.00 · got \$12\.00/)).toBeInTheDocument();
    expect(screen.queryByText('Bo')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'person' } });
    await waitFor(() => expect(api.fetchTrades).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'person' }), expect.anything(),
    ));
  });

  it('a history row shows the trade date, not the UTC instant it was recorded complete', async () => {
    // Traded the evening of the 20th, recorded complete after midnight UTC on
    // the 23rd — the row must read the 20th, not the 23rd.
    const evening: TradeSummary = {
      ...trade(4, 'Casey', 'completed'),
      tradeDate: '2026-08-20', completedAt: '2026-09-23T02:00:00Z',
    };
    api.fetchTrades.mockResolvedValue({
      trades: [evening],
      totals: { count: 1, completedCount: 1, valueOutUsd: 10, valueInUsd: 12, unvaluedCount: 0 },
    });
    render(<TradesPage openId={null} onOpen={() => {}} />);
    expect(await screen.findByText('2026-08-20')).toBeInTheDocument();
    expect(screen.queryByText('2026-09-23')).toBeNull();
  });
});

describe('TradeEditor', () => {
  beforeEach(() => {
    api.fetchLocations.mockResolvedValue([]);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('a completed trade shows its date, location/notes, a balance, and no stale ownership flag', async () => {
    const completed: Trade = {
      ...trade(1, 'Alex', 'completed'),
      locationNote: 'FNM at the shop', notes: 'Good trader, would deal again',
      items: [
        item({ id: 1, direction: 'out', name: 'Lightning Bolt', unitValueUsd: 2.5, quantity: 2, ownedQuantity: 0 }),
        item({ id: 2, direction: 'in', name: 'Tarmogoyf', unitValueUsd: 30, quantity: 1 }),
      ],
    };
    api.fetchTrade.mockResolvedValue(completed);

    render(<TradesPage openId={1} onOpen={() => {}} />);
    await screen.findByText('Alex');

    expect(screen.getByText('2026-01-01')).toBeInTheDocument();
    expect(screen.getByText(/FNM at the shop/)).toBeInTheDocument();
    expect(screen.getByText(/Good trader, would deal again/)).toBeInTheDocument();
    // Received $30, gave $5 — up $25.
    expect(screen.getByText("You're up $25.00")).toBeInTheDocument();
    // ownedQuantity is 0 today for the outgoing card, but the trade is done —
    // no "only own 0" flag, and no live ownership count at all.
    expect(screen.queryByText(/only own/)).toBeNull();
    expect(screen.queryByText(/^own /)).toBeNull();
  });

  it('a draft trade shows a balance too, as a lower bound when a line is unpriced', async () => {
    const draft: Trade = {
      ...trade(2, 'Bo', 'draft'),
      valueOutUsd: null, valueInUsd: null,
      items: [
        item({ id: 1, direction: 'out', name: 'Lightning Bolt', unitValueUsd: 2, quantity: 1, ownedQuantity: 4 }),
        item({ id: 2, direction: 'in', name: 'Brainstorm', unitValueUsd: null, quantity: 1 }),
      ],
    };
    api.fetchTrade.mockResolvedValue(draft);

    render(<TradesPage openId={2} onOpen={() => {}} />);
    await screen.findByText(/Add outgoing card/);

    // 0 (unpriced treated as 0) - 2 = down $2, with a caveat.
    expect(screen.getByText(/You're down \$2\.00/)).toBeInTheDocument();
    expect(screen.getByText(/1 line unpriced, so this is a lower bound/)).toBeInTheDocument();
    // A draft's ownership is still live and relevant.
    expect(screen.getByText('own 4')).toBeInTheDocument();
  });
});

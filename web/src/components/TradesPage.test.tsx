import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TradesPage } from './TradesPage.tsx';
import type { TradeSummary } from '../api.ts';

const trade = (id: number, name: string, status: TradeSummary['status'] = 'completed'): TradeSummary => ({
  id, counterpartyName: name, counterpartyContact: null, status, tradeDate: '2026-01-01',
  completedAt: status === 'completed' ? '2026-01-01T00:00:00Z' : null, locationNote: null, notes: null,
  valueOutUsd: 10, valueInUsd: 12, createdAt: '', updatedAt: '',
});

const api = vi.hoisted(() => ({ fetchTrades: vi.fn() }));
vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  fetchTrades: api.fetchTrades,
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
});

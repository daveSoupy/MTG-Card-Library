import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CollectionValuePanel } from './CollectionValuePanel.tsx';
import type { CollectionValue } from '../api.ts';

describe('CollectionValuePanel', () => {
  it('renders without crashing and shows the market value stat', () => {
    const value: CollectionValue = {
      value: {
        total_value_usd: 123.45, total_cost_basis_usd: 100, unrealized_gain_usd: 23.45,
        total_cards: 42, cost_known_cards: 10,
      },
      history: [
        { captured_on: '2026-09-01', total_value_usd: 100, total_cost_basis_usd: 90, realized_gain_to_date_usd: 0, total_cards: 40, distinct_cards: 20 },
        { captured_on: '2026-09-07', total_value_usd: 123.45, total_cost_basis_usd: 100, realized_gain_to_date_usd: 0, total_cards: 42, distinct_cards: 21 },
      ],
    };

    render(<CollectionValuePanel value={value} />);

    expect(screen.getByText('$123.45')).toBeInTheDocument();
    expect(screen.getByText('market value')).toBeInTheDocument();
  });

  it('falls back gracefully with no value loaded yet', () => {
    render(<CollectionValuePanel value={null} />);
    expect(screen.getByText('market value')).toBeInTheDocument();
  });
});

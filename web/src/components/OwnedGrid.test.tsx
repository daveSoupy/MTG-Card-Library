import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OwnedGrid } from './OwnedGrid.tsx';
import type { CollectionCard } from '../api.ts';

const card: CollectionCard = {
  oracleId: 'ORACLE-1', name: 'Lightning Bolt', manaCost: '{R}', cmc: 1,
  typeLine: 'Instant', colorIdentity: 'R', ownedQuantity: 3, allocatedQuantity: 0,
  availableQuantity: 3, valueUsd: 4.5, costUsd: null, gainUsd: null,
  printingCount: 1, locationCount: 1, lotCount: 1, printingId: 'PRINT-1',
  finish: 'nonfoil', setCode: 'lea', setName: 'Limited Edition Alpha',
  collectorNumber: '161', imageSmall: null,
};

describe('OwnedGrid', () => {
  it('renders a tile per card and calls onSelect when tapped', () => {
    const onSelect = vi.fn();
    render(<OwnedGrid cards={[card]} selected={null} onSelect={onSelect} />);

    const tile = screen.getByTitle(/Lightning Bolt/);
    fireEvent.click(tile);

    expect(onSelect).toHaveBeenCalledWith(card);
  });
});

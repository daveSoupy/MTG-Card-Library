import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeckTile } from './DeckTile.tsx';
import type { DeckCard } from '../api.ts';

const card: DeckCard = {
  id: 1, oracleId: 'ORACLE-1', name: 'Sol Ring', board: 'main', quantity: 2,
  quantityFromCollection: 1, commanderRole: null, cmc: 1, typeLine: 'Artifact',
  manaCost: '{1}', colorIdentity: '', isBasicLand: false, canBeCommander: false,
  category: null, producedMana: [], partnerKind: null, legality: null,
  ownedQuantity: 1, availableQuantity: 1, printingId: null, setCode: 'cmr',
  rarity: 'uncommon', imageSmall: null, priceUsd: 2,
};

describe('DeckTile', () => {
  it('renders the quantity and reports a removal', () => {
    const onRemove = vi.fn();
    render(<DeckTile card={card} problem={null} onQuantity={() => {}} onArt={() => {}} onRemove={onRemove} />);

    expect(screen.getByText('2')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove Sol Ring'));
    expect(onRemove).toHaveBeenCalled();
  });
});

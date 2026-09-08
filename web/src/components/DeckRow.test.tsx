import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeckRow } from './DeckRow.tsx';
import type { DeckCard } from '../api.ts';

const card: DeckCard = {
  id: 1, oracleId: 'ORACLE-1', name: 'Sol Ring', board: 'main', quantity: 1,
  quantityFromCollection: 1, commanderRole: null, cmc: 1, typeLine: 'Artifact',
  manaCost: '{1}', colorIdentity: '', isBasicLand: false, canBeCommander: false,
  category: null, producedMana: [], partnerKind: null, legality: null,
  ownedQuantity: 1, availableQuantity: 1, printingId: 'PRINT-1', setCode: 'cmr',
  rarity: 'uncommon', imageSmall: null, priceUsd: 2,
};

describe('DeckRow', () => {
  it('renders the card name and reports a quantity bump', () => {
    const onQuantity = vi.fn();
    render(
      <DeckRow
        card={card}
        problem={null}
        onQuantity={onQuantity}
        onBoard={() => {}}
        onRemove={() => {}}
        onToggleOwned={() => {}}
        onPreview={() => {}}
        onArt={() => {}}
      />,
    );

    expect(screen.getByText('Sol Ring')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('One more Sol Ring'));
    expect(onQuantity).toHaveBeenCalledWith(1);
  });
});

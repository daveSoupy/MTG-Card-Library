import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeckRow } from './DeckRow.tsx';
import type { DeckCard } from '../api.ts';

const labels = { removal: 'Removal', draw: 'Card draw', sweeper: 'Board wipes' };

const card: DeckCard = {
  id: 1, oracleId: 'ORACLE-1', name: 'Sol Ring', board: 'main', quantity: 1,
  quantityFromCollection: 1, commanderRole: null, categories: [], cmc: 1, typeLine: 'Artifact',
  manaCost: '{1}', colorIdentity: '', isBasicLand: false, canBeCommander: false,
  category: null, producedMana: [], partnerKind: null, legality: null,
  ownedQuantity: 1, availableQuantity: 1, printingId: 'PRINT-1', setCode: 'cmr',
  rarity: 'uncommon', imageSmall: null, priceUsd: 2,
};

function row(overrides: Partial<DeckCard> = {}, onQuantity = vi.fn()) {
  const view = render(
    <DeckRow
      card={{ ...card, ...overrides }}
      problem={null}
      onQuantity={onQuantity}
      onBoard={() => {}}
      onRemove={() => {}}
      onToggleOwned={() => {}}
      onPreview={() => {}}
      onArt={() => {}}
      categoryLabels={labels}
    />,
  );
  return { ...view, onQuantity };
}

describe('DeckRow', () => {
  it('renders the card name and reports a quantity bump', () => {
    const { onQuantity } = row();
    expect(screen.getByText('Sol Ring')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('One more Sol Ring'));
    expect(onQuantity).toHaveBeenCalledWith(1);
  });

  it('shows what the card is counted as, beside the name', () => {
    const { container } = row({ categories: ['removal', 'draw'] });
    // Labelled by the server's names, not the raw keys.
    expect(container.querySelector('.deck-name-tags')?.textContent).toBe('Card draw, Removal');
  });

  it('shows a manual override instead of the tags it replaces', () => {
    // The override replaces the tags for counting, so showing the tags here
    // would say the card is something the template rows disagree with.
    const { container } = row({ categories: ['removal'], category: 'Ramp, Board wipes' });
    expect(container.querySelector('.deck-name-tags')?.textContent).toBe('Ramp, Board wipes');
  });

  it('says nothing at all when a card has no categories', () => {
    const { container } = row({ categories: [], category: null });
    expect(container.querySelector('.deck-name-tags')).toBeNull();
  });

  it('has no category control left to set one with', () => {
    // Categories are read here now: resolved by the sync, not filled in per card.
    const { container } = row({ categories: ['removal'] });
    expect(container.querySelector('.category-picker, select[aria-label^="Categor"]')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeckRow } from './DeckRow.tsx';
import type { DeckCard } from '../api.ts';

const labels = { removal: 'Removal', draw: 'Card draw', sweeper: 'Board wipes' };

const card: DeckCard = {
  id: 1, oracleId: 'ORACLE-1', name: 'Sol Ring', board: 'main', quantity: 1,
  quantityFromCollection: 1, quantityProxied: 0, commanderRole: null, categories: [],
  cmc: 1, typeLine: 'Artifact',
  manaCost: '{1}', colorIdentity: '', isBasicLand: false, canBeCommander: false,
  category: null, producedMana: [], partnerKind: null, legality: null,
  ownedQuantity: 1, availableQuantity: 1, tradeListedQuantity: 0, allocationTracked: true,
  printingId: 'PRINT-1', setCode: 'cmr',
  rarity: 'uncommon', imageSmall: null, priceUsd: 2,
};

function row(
  overrides: Partial<DeckCard> = {},
  onQuantity = vi.fn(),
) {
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

  // The proxy stepper is parked, not deleted: `quantity_proxied` still rides
  // through the API and still counts as covered. See CLAUDE.md.
  it('offers no proxy control', () => {
    const { container } = row({ quantity: 4, quantityFromCollection: 1 });
    expect(container.querySelector('.proxy-step')).toBeNull();
    expect(screen.queryByLabelText('One more proxy of Sol Ring')).toBeNull();
  });

  it('renders an exempt basic land with no owned badge at all', () => {
    // A blank badge beats a wrong one: basics are outside allocation entirely.
    const { container } = row({
      name: 'Sol Ring', isBasicLand: true, allocationTracked: false,
      quantity: 38, quantityFromCollection: 0, ownedQuantity: 0, availableQuantity: 0,
    });
    expect(container.querySelector('.owned-chip.untracked')?.textContent).toBe('basic');
  });

  it('says why a card you own is not available, rather than just that it is not', () => {
    const { container } = row({
      quantity: 1, quantityFromCollection: 0,
      ownedQuantity: 1, availableQuantity: 0, tradeListedQuantity: 1,
    });
    expect(container.querySelector('.owned-chip')?.getAttribute('title'))
      .toContain('1 on a trade list');
  });

  it('has no category control left to set one with', () => {
    // Categories are read here now: resolved by the sync, not filled in per card.
    const { container } = row({ categories: ['removal'] });
    expect(container.querySelector('.category-picker, select[aria-label^="Categor"]')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeckTile } from './DeckTile.tsx';
import type { DeckCard } from '../api.ts';

const card: DeckCard = {
  id: 1, oracleId: 'ORACLE-1', name: 'Sol Ring', board: 'main', quantity: 2,
  quantityFromCollection: 1, commanderRole: null, categories: [], cmc: 1, typeLine: 'Artifact',
  manaCost: '{1}', colorIdentity: '', isBasicLand: false, canBeCommander: false,
  category: null, producedMana: [], partnerKind: null, legality: null,
  ownedQuantity: 1, availableQuantity: 1, printingId: null, setCode: 'cmr',
  rarity: 'uncommon', imageSmall: null, priceUsd: 2,
};

describe('DeckTile', () => {
  const tileOf = (element: HTMLElement) => element.closest('.deck-tile') as HTMLElement;

  it('renders the quantity and reports a removal', () => {
    const onRemove = vi.fn();
    render(<DeckTile card={card} problem={null} onQuantity={() => {}} onArt={() => {}} onRemove={onRemove} />);

    expect(screen.getByText('2')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove Sol Ring'));
    expect(onRemove).toHaveBeenCalled();
  });

  it('reveals its controls on a tap, with no hover first, and hides them again', () => {
    render(<DeckTile card={card} problem={null} onQuantity={() => {}} onArt={() => {}} onRemove={() => {}} />);
    const tile = tileOf(screen.getByLabelText('Remove Sol Ring'));

    // Hover is the desktop path and never fires on a touch screen; the class
    // is what the stylesheet keys the controls open on.
    expect(tile.className).not.toContain('controls-open');

    fireEvent.click(tile);
    expect(tile.className).toContain('controls-open');

    // A tap on a control works the control rather than closing the menu, so a
    // stepper can be pressed more than once.
    fireEvent.click(screen.getByLabelText('One more Sol Ring'));
    expect(tile.className).toContain('controls-open');

    // Tapping elsewhere dismisses it.
    fireEvent.click(document.body);
    expect(tile.className).not.toContain('controls-open');
  });

  it('toggles closed when the tile itself is tapped again', () => {
    render(<DeckTile card={card} problem={null} onQuantity={() => {}} onArt={() => {}} onRemove={() => {}} />);
    const tile = tileOf(screen.getByLabelText('Remove Sol Ring'));

    fireEvent.click(tile);
    fireEvent.click(tile);
    expect(tile.className).not.toContain('controls-open');
  });
});

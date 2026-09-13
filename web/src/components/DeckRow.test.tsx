import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeckRow } from './DeckRow.tsx';
import type { BuildabilityRow, DeckCard } from '../api.ts';

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
  extra: { coverage?: BuildabilityRow | null; onSwap?: () => void } = {},
) {
  const view = render(
    <DeckRow
      card={{ ...card, ...overrides }}
      problem={null}
      onQuantity={onQuantity}
      onBoard={() => {}}
      onRemove={() => {}}
      onPreview={() => {}}
      onArt={() => {}}
      categoryLabels={labels}
      {...extra}
    />,
  );
  return { ...view, onQuantity };
}

const short: BuildabilityRow = {
  oracleId: 'ORACLE-1', name: 'Sol Ring', required: 1, owned: 0, available: 0, tradeListed: 0,
  proxied: 0, covered: 0, missing: 1, unitPriceUsd: 2, extendedUsd: 2, contested: false,
  holdingDecks: [],
};

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

  // The claim is the server's business now; there is nothing here to set it
  // with, and nothing that reports it as though it were ownership.
  it('offers no way to claim the card, and never says "owned"', () => {
    const { container } = row({ quantity: 1, quantityFromCollection: 1, ownedQuantity: 0 });
    expect(container.querySelector('.owned-chip')).toBeNull();
    expect(container.querySelector('button.slot-chip')).toBeNull();
    expect(container.textContent).not.toContain('owned');
  });

  it('renders an exempt basic land as just "basic"', () => {
    // A blank badge beats a wrong one: basics are outside allocation entirely.
    const { container } = row({
      name: 'Sol Ring', isBasicLand: true, allocationTracked: false,
      quantity: 38, quantityFromCollection: 0, ownedQuantity: 0, availableQuantity: 0,
    });
    const chip = container.querySelector('.slot-chip');
    expect(chip?.textContent).toBe('basic');
    expect(chip?.getAttribute('data-kind')).toBe('untracked');
  });

  // Phase 27. The chip is a label until a host offers a way to act on it;
  // then a "Buy" is also the door to what you already own.
  it('a Buy chip is a button only when a swap is offered, and never for a card you have', () => {
    const onSwap = vi.fn();
    const { container, unmount } = row({}, vi.fn(), { coverage: short, onSwap });
    const chip = container.querySelector('button.slot-chip')!;
    expect(chip?.textContent).toBe('Buy 1');
    expect(chip.getAttribute('title')).toContain('swap for something you own');
    fireEvent.click(chip);
    expect(onSwap).toHaveBeenCalledTimes(1);
    unmount();

    const plain = row({}, vi.fn(), { coverage: short });
    expect(plain.container.querySelector('button.slot-chip')).toBeNull();
    expect(plain.container.querySelector('span.slot-chip')?.textContent).toBe('Buy 1');
    plain.unmount();

    const have = row({}, vi.fn(), {
      coverage: { ...short, owned: 1, available: 1, covered: 1, missing: 0 }, onSwap,
    });
    expect(have.container.querySelector('button.slot-chip')).toBeNull();
    expect(have.container.querySelector('span.slot-chip')?.textContent).toBe('Have it');
  });

  it('stays blank until the deck figures arrive, rather than guessing', () => {
    const { container } = row({ quantity: 1 });   // no coverage passed
    expect(container.querySelector('.slot-chip')).toBeNull();
  });

  it('shows the mana value and a dot per coloured pip, not the raw symbols', () => {
    const { container } = row({ manaCost: '{3}{W}{W}', cmc: 5 });
    const mana = container.querySelector('.mana');
    expect(mana?.querySelector('.mv')?.textContent).toBe('5');
    expect(mana?.querySelectorAll('.mana-dot')).toHaveLength(2);
    expect(container.textContent).not.toContain('{');
    // Nothing is lost — the printed cost is one hover away.
    expect(mana?.getAttribute('title')).toBe('{3}{W}{W}');
  });

  it('has no category control left to set one with', () => {
    // Categories are read here now: resolved by the sync, not filled in per card.
    const { container } = row({ categories: ['removal'] });
    expect(container.querySelector('.category-picker, select[aria-label^="Categor"]')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

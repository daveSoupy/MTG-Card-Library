import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BuildabilityBar, BuildabilityStrip } from './Buildability.tsx';
import { DeckTile } from './DeckTile.tsx';
import type { BuildabilityRow, DeckBuildability, DeckCard } from '../api.ts';

const figures = (over: Partial<DeckBuildability> = {}): DeckBuildability => ({
  deckId: 1,
  buildablePct: 0.94,
  requiredCards: 100,
  coveredCards: 94,
  missingCards: 6,
  costToCompleteUsd: 23,
  unpricedCount: 0,
  contestedCount: 0,
  ...over,
});

const card: DeckCard = {
  id: 1, oracleId: 'ORACLE-1', name: 'Sol Ring', board: 'main', quantity: 3,
  quantityFromCollection: 1, quantityProxied: 0, commanderRole: null, categories: [],
  cmc: 1, typeLine: 'Artifact',
  manaCost: '{1}', colorIdentity: '', isBasicLand: false, canBeCommander: false,
  category: null, producedMana: [], partnerKind: null, legality: null,
  ownedQuantity: 1, availableQuantity: 1, tradeListedQuantity: 0, allocationTracked: true,
  printingId: null, setCode: 'cmr', rarity: 'uncommon', imageSmall: null, priceUsd: 2,
};

const coverage: BuildabilityRow = {
  oracleId: 'ORACLE-1', name: 'Sol Ring', required: 3, owned: 1, available: 1,
  tradeListed: 0, proxied: 0, covered: 1, missing: 2, unitPriceUsd: 2, extendedUsd: 4,
  contested: true,
  holdingDecks: [{ deckId: 2, deckName: 'Atraxa', status: 'assembled', quantity: 1 }],
};

describe('BuildabilityBar', () => {
  const barOf = () => document.querySelector('.build-bar > span') as HTMLElement;

  it('shows the percentage, the missing count and the cost', () => {
    render(<BuildabilityBar figures={figures()} />);
    expect(screen.getByText('94%')).toBeInTheDocument();
    expect(screen.getByText('6 missing')).toBeInTheDocument();
    expect(screen.getByText('$23')).toBeInTheDocument();
    expect(barOf().style.width).toBe('94%');
  });

  it('says an empty deck is empty rather than drawing a full bar', () => {
    render(<BuildabilityBar figures={figures({
      buildablePct: null, requiredCards: 0, coveredCards: 0, missingCards: 0,
    })} />);
    expect(screen.getByText(/Empty/)).toBeInTheDocument();
    expect(document.querySelector('.build-bar')).toBeNull();
  });

  it('carries the unpriced count beside the total instead of hiding it', () => {
    render(<BuildabilityBar figures={figures({ unpricedCount: 2 })} />);
    expect(screen.getByText('$23 + 2 unpriced')).toBeInTheDocument();
  });

  it('renders nothing at all when the figures have not arrived', () => {
    const { container } = render(<BuildabilityBar figures={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('BuildabilityStrip', () => {
  it('makes the missing segment tap through', () => {
    const onShowMissing = vi.fn();
    render(<BuildabilityStrip figures={figures()} onShowMissing={onShowMissing} />);

    fireEvent.click(screen.getByText('6 missing'));
    expect(onShowMissing).toHaveBeenCalled();
  });

  it('leaves the percentage itself inert', () => {
    render(<BuildabilityStrip figures={figures()} onShowMissing={() => {}} />);
    expect(screen.getByText('94%').tagName).toBe('SPAN');
  });
});

describe('the action chip on a deck tile', () => {
  const tile = (over: Partial<typeof coverage> = {}) => render(
    <DeckTile
      card={card}
      problem={null}
      onQuantity={() => {}}
      onArt={() => {}}
      onRemove={() => {}}
      coverage={{ ...coverage, ...over }}
    />,
  );

  it('names the deck holding the copies, because that is a decision not a purchase', () => {
    tile();
    const chip = screen.getByText('Atraxa has 1');
    expect(chip.getAttribute('data-kind')).toBe('held');
    expect(chip.getAttribute('title')).toMatch(/Take them back, or buy 2/);
  });

  it('says what to buy when nobody else has it', () => {
    tile({ holdingDecks: [], owned: 0, covered: 0, missing: 3 });
    expect(screen.getByText('Buy 3').getAttribute('data-kind')).toBe('buy');
  });

  it('counts only the shortfall when some copies are already yours', () => {
    tile({ holdingDecks: [], owned: 1, available: 1, covered: 1, missing: 2 });
    expect(screen.getByText('Buy 2 of 3')).toBeInTheDocument();
  });

  it('reads as done when the deck can field the card', () => {
    tile({ holdingDecks: [], owned: 3, available: 3, covered: 3, missing: 0 });
    const chip = screen.getByText('Have all 3');
    expect(chip.getAttribute('data-kind')).toBe('have');
  });

  it('shows nothing at all until the figures arrive', () => {
    render(
      <DeckTile card={card} problem={null} onQuantity={() => {}} onArt={() => {}}
                onRemove={() => {}} />,
    );
    expect(document.querySelector('.tile-chip')).toBeNull();
  });
});

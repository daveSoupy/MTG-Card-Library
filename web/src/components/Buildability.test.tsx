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

describe('the coverage chip on a deck slot', () => {
  it('appears only when the slot is short, and names who holds the rest', () => {
    render(
      <DeckTile
        card={card}
        problem={null}
        onQuantity={() => {}}
        onArt={() => {}}
        onRemove={() => {}}
        coverage={coverage}
      />,
    );
    const chip = screen.getByText('1/3');
    expect(chip).toBeInTheDocument();
    expect(chip.getAttribute('title')).toMatch(/Held by Atraxa x1/);
  });

  it('stays out of the way on a covered slot', () => {
    render(
      <DeckTile
        card={card}
        problem={null}
        onQuantity={() => {}}
        onArt={() => {}}
        onRemove={() => {}}
        coverage={{ ...coverage, covered: 3, missing: 0 }}
      />,
    );
    expect(document.querySelector('.tile-short')).toBeNull();
  });
});

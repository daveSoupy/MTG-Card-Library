import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeckPanes, type DeckPickerState } from './DeckPanes.tsx';
import type { Deck, DeckCard } from '../api.ts';

const card: DeckCard = {
  id: 1, oracleId: 'ORACLE-1', name: 'Sol Ring', board: 'main', quantity: 1,
  quantityFromCollection: 1, quantityProxied: 0, commanderRole: null, categories: [],
  cmc: 1, typeLine: 'Artifact',
  manaCost: '{1}', colorIdentity: '', isBasicLand: false, canBeCommander: false,
  category: null, producedMana: [], partnerKind: null, legality: null,
  ownedQuantity: 1, availableQuantity: 1, tradeListedQuantity: 0, allocationTracked: true, printingId: null, setCode: 'cmr',
  rarity: 'uncommon', imageSmall: null, priceUsd: 2,
};

const deck: Deck = {
  id: 1, name: 'Test Deck', formatCode: null, description: null, notes: null,
  status: 'brew', statusChangedAt: null,
  isArchived: false, createdAt: '', updatedAt: '', templateId: null, cards: [card],
  validation: {
    formatCode: null, formatName: null, commanderIdentity: null, countedTotal: 1,
    mainCount: 1, sideboardCount: 0, commandCount: 0, maybeCount: 0,
    requiredExactSize: null, requiredMinSize: null, sideboardLimit: null,
    issues: [], isLegal: true,
  },
  stats: {
    totalCards: 1, mainCount: 1, sideboardCount: 0, commandCount: 0, uniqueCards: 1,
    averageManaValue: 1, manaCurve: [], colorDistribution: [], colorIdentity: '',
    typeDistribution: [], estimatedValueUsd: 2, ownedCount: 1, proxiedCount: 0,
    needToBuyCount: 0,
  },
  manaBase: {
    requirements: [], totalPips: 0, totalSources: 0, landCount: 0,
    nonLandSources: 0, colorlessSources: 0,
  },
  templateProgress: null,
};

function fakePicker(overrides: Partial<DeckPickerState> = {}): DeckPickerState {
  return {
    query: '', setQuery: vi.fn(), ownedOnly: false, setOwnedOnly: vi.fn(),
    pickerColors: [], setPickerColors: vi.fn(), pickerGold: false, setPickerGold: vi.fn(),
    pickerHybrid: false, setPickerHybrid: vi.fn(), results: [], resultsTotal: 0, searching: false,
    pickingCommander: false, setPickingCommander: vi.fn(), searchInput: createRef(),
    preview: null, setPreview: vi.fn(), coverNote: null, setCoverNote: vi.fn(),
    pickerCategory: null, clearPickerCategory: vi.fn(), categoryLabels: {},
    ...overrides,
  };
}

describe('DeckPanes', () => {
  it('renders the decklist and reports a quantity bump on a card row', () => {
    const apply = vi.fn();
    render(
      <DeckPanes
        deck={deck}
        apply={apply}
        problemFor={() => null}
        requiresCommander={false}
        identity={null}
        cardSort="type"
        // Ultra-compact is the text list the "List" view mode used to be.
        density="ultra"
        onDensity={vi.fn()}
        setCardSort={vi.fn()}
        listRef={createRef()}
        picker={fakePicker()}
        setArtFor={vi.fn()}
        setError={vi.fn()}
        jumpToCard={vi.fn()}
        onFilterShortfall={vi.fn()}
        showTemplates={false}
        onResolveCategories={vi.fn()}
        categoryLabels={{}}
      />,
    );

    expect(screen.getByText('Sol Ring')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('One more Sol Ring'));
    expect(apply).toHaveBeenCalled();
  });

  it('renders the picker as a floating overlay instead of hiding it', () => {
    const onClosePicker = vi.fn();
    const { container } = render(
      <DeckPanes
        deck={deck}
        apply={vi.fn()}
        problemFor={() => null}
        requiresCommander={false}
        identity={null}
        cardSort="type"
        density="full"
        onDensity={vi.fn()}
        setCardSort={vi.fn()}
        listRef={createRef()}
        picker={fakePicker()}
        setArtFor={vi.fn()}
        setError={vi.fn()}
        jumpToCard={vi.fn()}
        onFilterShortfall={vi.fn()}
        showTemplates={false}
        onResolveCategories={vi.fn()}
        categoryLabels={{}}
        pickerFloating
        onClosePicker={onClosePicker}
      />,
    );

    // The same class CardDetailPane uses for its narrow-width overlay, so the
    // picker is reachable below 860px rather than being display:none.
    const picker = container.querySelector('.picker');
    expect(picker?.className).toContain('floating');
    expect(screen.getByLabelText('Search cards to add')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Done'));
    expect(onClosePicker).toHaveBeenCalled();

    // No divider to drag while the picker is an overlay.
    expect(container.querySelector('.pane-divider')).toBeNull();
  });

  it('offers dividers for both panes when they are docked columns', () => {
    const onPaneCommit = vi.fn();
    const { container } = render(
      <DeckPanes
        deck={deck}
        apply={vi.fn()}
        problemFor={() => null}
        requiresCommander={false}
        identity={null}
        cardSort="type"
        density="full"
        onDensity={vi.fn()}
        setCardSort={vi.fn()}
        listRef={createRef()}
        picker={fakePicker()}
        setArtFor={vi.fn()}
        setError={vi.fn()}
        jumpToCard={vi.fn()}
        onFilterShortfall={vi.fn()}
        showTemplates={false}
        onResolveCategories={vi.fn()}
        categoryLabels={{}}
        paneWidths={{ picker: 320, stats: 280 }}
        onPaneResize={vi.fn()}
        onPaneCommit={onPaneCommit}
      />,
    );

    expect(container.querySelectorAll('.pane-divider')).toHaveLength(2);
    const panes = container.querySelector('.deck-panes') as HTMLElement;
    expect(panes.style.getPropertyValue('--picker-w')).toBe('320px');
    expect(panes.style.getPropertyValue('--stats-w')).toBe('280px');

    const divider = screen.getByRole('separator', { name: 'Stats pane width' });
    divider.setPointerCapture = () => {};
    divider.releasePointerCapture = () => {};
    fireEvent.pointerDown(divider, { clientX: 700, pointerId: 1 });
    fireEvent.pointerMove(divider, { clientX: 660, pointerId: 1 });
    fireEvent.pointerUp(divider, { clientX: 660, pointerId: 1 });
    expect(onPaneCommit).toHaveBeenCalledWith('stats', 320);
  });
});

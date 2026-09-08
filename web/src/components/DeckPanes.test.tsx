import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeckPanes, type DeckPickerState } from './DeckPanes.tsx';
import type { Deck, DeckCard } from '../api.ts';

const card: DeckCard = {
  id: 1, oracleId: 'ORACLE-1', name: 'Sol Ring', board: 'main', quantity: 1,
  quantityFromCollection: 1, commanderRole: null, categories: [], cmc: 1, typeLine: 'Artifact',
  manaCost: '{1}', colorIdentity: '', isBasicLand: false, canBeCommander: false,
  category: null, producedMana: [], partnerKind: null, legality: null,
  ownedQuantity: 1, availableQuantity: 1, printingId: null, setCode: 'cmr',
  rarity: 'uncommon', imageSmall: null, priceUsd: 2,
};

const deck: Deck = {
  id: 1, name: 'Test Deck', formatCode: null, description: null, notes: null,
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
    typeDistribution: [], estimatedValueUsd: 2, ownedCount: 1, needToBuyCount: 0,
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
    pickerHybrid: false, setPickerHybrid: vi.fn(), results: [], searching: false,
    pickingCommander: false, setPickingCommander: vi.fn(), searchInput: createRef(),
    preview: null, setPreview: vi.fn(), coverNote: null, setCoverNote: vi.fn(),
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
        view="list"
        cardSort="type"
        setView={vi.fn()}
        setCardSort={vi.fn()}
        listRef={createRef()}
        picker={fakePicker()}
        setArtFor={vi.fn()}
        setError={vi.fn()}
        jumpToCard={vi.fn()}
        onFilterShortfall={vi.fn()}
        showTemplates={false}
      />,
    );

    expect(screen.getByText('Sol Ring')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('One more Sol Ring'));
    expect(apply).toHaveBeenCalled();
  });
});

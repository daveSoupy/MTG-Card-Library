import { readFileSync } from 'node:fs';
import { createRef } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeckTile } from './DeckTile.tsx';
import { OwnedGrid } from './OwnedGrid.tsx';
import { AddBySetTab } from './AddBySetTab.tsx';
import { DeckPanes, type DeckPickerState } from './DeckPanes.tsx';
import type { CollectionCard, Deck, DeckCard, SetRecord, StorageLocation } from '../api.ts';
import { DENSITIES_FOR, DENSITY_LABEL, type Density } from '../density.ts';

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  fetchSetChecklist: vi.fn(async () => [
    { printing_id: 'P1', name: 'Ancestral Recall', collector_number: '48', owned_qty: 1, image_small: 'x' },
    { printing_id: 'P2', name: 'Black Lotus', collector_number: '232', owned_qty: 0, image_small: 'x' },
  ]),
  fetchDeckCategories: vi.fn(async () => []),
  fetchCostPools: vi.fn(async () => []),
}));

const deckCard = (overrides: Partial<DeckCard> = {}): DeckCard => ({
  id: 1, oracleId: 'ORACLE-1', name: 'Sol Ring', board: 'main', quantity: 2,
  quantityFromCollection: 1, commanderRole: null, categories: [], cmc: 1, typeLine: 'Artifact',
  manaCost: '{1}', colorIdentity: '', isBasicLand: false, canBeCommander: false,
  category: null, producedMana: [], partnerKind: null, legality: null,
  ownedQuantity: 1, availableQuantity: 1, printingId: 'PRINT-1', setCode: 'cmr',
  rarity: 'uncommon', imageSmall: 'small.jpg', priceUsd: 2,
  ...overrides,
});

const collectionCard: CollectionCard = {
  oracleId: 'ORACLE-1', name: 'Lightning Bolt', manaCost: '{R}', cmc: 1,
  typeLine: 'Instant', colorIdentity: 'R', ownedQuantity: 3, allocatedQuantity: 0,
  availableQuantity: 3, valueUsd: 4.5, costUsd: null, gainUsd: null,
  printingCount: 1, locationCount: 1, lotCount: 1, printingId: 'PRINT-1',
  finish: 'nonfoil', setCode: 'lea', setName: 'Limited Edition Alpha',
  collectorNumber: '161', imageSmall: 'small.jpg',
};

const alphaSet: SetRecord = {
  code: 'lea', name: 'Limited Edition Alpha', released_at: '1993-08-05', card_count: 295,
};

const location: StorageLocation = {
  id: 1, name: 'Binder A', kind: 'binder', notes: null, is_default: 1,
  is_archived: 0, card_count: 0, distinct_printings: 0, value_usd: 0,
};

const noop = () => {};

// -- the deck builder shell, enough of it to render a decklist -----------------

function deckWith(cards: DeckCard[]): Deck {
  return {
    id: 1, name: 'Test deck', formatCode: null, description: null, coverPrintingId: null,
    homeLocationId: null, templateId: null, createdAt: '', updatedAt: '',
    cards,
    validation: {
      formatCode: null, formatName: null, commanderIdentity: null,
      countedTotal: cards.length, mainCount: cards.length, sideboardCount: 0,
      commandCount: 0, maybeCount: 0, requiredExactSize: null, requiredMinSize: null,
      sideboardLimit: null, issues: [], isLegal: true,
    },
    stats: {
      totalCards: cards.length, mainCount: cards.length, sideboardCount: 0, commandCount: 0,
      uniqueCards: cards.length, averageManaValue: 1, manaCurve: [], colorDistribution: [],
      colorIdentity: '', typeDistribution: [], estimatedValueUsd: 0, ownedCount: 0,
      needToBuyCount: 0,
    },
    manaBase: {
      requirements: [], totalPips: 0, totalSources: 0, landCount: 0,
      nonLandSources: 0, colorlessSources: 0,
    },
    templateProgress: null,
  } as unknown as Deck;
}

const picker = (): DeckPickerState => ({
  query: '', setQuery: noop, ownedOnly: false, setOwnedOnly: noop,
  pickerColors: [], setPickerColors: noop, pickerGold: false, setPickerGold: noop,
  pickerHybrid: false, setPickerHybrid: noop, results: [], resultsTotal: 0, searching: false,
  pickingCommander: false, setPickingCommander: noop, searchInput: createRef(),
  preview: null, setPreview: noop, coverNote: null, setCoverNote: noop,
  pickerCategory: null, clearPickerCategory: noop, categoryLabels: {},
});

function renderPanes(cards: DeckCard[], density: Density) {
  return render(
    <DeckPanes
      deck={deckWith(cards)}
      apply={noop}
      problemFor={() => null}
      requiresCommander={false}
      identity={null}
      cardSort="type"
      setCardSort={noop}
      density={density}
      onDensity={noop}
      listRef={createRef()}
      picker={picker()}
      setArtFor={noop}
      setError={noop}
      jumpToCard={noop}
      onFilterShortfall={noop}
      showTemplates={false}
      onResolveCategories={noop}
      categoryLabels={{}}
    />,
  );
}

// -----------------------------------------------------------------------------

describe('Ultra-compact leaves the art out of the DOM', () => {
  // Not "hidden by CSS": at collection scale the point is that no thumbnail is
  // requested at all, which only holds if the element is never rendered.
  it('on a collection lot tile', () => {
    const { container, rerender } = render(
      <OwnedGrid cards={[collectionCard]} selected={null} onSelect={noop} />,
    );
    expect(container.querySelector('img')).not.toBeNull();

    rerender(<OwnedGrid cards={[collectionCard]} selected={null} onSelect={noop} density="ultra" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Lightning Bolt')).toBeInTheDocument();
  });

  it('on an add-by-set tile', async () => {
    const { container, rerender } = render(
      <AddBySetTab sets={[alphaSet]} locations={[location]} onChanged={noop} />,
    );
    // The grid only exists once a set is chosen, so pick one first.
    fireEvent.focus(screen.getByLabelText('Search sets…'));
    fireEvent.click(await screen.findByText(/Limited Edition Alpha/));
    await waitFor(() => expect(container.querySelector('.entry-tile')).not.toBeNull());
    expect(container.querySelector('img')).not.toBeNull();

    rerender(<AddBySetTab sets={[alphaSet]} locations={[location]} onChanged={noop} density="ultra" />);
    await waitFor(() => expect(container.querySelector('.entry-tile')).not.toBeNull());
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Black Lotus')).toBeInTheDocument();
  });

  it('on the decklist, which drops to text rows entirely', () => {
    const { container } = renderPanes([deckCard()], 'ultra');
    expect(container.querySelector('.decklist img')).toBeNull();
    // Ultra-compact *is* the old List view, so the row keeps the board,
    // category and collection controls a tile never had.
    expect(container.querySelectorAll('.decklist .deck-tile').length).toBe(0);
    expect(container.querySelectorAll('.decklist .deck-row').length).toBe(1);
    expect(screen.getByLabelText('Move Sol Ring')).toBeInTheDocument();
  });
});

describe('Lined-up', () => {
  const cards = [
    deckCard({ id: 1, oracleId: 'O-1', name: 'Alpha', typeLine: 'Creature — Elf', cmc: 1 }),
    deckCard({ id: 2, oracleId: 'O-2', name: 'Beta', typeLine: 'Creature — Elf', cmc: 2 }),
    deckCard({ id: 3, oracleId: 'O-3', name: 'Gamma', typeLine: 'Creature — Elf', cmc: 3 }),
    deckCard({ id: 4, oracleId: 'O-4', name: 'Bolt', typeLine: 'Instant', cmc: 1 }),
  ];

  it('cascades every card past the first, and never covers the last', () => {
    const { container } = renderPanes(cards, 'lined');
    const columns = container.querySelectorAll('.cascade-col');
    // One column per group — here Creature and Instant.
    expect(columns.length).toBe(2);

    const creatures = [...columns[0].querySelectorAll('.deck-tile')];
    expect(creatures.length).toBe(3);
    // The first card sits where it falls; every card after it is pulled up
    // over the one before, which is what the stylesheet keys off.
    expect(creatures[0].getAttribute('data-cascade')).toBe('first');
    expect(creatures.slice(1).map((t) => t.getAttribute('data-cascade')))
      .toEqual(['stacked', 'stacked']);

    // Nothing is painted over the last card: no z-index is involved, so being
    // last in DOM order is exactly what "on top, fully visible" means.
    const last = creatures.at(-1)!;
    expect(last.nextElementSibling).toBeNull();
    expect(last.getAttribute('data-oracle')).toBe('O-3');
  });

  it('falls out to a single column for a sort with one flat bucket', () => {
    const { container } = render(
      <DeckPanes
        deck={deckWith(cards)} apply={noop} problemFor={() => null} requiresCommander={false}
        identity={null} cardSort="name" setCardSort={noop}
        density="lined" onDensity={noop} listRef={createRef()} picker={picker()}
        setArtFor={noop} setError={noop} jumpToCard={noop} onFilterShortfall={noop}
        showTemplates={false} onResolveCategories={noop} categoryLabels={{}}
      />,
    );
    expect(container.querySelectorAll('.cascade-col').length).toBe(1);
  });

  it('is sized so a container narrower than one card still shows one column', () => {
    // The guard is a CSS one — a column is exactly one card wide and never
    // wider than the pane — so this checks the rule itself rather than a
    // layout jsdom does not perform.
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toMatch(/\.cascade-col\s*\{[^}]*width:\s*min\(var\(--cascade-card-w\),\s*100%\)/);
    // Wrapping, not shrinking — two columns that do not fit go onto two rows
    // rather than each squeezing to half a card.
    expect(css).toMatch(/\.deck-cascade\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it('shows the card on a tap where there is no hover to uncover it with', () => {
    const onPreview = vi.fn();
    render(
      <DeckTile card={deckCard()} problem={null} density="lined" cascade="stacked"
                onPreview={onPreview} tapOpensPreview
                onQuantity={noop} onArt={noop} onRemove={noop} />,
    );
    const tile = screen.getByLabelText('Remove Sol Ring').closest('.deck-tile')!;

    fireEvent.click(tile);
    expect(onPreview).toHaveBeenCalled();
    // The tap opened the card, not Phase 9's controls.
    expect(tile.className).not.toContain('controls-open');
  });

  it('still reveals its controls on a tap where hover does exist', () => {
    const onPreview = vi.fn();
    render(
      <DeckTile card={deckCard()} problem={null} density="lined" cascade="stacked"
                onPreview={onPreview} onQuantity={noop} onArt={noop} onRemove={noop} />,
    );
    const tile = screen.getByLabelText('Remove Sol Ring').closest('.deck-tile')!;

    fireEvent.mouseEnter(tile);
    expect(onPreview).toHaveBeenCalled();

    fireEvent.click(tile);
    expect(tile.className).toContain('controls-open');
  });
});

describe('the decklist toolbar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers the four levels as the view modes, and nothing else', () => {
    // The List/Cards pair is gone: those two were the same choice this control
    // already makes, so there is one segmented control rather than two. Read
    // off DENSITIES_FOR rather than written out, so rearranging which order
    // the levels sit in stays a presentation choice.
    const { container } = renderPanes([deckCard()], 'full');
    const tabs = container.querySelector('.deck-toolbar .tabs.small')!;
    expect([...tabs.querySelectorAll('button')].map((b) => b.textContent))
      .toEqual(DENSITIES_FOR.deck.map((level) => DENSITY_LABEL[level]));
    expect(container.querySelectorAll('.deck-toolbar .tabs').length).toBe(1);
    expect(tabs.querySelector('.on')!.textContent).toBe(DENSITY_LABEL.full);
  });

  it('reports the level that was picked', () => {
    const onDensity = vi.fn();
    render(
      <DeckPanes
        deck={deckWith([deckCard()])} apply={noop} problemFor={() => null}
        requiresCommander={false} identity={null} cardSort="type" setCardSort={noop}
        density="full" onDensity={onDensity} listRef={createRef()} picker={picker()}
        setArtFor={noop} setError={noop} jumpToCard={noop} onFilterShortfall={noop}
        showTemplates={false} onResolveCategories={noop} categoryLabels={{}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Lined-up' }));
    expect(onDensity).toHaveBeenCalledWith('lined');
  });

  it('tints each text row by colour identity', () => {
    const { container } = renderPanes([
      deckCard({ id: 1, colorIdentity: 'G' }),
      deckCard({ id: 2, colorIdentity: 'WU' }),
      deckCard({ id: 3, colorIdentity: '' }),
    ], 'ultra');
    expect([...container.querySelectorAll('.deck-row')].map((r) => r.getAttribute('data-identity')))
      .toEqual(['G', 'M', 'C']);
  });
});

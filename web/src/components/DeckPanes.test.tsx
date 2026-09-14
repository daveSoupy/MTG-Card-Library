import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { DeckPanes, type DeckPickerState, type PickerPreview } from './DeckPanes.tsx';
import { EMPTY_FILTERS } from './FilterPanel.tsx';
import type { CardSummary, Deck, DeckCard } from '../api.ts';

const api = vi.hoisted(() => ({
  // Typed by hand: the mocked module's own type is not available inside
  // vi.hoisted, and the tests read the call's arguments back as a tuple.
  addDeckCard: vi.fn<(deckId: number, oracleId: string, options?: object) => Promise<unknown>>(
    async () => ({}),
  ),
  // The detail pane's fetches; left failing, since the pane renders (with an
  // error line) either way and only its opening is under test here.
  fetchCard: vi.fn(async () => { throw new Error('offline'); }),
  fetchCardHolders: vi.fn(async () => { throw new Error('offline'); }),
  setDeckCover: vi.fn(async () => ({})),
}));

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  ...api,
}));

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
  id: 1, name: 'Test Deck', formatCode: null, homeLocationId: null, description: null, notes: null,
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
    query: '', setQuery: vi.fn(),
    filters: EMPTY_FILTERS, setFilters: vi.fn(), sets: [], formats: [],
    results: [], resultsTotal: 0, searching: false, loadingMore: false, loadMore: vi.fn(),
    pickingCommander: false, setPickingCommander: vi.fn(), searchInput: createRef(),
    preview: null, setPreview: vi.fn(),
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

/** A search result, as the picker lists it. */
function result(oracleId: string, name: string): CardSummary {
  return {
    oracleId, name, manaCost: '{1}', cmc: 1, typeLine: 'Artifact', power: null, toughness: null,
    loyalty: null, colors: '', colorIdentity: '', rarity: 'uncommon', setCode: 'cmr',
    setName: 'Commander Legends', collectorNumber: '1', imageSmall: null, imageNormal: null,
    priceUsd: 1, priceUsdFoil: null, printingId: `PRINT-${oracleId}`, ownedQuantity: 0,
    printingCount: 1,
  } as CardSummary;
}

const solRing = result('ORACLE-1', 'Sol Ring');
const arcaneSignet = result('ORACLE-2', 'Arcane Signet');

function renderPicker(
  picker: Partial<DeckPickerState>,
  props: Partial<Parameters<typeof DeckPanes>[0]> = {},
) {
  const apply = vi.fn();
  const view = render(
    <DeckPanes
      deck={deck}
      apply={apply}
      problemFor={() => null}
      requiresCommander={false}
      identity={null}
      cardSort="type"
      density="ultra"
      onDensity={vi.fn()}
      setCardSort={vi.fn()}
      listRef={createRef()}
      picker={fakePicker(picker)}
      setArtFor={vi.fn()}
      setError={vi.fn()}
      jumpToCard={vi.fn()}
      onFilterShortfall={vi.fn()}
      showTemplates={false}
      onResolveCategories={vi.fn()}
      categoryLabels={{}}
      {...props}
    />,
  );
  return { ...view, apply };
}

/** The card an `apply` call would add: runs the recorded action against the mocked API. */
async function addedBy(apply: ReturnType<typeof vi.fn>) {
  expect(apply).toHaveBeenCalled();
  await (apply.mock.calls.at(-1)![0] as () => Promise<unknown>)();
  return api.addDeckCard.mock.calls.at(-1)!;
}

describe('DeckPanes picker preview', () => {
  it('previews on a mouse hover but not as a finger scrolls over a row', () => {
    const setPreview = vi.fn();
    renderPicker({ results: [solRing, arcaneSignet], resultsTotal: 2, setPreview });
    const row = screen.getByTitle('Add Sol Ring');

    // iOS fires enter events as a finger passes over rows while scrolling;
    // that must never open a picture that then sits over the list.
    fireEvent.pointerEnter(row, { pointerType: 'touch' });
    expect(setPreview).not.toHaveBeenCalled();

    fireEvent.pointerEnter(row, { pointerType: 'mouse' });
    // A picker row's popup is the clickable kind, not the tooltip.
    expect(setPreview).toHaveBeenCalledWith(expect.objectContaining({
      oracleId: 'ORACLE-1', printingId: 'PRINT-ORACLE-1', name: 'Sol Ring', anchor: expect.any(Object),
    }));
    expect(setPreview.mock.calls[0][0]).not.toHaveProperty('tooltip');
  });

  it('a hover preview floats beside the row and goes when the pointer leaves the results', () => {
    vi.useFakeTimers();
    try {
      const setPreview = vi.fn();
      const { container } = renderPicker({
        results: [solRing], resultsTotal: 1, setPreview,
        preview: { oracleId: 'ORACLE-1', printingId: 'PRINT-ORACLE-1', name: 'Sol Ring', anchor: { top: 120, left: 600 } },
      });
      const popup = container.querySelector('.picker-hover') as HTMLElement;
      expect(popup).not.toBeNull();
      expect(popup.style.top).toBe('120px');
      // Not under the results: that is what blocked the rows below.
      // The card itself is the only control: it opens the details, where the
      // deck-cover choice now lives.
      expect(popup.querySelectorAll('button')).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Open Sol Ring' })).toBeInTheDocument();

      // Leaving the list starts a short fuse, so the pointer can reach the
      // popup's cover button; entering the popup cancels it.
      fireEvent.pointerLeave(screen.getByRole('listbox', { name: 'Matching cards' }));
      fireEvent.pointerEnter(popup);
      vi.advanceTimersByTime(500);
      expect(setPreview).not.toHaveBeenCalled();

      fireEvent.pointerLeave(popup);
      expect(setPreview).toHaveBeenCalledWith(null);

      // And with nowhere to go, the fuse clears it.
      setPreview.mockClear();
      fireEvent.pointerLeave(screen.getByRole('listbox', { name: 'Matching cards' }));
      vi.advanceTimersByTime(500);
      expect(setPreview).toHaveBeenCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pinned preview is a dialog with its own close, and a way to the details', () => {
    const setPreview = vi.fn();
    const { container } = renderPicker({
      results: [solRing], resultsTotal: 1, setPreview,
      preview: { oracleId: 'ORACLE-1', printingId: 'PRINT-ORACLE-1', name: 'Sol Ring', pinned: true },
    });
    // Not a sticky-bottom element: that is what stole the bottom of the list.
    expect(container.querySelector('.picker-preview')).toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'Sol Ring' });
    expect(dialog.querySelector('img')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(container.querySelector('.detail-pane.floating')).not.toBeNull();
    expect(setPreview).toHaveBeenCalledWith(null);
    setPreview.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(setPreview).toHaveBeenCalledWith(null);
  });
});

describe('DeckPanes picker rows', () => {
  it('shows how many copies this deck already holds, and updates when the deck does', () => {
    const { rerender } = renderPicker({ results: [solRing, arcaneSignet], resultsTotal: 2 });
    // The fixture deck holds one Sol Ring on the main board.
    const solRow = screen.getByRole('option', { name: /Sol Ring/ });
    expect(solRow.querySelector('.tag.in-deck')?.textContent).toBe('×1');
    expect(screen.getByRole('option', { name: /Arcane Signet/ }).querySelector('.tag.in-deck')).toBeNull();

    // A second copy lands, plus one in the sideboard: the row says both.
    const next: Deck = {
      ...deck,
      cards: [
        { ...card, quantity: 2 },
        { ...card, id: 2, board: 'side', quantity: 1 },
      ],
    };
    rerender(
      <DeckPanes
        deck={next}
        apply={vi.fn()}
        problemFor={() => null}
        requiresCommander={false}
        identity={null}
        cardSort="type"
        density="ultra"
        onDensity={vi.fn()}
        setCardSort={vi.fn()}
        listRef={createRef()}
        picker={fakePicker({ results: [solRing, arcaneSignet], resultsTotal: 2 })}
        setArtFor={vi.fn()}
        setError={vi.fn()}
        jumpToCard={vi.fn()}
        onFilterShortfall={vi.fn()}
        showTemplates={false}
        onResolveCategories={vi.fn()}
        categoryLabels={{}}
      />,
    );
    expect(screen.getByRole('option', { name: /Sol Ring/ }).querySelector('.tag.in-deck')?.textContent)
      .toBe('×2 · SB ×1');
  });

  it('in a singleton format a held card reads "In deck" and its name does nothing; SB still works', async () => {
    const { apply } = renderPicker({ results: [solRing], resultsTotal: 1 }, { singleton: true });
    const row = screen.getByRole('option', { name: /Sol Ring/ });
    expect(row.querySelector('.tag.in-deck')?.textContent).toBe('In deck');

    fireEvent.click(screen.getByTitle('Sol Ring is already in this deck'));
    expect(apply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('Add to sideboard'));
    const [, oracleId, options] = await addedBy(apply);
    expect(oracleId).toBe('ORACLE-1');
    expect(options).toMatchObject({ board: 'side' });
  });

  it('a type chip writes t:<type> into the query and takes it out again', () => {
    const setQuery = vi.fn();
    const { rerender } = renderPicker({ query: 'c:r', setQuery });
    fireEvent.click(screen.getByRole('button', { name: 'Creature' }));
    expect(setQuery).toHaveBeenCalledWith('t:creature c:r');

    rerender(
      <DeckPanes
        deck={deck}
        apply={vi.fn()}
        problemFor={() => null}
        requiresCommander={false}
        identity={null}
        cardSort="type"
        density="ultra"
        onDensity={vi.fn()}
        setCardSort={vi.fn()}
        listRef={createRef()}
        picker={fakePicker({ query: 't:creature c:r', setQuery })}
        setArtFor={vi.fn()}
        setError={vi.fn()}
        jumpToCard={vi.fn()}
        onFilterShortfall={vi.fn()}
        showTemplates={false}
        onResolveCategories={vi.fn()}
        categoryLabels={{}}
      />,
    );
    const chip = screen.getByRole('button', { name: 'Creature' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(chip);
    expect(setQuery).toHaveBeenLastCalledWith('c:r');
  });

  it('↓ then Enter in the search box adds the highlighted card; Shift+Enter sends it to the sideboard', async () => {
    const { apply } = renderPicker({ query: 'sol', results: [solRing, arcaneSignet], resultsTotal: 2 });
    const input = screen.getByRole('combobox', { name: 'Search cards to add' });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const first = screen.getByRole('option', { name: /Sol Ring/ });
    expect(input).toHaveAttribute('aria-activedescendant', first.id);
    expect(first).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'Enter' });
    const [deckId, oracleId, options] = await addedBy(apply);
    expect(deckId).toBe(1);
    expect(oracleId).toBe('ORACLE-1');
    expect(options).not.toHaveProperty('board');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    const [, second, sideOptions] = await addedBy(apply);
    expect(second).toBe('ORACLE-2');
    expect(sideOptions).toMatchObject({ board: 'side' });
  });

  it('Escape clears the highlight before it clears the query', () => {
    const setQuery = vi.fn();
    renderPicker({ query: 'sol', setQuery, results: [solRing], resultsTotal: 1 });
    const input = screen.getByRole('combobox', { name: 'Search cards to add' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(setQuery).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(setQuery).toHaveBeenCalledWith('');
  });

  it('offers Load more only while more matched than is shown, and says how many', () => {
    const loadMore = vi.fn();
    const { rerender } = renderPicker({ results: [solRing, arcaneSignet], resultsTotal: 50, loadMore });
    // Once at the head of the results, once beside the button.
    expect(screen.getAllByText('2 of 50')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(loadMore).toHaveBeenCalled();

    rerender(
      <DeckPanes
        deck={deck}
        apply={vi.fn()}
        problemFor={() => null}
        requiresCommander={false}
        identity={null}
        cardSort="type"
        density="ultra"
        onDensity={vi.fn()}
        setCardSort={vi.fn()}
        listRef={createRef()}
        picker={fakePicker({ results: [solRing, arcaneSignet], resultsTotal: 2 })}
        setArtFor={vi.fn()}
        setError={vi.fn()}
        jumpToCard={vi.fn()}
        onFilterShortfall={vi.fn()}
        showTemplates={false}
        onResolveCategories={vi.fn()}
        categoryLabels={{}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getByText('2 cards')).toBeInTheDocument();
  });

  it('the Filters button opens the shared panel with the picker\'s own sections left out, and counts what is set', () => {
    const setFilters = vi.fn();
    renderPicker({ filters: { ...EMPTY_FILTERS, rarities: ['rare'], minCmc: '2' }, setFilters });
    const button = screen.getByRole('button', { name: 'Filters · 2' });
    fireEvent.click(button);
    // Rarity is the Browse panel's control, reused rather than forked.
    const rare = screen.getByRole('button', { name: 'rare' });
    expect(rare).toHaveAttribute('aria-pressed', 'true');
    // Presets and the Owned-only box are not offered here: the scope chips
    // are the picker's collection filter, and a preset would replace the query.
    expect(screen.queryByText('Saved filters')).toBeNull();
    expect(screen.queryByLabelText('Owned only')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'mythic' }));
    expect(setFilters).toHaveBeenCalledWith(
      expect.objectContaining({ rarities: ['rare', 'mythic'] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('button', { name: 'rare' })).toBeNull();
  });

  it('the colour chips and the panel share one state', () => {
    const setFilters = vi.fn();
    renderPicker({ filters: { ...EMPTY_FILTERS, colors: ['R'] }, setFilters });
    // The chip row shows the panel's colour as pressed…
    const chips = screen.getByTitle('R');
    expect(chips).toHaveAttribute('aria-pressed', 'true');
    // …and pressing another writes to the same object the panel edits.
    fireEvent.click(screen.getByTitle('U'));
    expect(setFilters).toHaveBeenCalledWith(expect.objectContaining({ colors: ['R', 'U'] }));
  });
});

describe('DeckPanes deck-card preview', () => {
  const printed: DeckCard = { ...card, printingId: 'PRINT-ORACLE-1' };

  it('a mouse over a deck row floats the same popup; a finger does not', () => {
    const setPreview = vi.fn();
    render(
      <DeckPanes
        deck={{ ...deck, cards: [printed] }}
        apply={vi.fn()}
        problemFor={() => null}
        requiresCommander={false}
        identity={null}
        cardSort="type"
        density="ultra"
        onDensity={vi.fn()}
        setCardSort={vi.fn()}
        listRef={createRef()}
        picker={fakePicker({ setPreview })}
        setArtFor={vi.fn()}
        setError={vi.fn()}
        jumpToCard={vi.fn()}
        onFilterShortfall={vi.fn()}
        showTemplates={false}
        onResolveCategories={vi.fn()}
        categoryLabels={{}}
      />,
    );
    const row = screen.getByTitle('Artifact').closest('.deck-row')!;
    fireEvent.pointerEnter(row, { pointerType: 'touch' });
    expect(setPreview).not.toHaveBeenCalled();
    fireEvent.pointerEnter(row, { pointerType: 'mouse', clientX: 300, clientY: 200 });
    expect(setPreview).toHaveBeenCalledWith(expect.objectContaining({
      oracleId: 'ORACLE-1', printingId: 'PRINT-ORACLE-1', name: 'Sol Ring',
      // Beside the cursor, and a tooltip: click-through, so it can lie over
      // the next tile without taking the pointer from it.
      anchor: expect.objectContaining({ left: 316 }),
      tooltip: true,
    }));
  });

  it('tiles do not raise the popup — only Ultra-compact rows, which show no art', () => {
    const setPreview = vi.fn();
    render(
      <DeckPanes
        deck={{ ...deck, cards: [printed] }}
        apply={vi.fn()}
        problemFor={() => null}
        requiresCommander={false}
        identity={null}
        cardSort="type"
        density="full"
        onDensity={vi.fn()}
        setCardSort={vi.fn()}
        listRef={createRef()}
        picker={fakePicker({ setPreview })}
        setArtFor={vi.fn()}
        setError={vi.fn()}
        jumpToCard={vi.fn()}
        onFilterShortfall={vi.fn()}
        showTemplates={false}
        onResolveCategories={vi.fn()}
        categoryLabels={{}}
      />,
    );
    const tile = screen.getByLabelText('Remove Sol Ring').closest('.deck-tile')!;
    fireEvent.pointerEnter(tile, { pointerType: 'mouse', clientX: 300, clientY: 200 });
    expect(setPreview).not.toHaveBeenCalled();
  });

  const linedPanes = (setPreview = vi.fn(), apply = vi.fn(), preview: PickerPreview | null = null) => (
    <DeckPanes
      deck={{ ...deck, cards: [printed, { ...printed, id: 2, oracleId: 'ORACLE-2', name: 'Arcane Signet' }] }}
      apply={apply}
      problemFor={() => null}
      requiresCommander={false}
      identity={null}
      cardSort="type"
      density="lined"
      onDensity={vi.fn()}
      setCardSort={vi.fn()}
      listRef={createRef()}
      picker={fakePicker({ setPreview, preview })}
      setArtFor={vi.fn()}
      setError={vi.fn()}
      jumpToCard={vi.fn()}
      onFilterShortfall={vi.fn()}
      showTemplates={false}
      onResolveCategories={vi.fn()}
      categoryLabels={{}}
    />
  );

  it('Lined-up: a mouse over a strip shows the tooltip; a click raises the tile in place with its controls', () => {
    vi.useFakeTimers();
    try {
      const setPreview = vi.fn();
      const apply = vi.fn();
      // Rendered with the tooltip already up, as it would be after the hover
      // below, since the mocked setter cannot put it there itself.
      render(linedPanes(setPreview, apply, {
        oracleId: 'ORACLE-1', printingId: 'PRINT-ORACLE-1', name: 'Sol Ring',
        anchor: { top: 10, left: 10 }, tooltip: true,
      }));
      const tile = screen.getByLabelText('Remove Sol Ring').closest('.deck-tile') as HTMLElement;
      fireEvent.pointerEnter(tile, { pointerType: 'mouse', clientX: 300, clientY: 200 });
      expect(setPreview).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sol Ring', tooltip: true }));

      // The click: the tile itself is raised (no panel), and the tooltip goes.
      setPreview.mockClear();
      fireEvent.click(tile);
      expect(tile.className).toContain('controls-open');
      expect(screen.queryByRole('dialog')).toBeNull();
      vi.advanceTimersByTime(500);
      expect(setPreview).toHaveBeenCalledWith(null);

      // Its controls are the tile's own, and using one keeps it open.
      fireEvent.click(within(tile).getByRole('button', { name: 'One more Sol Ring' }));
      expect(apply).toHaveBeenCalled();
      expect(tile.className).toContain('controls-open');
      expect(within(tile).getByRole('button', { name: 'Details for Sol Ring' })).toBeInTheDocument();

      // Hovering the raised card floats no second copy beside it.
      setPreview.mockClear();
      fireEvent.pointerEnter(tile, { pointerType: 'mouse', clientX: 300, clientY: 200 });
      expect(setPreview).not.toHaveBeenCalled();

      // A click elsewhere tucks it back; so does Escape.
      fireEvent.click(document.body);
      expect(tile.className).not.toContain('controls-open');
      fireEvent.click(tile);
      expect(tile.className).toContain('controls-open');
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(tile.className).not.toContain('controls-open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Lined-up on a touch screen: a tap opens the card in a panel, since the tile controls are too small for a thumb', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(hover: none)', media: query, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      render(linedPanes());
      const tile = screen.getByLabelText('Remove Sol Ring').closest('.deck-tile') as HTMLElement;
      fireEvent.click(tile);
      const dialog = screen.getByRole('dialog', { name: 'Sol Ring' });
      expect(tile.className).not.toContain('controls-open');
      expect(within(dialog).getByRole('button', { name: 'One more Sol Ring' })).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog', { name: 'Sol Ring' })).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it('a deck-card tooltip is click-through and carries no buttons', () => {
    const { container } = renderPicker({
      preview: {
        oracleId: 'ORACLE-1', printingId: 'PRINT-ORACLE-1', name: 'Sol Ring',
        anchor: { top: 10, left: 10 }, tooltip: true,
      },
    });
    const popup = container.querySelector('.picker-hover') as HTMLElement;
    expect(popup.className).toContain('tooltip');
    expect(popup.querySelector('img')).not.toBeNull();
    expect(popup.querySelector('button')).toBeNull();
  });

  it('a tile\'s ⓘ opens the card\'s details', () => {
    const { container } = render(
      <DeckPanes
        deck={{ ...deck, cards: [printed] }}
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
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Details for Sol Ring' }));
    expect(container.querySelector('.detail-pane.floating')).not.toBeNull();
  });

  it('clicking the floating card opens its details, which close again', async () => {
    const setPreview = vi.fn();
    const { container } = renderPicker({
      setPreview,
      preview: { oracleId: 'ORACLE-1', printingId: 'PRINT-ORACLE-1', name: 'Sol Ring', anchor: { top: 10, left: 10 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Sol Ring' }));
    // The popup is dismissed for the pane, which floats over the builder.
    expect(setPreview).toHaveBeenCalledWith(null);
    const pane = container.querySelector('.detail-pane.floating');
    expect(pane).not.toBeNull();
    expect(api.fetchCard).toHaveBeenCalledWith('ORACLE-1', expect.anything());

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.detail-pane.floating')).toBeNull();
  });

  it('an Ultra-compact row\'s name opens the details directly', () => {
    const { container } = render(
      <DeckPanes
        deck={{ ...deck, cards: [printed] }}
        apply={vi.fn()}
        problemFor={() => null}
        requiresCommander={false}
        identity={null}
        cardSort="type"
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
    fireEvent.click(screen.getByRole('button', { name: /^Sol Ring/ }));
    expect(container.querySelector('.detail-pane.floating')).not.toBeNull();
  });
});

describe('DeckPanes card details', () => {
  it('offers Make deck cover for the printing on screen, and only in the builder', async () => {
    api.fetchCard.mockResolvedValueOnce({
      oracleId: 'ORACLE-1', name: 'Sol Ring', typeLine: 'Artifact', manaCost: '{1}', cmc: 1,
      oracleText: '', flavorText: null, colorIdentity: '', colors: '', power: null, toughness: null,
      loyalty: null, artist: 'Mike Bierek', isReserved: false, deckCopyLimit: null, ownedQuantity: 0,
      printingId: 'PRINT-A', rarity: 'uncommon', setCode: 'cmr', setName: 'Commander Legends',
      collectorNumber: '1', imageNormal: null, imageSmall: null, priceUsd: 1, priceUsdFoil: null,
      legalities: [], rulings: [], faces: [],
      printings: [
        { id: 'PRINT-A', setCode: 'cmr', setName: 'Commander Legends', collectorNumber: '1', rarity: 'uncommon',
          releasedAt: null, priceUsd: 1, priceUsdFoil: null, imageNormal: null, scryfallUri: null,
          tcgplayerId: null, isDigital: false, isPromo: false, promoTypes: [], ownedQuantity: 0 },
        { id: 'PRINT-B', setCode: 'lea', setName: 'Alpha', collectorNumber: '2', rarity: 'uncommon',
          releasedAt: null, priceUsd: 900, priceUsdFoil: null, imageNormal: null, scryfallUri: null,
          tcgplayerId: null, isDigital: false, isPromo: false, promoTypes: [], ownedQuantity: 0 },
      ],
    } as never);
    renderPicker({
      preview: { oracleId: 'ORACLE-1', printingId: 'PRINT-A', name: 'Sol Ring', anchor: { top: 10, left: 10 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Sol Ring' }));
    const button = await screen.findByRole('button', { name: 'Make deck cover' });

    // Picking another printing first makes that the cover — the same choice
    // the art pin offers, made for the deck.
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));
    fireEvent.click(button);
    await waitFor(() => expect(api.setDeckCover).toHaveBeenCalledWith(1, 'PRINT-B'));
    await screen.findByRole('button', { name: '✓ Deck cover' });
  });
});

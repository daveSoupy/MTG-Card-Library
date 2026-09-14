import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { DeckBuilder } from './DeckBuilder.tsx';
import type {
  AssemblyRun, CardSummary, Deck, DeckStatus, SearchParams, SearchResponse,
} from '../api.ts';

// Everything the builder fetches on mount, stubbed so the header renders. The
// fetches whose failure is swallowed (settings, templates, locations, games)
// are left to reject; the header must not depend on them.
const api = vi.hoisted(() => ({
  fetchDeck: vi.fn(),
  fetchRunHistory: vi.fn(),
  fetchBuildability: vi.fn(async () => null),
  fetchSettings: vi.fn(async () => { throw new Error('offline'); }),
  fetchTemplates: vi.fn(async () => { throw new Error('offline'); }),
  fetchLocations: vi.fn(async () => { throw new Error('offline'); }),
  fetchDeckGames: vi.fn(async () => { throw new Error('offline'); }),
  fetchSets: vi.fn(async () => []),
  // Typed as the real signature so a test can hand it pages of cards.
  searchCards: vi.fn<(params: SearchParams, signal?: AbortSignal) => Promise<SearchResponse>>(
    async () => ({ cards: [], total: 0, limit: 60, offset: 0, warnings: [] }),
  ),
  updateDeck: vi.fn(),
}));

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  ...api,
}));

function deckWith(status: DeckStatus): Deck {
  return {
    id: 1, name: 'Eric', formatCode: null, homeLocationId: null, description: null, notes: null,
    status, statusChangedAt: null, isArchived: false, createdAt: '', updatedAt: '',
    templateId: null, cards: [],
    validation: {
      formatCode: null, formatName: null, commanderIdentity: null, countedTotal: 0,
      mainCount: 0, sideboardCount: 0, commandCount: 0, maybeCount: 0,
      requiredExactSize: null, requiredMinSize: null, sideboardLimit: null,
      issues: [], isLegal: true,
    },
    stats: {
      totalCards: 0, mainCount: 0, sideboardCount: 0, commandCount: 0, uniqueCards: 0,
      averageManaValue: 0, manaCurve: [], colorDistribution: [], colorIdentity: '',
      typeDistribution: [], estimatedValueUsd: 0, ownedCount: 0, proxiedCount: 0,
      needToBuyCount: 0,
    },
    manaBase: {
      requirements: [], totalPips: 0, totalSources: 0, landCount: 0,
      nonLandSources: 0, colorlessSources: 0,
    },
    templateProgress: null,
    coverPrintingId: null,
  };
}

function runWith(status: AssemblyRun['status'], notes: string | null = null): AssemblyRun {
  return {
    id: 3, deckId: 1, kind: 'assemble', status, movesLots: false, sourceRunId: null,
    startedAt: '2026-09-10T22:00:00Z', completedAt: status === 'open' ? null : '2026-09-14T11:09:09Z',
    notes, lineCount: 4, cardCount: 4, pickedCount: 4, notFoundCount: 0, notFound: [],
  };
}

async function renderDeck(status: DeckStatus, runs: AssemblyRun[]) {
  api.fetchDeck.mockResolvedValue(deckWith(status));
  api.fetchRunHistory.mockResolvedValue(runs);
  render(
    <DeckBuilder
      deckId={1} formats={[]} categoryLabels={{}} onBack={() => {}}
      density="full" onDensity={() => {}}
    />,
  );
  await screen.findByTitle(/click to rename/);
  // Run history arrives on its own promise; wait for it to have landed.
  await waitFor(() => expect(api.fetchRunHistory).toHaveBeenCalled());
}

const resumeButton = () => screen.queryByRole('button', { name: /Resume pull sheet/ });
const assembleButton = () => screen.queryByRole('button', { name: /^Assemble$/ });

describe('DeckBuilder pull-sheet header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.innerWidth = 1400;
  });

  it('offers to resume an open run on a deck that reserves', async () => {
    await renderDeck('building', [runWith('open')]);
    await waitFor(() => expect(resumeButton()).not.toBeNull());
    expect(resumeButton()!.textContent).toMatch(/4\/4/);
    expect(assembleButton()).toBeNull();
  });

  it('does not offer to resume a run that outlived its deck reserving', async () => {
    // A run left open on a brew: the server now cancels these on the status
    // change (and v20 swept up older ones), but the guard is render-only so
    // reading the deck never has to write. The header reads like any brew's.
    await renderDeck('brew', [runWith('open')]);
    await waitFor(() => expect(assembleButton()).not.toBeNull());
    expect(resumeButton()).toBeNull();
    expect(screen.getByRole('button', { name: 'Brew' })).toBeTruthy();
  });

  it('likewise for a taken-apart deck', async () => {
    await renderDeck('disassembled', [runWith('open')]);
    await waitFor(() => expect(assembleButton()).not.toBeNull());
    expect(resumeButton()).toBeNull();
  });

  it('re-reads run history after a status change, so a cancelled run is not offered on the way back', async () => {
    await renderDeck('building', [runWith('open')]);
    await waitFor(() => expect(resumeButton()).not.toBeNull());

    // Stepping to brew: the server cancels the run inside the same write.
    api.updateDeck.mockResolvedValue(deckWith('brew'));
    api.fetchRunHistory.mockResolvedValue([
      runWith('cancelled', 'Cancelled automatically: deck status changed to brew.'),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Building' }));
    fireEvent.click(screen.getByRole('option', { name: /^Brew/ }));
    await waitFor(() => expect(api.updateDeck).toHaveBeenCalledWith(1, { status: 'brew' }));
    await waitFor(() => expect(api.fetchRunHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(assembleButton()).not.toBeNull());
    expect(resumeButton()).toBeNull();

    // And back to building: the client knows the run is cancelled and offers a
    // fresh Assemble rather than resuming a sheet the server has closed.
    api.updateDeck.mockResolvedValue(deckWith('building'));
    fireEvent.click(screen.getByRole('button', { name: 'Brew' }));
    fireEvent.click(screen.getByRole('option', { name: /^Building/ }));
    await waitFor(() => expect(api.fetchRunHistory).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Building' })).toBeTruthy());
    expect(resumeButton()).toBeNull();
    expect(assembleButton()).not.toBeNull();
  });
});

/** A page of results, named so a duplicate across pages is easy to plant. */
function page(from: number, count: number): CardSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    oracleId: `ORACLE-${from + i}`, name: `Card ${from + i}`, manaCost: '{1}', cmc: 1,
    typeLine: 'Artifact', power: null, toughness: null, loyalty: null, colors: '',
    colorIdentity: '', rarity: 'rare', setCode: 'cmr', setName: 'Commander Legends',
    collectorNumber: String(from + i), imageSmall: null, imageNormal: null, priceUsd: 1,
    priceUsdFoil: null, printingId: null, ownedQuantity: 0, printingCount: 1,
  } as CardSummary));
}

/** Eric as a WU Commander deck, so identity and format narrowing both apply. */
function commanderDeck(): Deck {
  const base = deckWith('building');
  return {
    ...base,
    formatCode: 'commander',
    validation: { ...base.validation, formatCode: 'commander', formatName: 'Commander', commanderIdentity: 'WU' },
  };
}

const commanderFormat = {
  code: 'commander', display_name: 'Commander', requiresCommander: 1, isSingleton: 1,
};

async function renderPicker() {
  api.fetchDeck.mockResolvedValue(commanderDeck());
  api.fetchRunHistory.mockResolvedValue([]);
  render(
    <DeckBuilder
      deckId={1} formats={[commanderFormat]} categoryLabels={{}} onBack={() => {}}
      density="full" onDensity={() => {}}
    />,
  );
  await screen.findByTitle(/click to rename/);
  return screen.getByRole('combobox', { name: 'Search cards to add' });
}

const lastSearch = () => api.searchCards.mock.calls.at(-1)![0] as Record<string, unknown>;
const pageOf = (cards: CardSummary[], total: number): SearchResponse =>
  ({ cards, total, limit: 60, offset: 0, warnings: [] });
/** The picker's rows — not the <option>s of every <select> on the page. */
const rows = () => within(screen.getByRole('listbox', { name: 'Matching cards' })).getAllByRole('option');

describe('DeckBuilder picker paging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.innerWidth = 1400;
  });

  it('Load more appends the next page at the current offset and drops a repeat', async () => {
    api.searchCards.mockResolvedValueOnce(pageOf(page(1, 60), 100));
    const input = await renderPicker();
    fireEvent.change(input, { target: { value: 'sol' } });
    await screen.findByRole('button', { name: 'Load more' });
    expect(lastSearch()).toMatchObject({ q: 'sol', limit: 60 });
    expect(lastSearch().offset).toBeUndefined();
    expect(rows()).toHaveLength(60);

    // The second page overlaps the first by one card — the data shifted
    // between pages — and that card must not appear twice.
    api.searchCards.mockResolvedValueOnce(pageOf(page(60, 40), 100));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(99));
    expect(lastSearch()).toMatchObject({ q: 'sol', offset: 60, knownTotal: 100 });
    // The count is the server's and stays honest: 99 unique of 100 matched,
    // so the offer stands rather than pretending the list is complete.
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
    expect(screen.getAllByText('99 of 100').length).toBeGreaterThan(0);
  });

  it('a new query starts over from the first page', async () => {
    api.searchCards.mockResolvedValueOnce(pageOf(page(1, 60), 100));
    const input = await renderPicker();
    fireEvent.change(input, { target: { value: 'sol' } });
    await screen.findByRole('button', { name: 'Load more' });
    api.searchCards.mockResolvedValueOnce(pageOf(page(61, 40), 100));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(100));

    api.searchCards.mockResolvedValueOnce(pageOf(page(500, 3), 3));
    fireEvent.change(input, { target: { value: 'signet' } });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(lastSearch()).toMatchObject({ q: 'signet' });
    expect(lastSearch().offset).toBeUndefined();
    expect(lastSearch().knownTotal).toBeUndefined();
  });
});

describe('DeckBuilder picker filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.innerWidth = 1400;
  });

  it('a rarity from the panel reaches the search with the deck\'s identity and format still applied', async () => {
    api.searchCards.mockResolvedValue(pageOf(page(1, 2), 2));
    const input = await renderPicker();
    fireEvent.change(input, { target: { value: 'sol' } });
    await waitFor(() => expect(api.searchCards).toHaveBeenCalled());
    // Before the panel: the commander's identity plus colourless, and the format.
    expect(lastSearch()).toMatchObject({ colors: ['W', 'U', 'C'], format: 'commander' });
    expect(lastSearch().rarities).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    // The deck has a format, so the panel does not offer one to widen it with.
    expect(screen.queryByText('Any format')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'mythic' }));
    await waitFor(() => expect(lastSearch()).toMatchObject({ rarities: ['mythic'] }));
    expect(lastSearch()).toMatchObject({ colors: ['W', 'U', 'C'], format: 'commander', q: 'sol' });
    expect(screen.getByRole('button', { name: 'Filters · 1' })).toBeInTheDocument();

    // A colour picked in the panel is the same state the chip row shows.
    fireEvent.click(screen.getByTitle('Red'));
    await waitFor(() => expect(screen.getByTitle('R')).toHaveAttribute('aria-pressed', 'true'));
    // …but off-identity, so the identity guard holds rather than offering red cards.
    expect(lastSearch()).toMatchObject({ colors: ['W', 'U', 'C'] });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeckBuilder } from './DeckBuilder.tsx';
import type { AssemblyRun, Deck, DeckStatus } from '../api.ts';

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
  searchCards: vi.fn(async () => ({ results: [], total: 0 })),
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

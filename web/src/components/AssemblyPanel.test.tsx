import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AssemblyPanel } from './AssemblyPanel.tsx';
import type { AssemblySheet } from '../api.ts';

const api = vi.hoisted(() => ({
  cancelAssembly: vi.fn(async () => ({} as never)),
  completeAssembly: vi.fn(),
  pushMissingToWantList: vi.fn(),
  setLinePicked: vi.fn(),
}));

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  ...api,
}));

/**
 * Phase 41E #3 — opening Assemble must not leave a job behind just because the
 * user looked and closed it. A sheet with nothing ticked is a preview; closing
 * it any of the three ways discards the run so the deck header never offers to
 * "Resume pull sheet 0/N". A sheet with at least one tick is real progress and
 * stays open to resume.
 */
function sheetWith(pickedCards: number): AssemblySheet {
  return {
    run: {
      id: 7, deckId: 1, kind: 'assemble', status: 'open', movesLots: false,
      sourceRunId: null, startedAt: '', completedAt: null, notes: null,
      lineCount: 1, cardCount: 1, pickedCount: pickedCards,
      notFoundCount: 0, notFound: [],
    },
    deck: { id: 1, name: 'Test Deck', status: 'building', homeLocationId: null, homeLocationName: null },
    groups: [{
      locationId: 1, locationName: 'Binder', cardCount: 1, pickedCount: pickedCards,
      lines: [{
        id: 1, oracleId: 'a', name: 'Alpha', printingId: 'p-a', setCode: 'tst', collectorNumber: '1',
        finish: 'nonfoil', condition: 'NM', language: 'en', quantity: 1, picked: pickedCards > 0,
        unavailable: false, notes: null, collectionItemId: 1, fromLocationId: 1, fromLocationName: 'Binder',
        toLocationId: null, toLocationName: null, tradeListed: 0, unitPriceUsd: null, extendedUsd: null,
      }],
    }],
    unavailable: [],
    summary: {
      cardsToPull: 1, pickedCards, lineCount: 1, pickedLines: pickedCards > 0 ? 1 : 0,
      unavailableCards: 0, unavailableCostUsd: 0, unpricedCount: 0, tradeListedLines: 0, proxiedCards: 0,
    },
    movesLots: false,
    movesLotsBlocked: null,
    alsoPull: [],
  };
}

describe('closing an assembly sheet', () => {
  it('discards a run with nothing picked, via the Close button', async () => {
    const onClose = vi.fn();
    render(<AssemblyPanel sheet={sheetWith(0)} onClose={onClose} onFinished={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.cancelAssembly).toHaveBeenCalledWith(7);
  });

  it('leaves a run with a tick on it open — no cancel on close', async () => {
    const onClose = vi.fn();
    render(<AssemblyPanel sheet={sheetWith(1)} onClose={onClose} onFinished={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.cancelAssembly).not.toHaveBeenCalled();
  });
});

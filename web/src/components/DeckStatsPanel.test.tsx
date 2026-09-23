import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeckStatsPanel } from './DeckStatsPanel.tsx';
import type { Deck, TemplateProgress } from '../api.ts';

const stats = {
  totalCards: 40, mainCount: 40, sideboardCount: 0, commandCount: 0, uniqueCards: 20,
  averageManaValue: 2.3, manaCurve: [], colorDistribution: [], colorIdentity: 'WR',
  typeDistribution: [], estimatedValueUsd: 0,
} as unknown as Deck['stats'];

const validation = {
  formatCode: null, formatName: null, commanderIdentity: null, countedTotal: 40,
  mainCount: 40, sideboardCount: 0, commandCount: 0, maybeCount: 0,
  requiredExactSize: null, requiredMinSize: null, sideboardLimit: null,
  issues: [], isLegal: true,
} as unknown as Deck['validation'];

const manaBase = {
  requirements: [], totalPips: 0, totalSources: 0, landCount: 0,
  nonLandSources: 0, colorlessSources: 0,
} as unknown as Deck['manaBase'];

const progress = (tagDataAvailable: boolean): TemplateProgress => ({
  templateId: 1,
  templateName: 'Commander — General',
  rows: [
    { category: 'ramp', label: 'Ramp', ideal: 10, minCount: null, maxCount: null, note: null,
      sortOrder: 1, current: 0, isShort: true, isOver: false },
  ],
  uncategorisedCount: 26,
  countedTotal: 40,
  tagDataAvailable,
} as unknown as TemplateProgress);

function panel(templateProgress: TemplateProgress, onResolveCategories = vi.fn()) {
  render(
    <DeckStatsPanel
      stats={stats}
      validation={validation}
      manaBase={manaBase}
      templateProgress={templateProgress}
      showTemplates
      onResolveCategories={onResolveCategories}
      onJumpToCard={vi.fn()}
      onFilterShortfall={vi.fn()}
    />,
  );
  return onResolveCategories;
}

describe('the Template panel with no tag data', () => {
  const notice = /card categories have not been resolved/i;

  it('says why every row reads zero, rather than letting it look like the deck', () => {
    // "ramp 0/10" is indistinguishable from a deck that genuinely has no ramp,
    // which is exactly how an empty card_categories went unnoticed.
    panel(progress(false));
    expect(screen.getByText(notice)).toBeInTheDocument();
  });

  it('offers to fix it from where the problem is visible', () => {
    const onResolve = panel(progress(false));
    fireEvent.click(screen.getByRole('button', { name: 'Resolve now' }));
    expect(onResolve).toHaveBeenCalled();
  });

  it('stays out of the way once the tags are resolved', () => {
    panel(progress(true));
    expect(screen.queryByText(notice)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resolve now' })).toBeNull();
    // The rows themselves are unaffected either way.
    expect(screen.getByText('Ramp')).toBeInTheDocument();
  });
});

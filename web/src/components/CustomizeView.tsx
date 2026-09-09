import { useEffect, useRef, useState } from 'react';
import {
  DENSITIES_FOR, DENSITY_HINT, DENSITY_LABEL, type Density, type DensityPage,
} from '../density.ts';
import { GROUP_BY_LABEL, type GroupBy } from '../deckView.ts';

export type SortOption = readonly [value: string, label: string];

/**
 * Group By, Sort By and View Style in one panel.
 *
 * Shared by Browse, the collection's owned grid and the deck-builder picker,
 * which each had their own bare sort dropdown before. View Style *is* the
 * density levels — one concept, not two — so a page's override of the global
 * default is set from the same place its grouping is.
 *
 * Sorting stays where it already was: Browse and the collection sort
 * server-side, and grouping runs client-side over whatever rows are loaded.
 */
export function CustomizeView({
  page,
  density,
  onDensity,
  densityOverridden,
  onResetDensity,
  groupBy,
  onGroupBy,
  groupOptions,
  sort,
  onSort,
  sortOptions,
  showDensity = true,
  unavailableNote,
}: {
  page: DensityPage;
  density: Density;
  onDensity: (density: Density) => void;
  /** Whether this page currently overrides the topbar's global default. */
  densityOverridden: boolean;
  onResetDensity: () => void;
  groupBy: GroupBy;
  onGroupBy: (groupBy: GroupBy) => void;
  groupOptions: GroupBy[];
  sort: string;
  onSort: (sort: string) => void;
  sortOptions: readonly SortOption[];
  /** The picker's rows carry no art, so density has nothing to act on there. */
  showDensity?: boolean;
  /** Why a grouping this page cannot offer is missing, where that needs saying. */
  unavailableNote?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Same close-on-outside-tap as the alerts panel: mouse-leave never fires on
  // touch, and this panel is reachable from a phone.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: Event) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const densities = DENSITIES_FOR[page];

  return (
    <div className="customize-view" ref={ref}>
      <button
        className="btn secondary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Group, sort and size the cards on this page"
      >
        {/* The label alone, and a fixed width with it. Naming the current
            grouping and size here restated what the panel says the moment it
            opens, and grew the button enough to shove the rest of the bar
            sideways every time either changed. */}
        View
      </button>

      {open && (
        <div className="customize-drop">
          <div className="customize-section">
            <span className="customize-label">Group by</span>
            <select
              value={groupBy}
              onChange={(e) => onGroupBy(e.target.value as GroupBy)}
              aria-label="Group by"
            >
              {groupOptions.map((option) => (
                <option key={option} value={option}>{GROUP_BY_LABEL[option]}</option>
              ))}
            </select>
          </div>

          <div className="customize-section">
            <span className="customize-label">Sort by</span>
            <select value={sort} onChange={(e) => onSort(e.target.value)} aria-label="Sort by">
              {sortOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {showDensity && (
            <div className="customize-section">
              <span className="customize-label">View style</span>
              <div className="density-choices">
                {densities.map((option) => (
                  <button
                    key={option}
                    className={`density-choice${option === density ? ' on' : ''}`}
                    aria-pressed={option === density}
                    title={DENSITY_HINT[option]}
                    onClick={() => onDensity(option)}
                  >
                    {DENSITY_LABEL[option]}
                  </button>
                ))}
              </div>
              {densityOverridden ? (
                <button className="linkish" onClick={onResetDensity}>
                  Follow the global default again
                </button>
              ) : (
                <p className="note">Following the topbar default.</p>
              )}
            </div>
          )}

          {unavailableNote && <p className="note">{unavailableNote}</p>}
        </div>
      )}
    </div>
  );
}

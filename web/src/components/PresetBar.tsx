import { useEffect, useState } from 'react';
import { deletePreset, fetchPresets, savePreset, type FilterPreset } from '../api.ts';
import { EMPTY_FILTERS, type Filters } from './FilterPanel.tsx';

/**
 * Saved filter sets.
 *
 * Presets carry the search box as well as the structured filters, so something
 * like "Commander staples under 2 mana" can save `cmc<=2` alongside the format
 * and colour pills. Saving over an existing name updates it.
 */
export function PresetBar({
  filters,
  queryText,
  onApply,
}: {
  filters: Filters;
  queryText: string;
  onApply: (filters: Filters, queryText: string) => void;
}) {
  const [presets, setPresets] = useState<FilterPreset[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);

  useEffect(() => {
    fetchPresets().then(setPresets).catch((e) => setError(e.message));
  }, []);

  const run = async (action: () => Promise<FilterPreset[]>) => {
    setError(null);
    try {
      setPresets(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await run(() => savePreset(trimmed, filters, queryText || null));
    setName('');
    setNaming(false);
  };

  const apply = (preset: FilterPreset) => {
    // Merge over the defaults so a preset saved by an older build, before a
    // filter existed, still applies cleanly instead of leaving it undefined.
    onApply({ ...EMPTY_FILTERS, ...(preset.filters as Partial<Filters>) }, preset.queryText ?? '');
    setActiveId(preset.id);
  };

  return (
    <div className="fgroup presets">
      <h3>Saved filters</h3>

      {error && <div className="error">{error}</div>}

      {presets.length === 0 && !naming && (
        <p className="note">Set up filters below, then save them here to reuse.</p>
      )}

      <div className="preset-list">
        {presets.map((preset) => (
          <div className={`preset${preset.id === activeId ? ' on' : ''}`} key={preset.id}>
            <button className="preset-apply" onClick={() => apply(preset)} title={summarize(preset)}>
              {preset.name}
            </button>
            <button
              className="preset-remove"
              onClick={() => run(async () => {
                const next = await deletePreset(preset.id);
                if (activeId === preset.id) setActiveId(null);
                return next;
              })}
              aria-label={`Delete preset ${preset.name}`}
            >×</button>
          </div>
        ))}
      </div>

      {naming ? (
        <div className="preset-save">
          <input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') { setNaming(false); setName(''); }
            }}
            placeholder="Preset name"
            aria-label="Preset name"
          />
          <button className="btn" onClick={save} disabled={!name.trim()}>Save</button>
          <button className="linkish" onClick={() => { setNaming(false); setName(''); }}>Cancel</button>
        </div>
      ) : (
        <button className="linkish" onClick={() => setNaming(true)}>
          Save current filters…
        </button>
      )}
    </div>
  );
}

/** A short read-back of what a preset holds, for its tooltip. */
function summarize(preset: FilterPreset): string {
  const f = preset.filters as Partial<Filters>;
  const parts: string[] = [];
  if (preset.queryText) parts.push(`"${preset.queryText}"`);
  if (f.format) parts.push(String(f.format));
  if (f.colors?.length) parts.push(f.colors.join(''));
  if (f.rarities?.length) parts.push(f.rarities.join('/'));
  if (f.set) parts.push(String(f.set).toUpperCase());
  if (f.ownedOnly) parts.push('owned only');
  if (f.minCmc || f.maxCmc) parts.push(`mv ${f.minCmc || '0'}–${f.maxCmc || '∞'}`);
  return parts.length > 0 ? parts.join(' · ') : 'No filters set';
}

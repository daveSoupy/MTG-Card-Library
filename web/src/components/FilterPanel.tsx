import type { FormatRecord, SetRecord } from '../api.ts';

export interface Filters {
  ownedOnly: boolean;
  colors: string[];
  colorsExact: boolean;
  rarities: string[];
  set: string;
  format: string;
  minCmc: string;
  maxCmc: string;
  includeDigital: boolean;
  includeExtras: boolean;
}

export const EMPTY_FILTERS: Filters = {
  ownedOnly: false,
  colors: [],
  colorsExact: false,
  rarities: [],
  set: '',
  format: '',
  minCmc: '',
  maxCmc: '',
  includeDigital: false,
  includeExtras: false,
};

const COLORS: Array<[string, string]> = [
  ['W', 'White'], ['U', 'Blue'], ['B', 'Black'], ['R', 'Red'], ['G', 'Green'],
];
const RARITIES = ['common', 'uncommon', 'rare', 'mythic'];

export const filtersAreActive = (f: Filters): boolean =>
  f.ownedOnly || f.colors.length > 0 || f.rarities.length > 0 || f.set !== '' ||
  f.format !== '' || f.minCmc !== '' || f.maxCmc !== '' || f.includeDigital || f.includeExtras;

export function FilterPanel({
  filters,
  onChange,
  sets,
  formats,
  open,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  sets: SetRecord[];
  formats: FormatRecord[];
  open: boolean;
}) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ ...filters, [key]: value });

  const toggle = (key: 'colors' | 'rarities', value: string) => {
    const current = filters[key];
    set(key, current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);
  };

  return (
    <aside className={`filters${open ? ' open' : ''}`}>
      <div className="fgroup">
        <h3>Collection</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.ownedOnly}
            onChange={(e) => set('ownedOnly', e.target.checked)}
          />
          Owned only
        </label>
      </div>

      <div className="fgroup">
        <h3>Colour identity</h3>
        <div className="pills">
          {COLORS.map(([code, name]) => (
            <button
              key={code}
              className={`pill color ${code}`}
              aria-pressed={filters.colors.includes(code)}
              title={name}
              onClick={() => toggle('colors', code)}
            >
              {code}
            </button>
          ))}
        </div>
        {filters.colors.length > 0 && (
          <label className="check" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={filters.colorsExact}
              onChange={(e) => set('colorsExact', e.target.checked)}
            />
            Exactly these colours
          </label>
        )}
      </div>

      <div className="fgroup">
        <h3>Rarity</h3>
        <div className="pills">
          {RARITIES.map((rarity) => (
            <button
              key={rarity}
              className="pill"
              aria-pressed={filters.rarities.includes(rarity)}
              onClick={() => toggle('rarities', rarity)}
            >
              {rarity}
            </button>
          ))}
        </div>
      </div>

      <div className="fgroup">
        <h3>Mana value</h3>
        <div className="row">
          <input
            type="number" min="0" placeholder="min" value={filters.minCmc}
            onChange={(e) => set('minCmc', e.target.value)}
          />
          <span style={{ color: 'var(--text-3)' }}>to</span>
          <input
            type="number" min="0" placeholder="max" value={filters.maxCmc}
            onChange={(e) => set('maxCmc', e.target.value)}
          />
        </div>
      </div>

      <div className="fgroup">
        <h3>Format</h3>
        <select value={filters.format} onChange={(e) => set('format', e.target.value)}>
          <option value="">Any format</option>
          {formats.map((f) => (
            <option key={f.code} value={f.code}>{f.display_name}</option>
          ))}
        </select>
      </div>

      <div className="fgroup">
        <h3>Set</h3>
        <select value={filters.set} onChange={(e) => set('set', e.target.value)}>
          <option value="">Any set</option>
          {sets.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name} ({s.code.toUpperCase()})
            </option>
          ))}
        </select>
      </div>

      <div className="fgroup">
        <h3>Include</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.includeDigital}
            onChange={(e) => set('includeDigital', e.target.checked)}
          />
          Alchemy and digital-only
        </label>
        <label className="check" style={{ marginTop: 6 }}>
          <input
            type="checkbox"
            checked={filters.includeExtras}
            onChange={(e) => set('includeExtras', e.target.checked)}
          />
          Tokens, emblems and art cards
        </label>
      </div>

      {filtersAreActive(filters) && (
        <button className="linkish" onClick={() => onChange(EMPTY_FILTERS)}>
          Clear all filters
        </button>
      )}
    </aside>
  );
}

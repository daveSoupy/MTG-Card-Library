import { useEffect, useRef, useState } from 'react';

export interface ComboOption { value: string; label: string; }

/**
 * A search-as-you-type dropdown: the scrollable list people like, with a filter
 * box on top so a long list (every MTG set) is quick to narrow. Closes on an
 * outside click or Escape.
 */
export function Combobox({ options, value, onChange, placeholder }: {
  options: ComboOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const q = query.trim().toLowerCase();
  const matches = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  // Cap the rendered list so an unfiltered 1,000-set list stays snappy.
  const shown = matches.slice(0, 100);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const choose = (next: string) => { onChange(next); setOpen(false); setQuery(''); };

  return (
    <div className="combobox" ref={ref}>
      <input
        value={open ? query : (selected?.label ?? '')}
        placeholder={placeholder}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); } }}
        aria-label={placeholder}
      />
      {open && (
        <div className="combobox-list">
          {shown.length === 0 && <div className="combobox-empty">No matches</div>}
          {shown.map((o) => (
            <button
              key={o.value}
              className={`combobox-option${o.value === value ? ' on' : ''}`}
              onClick={() => choose(o.value)}
            >
              {o.label}
            </button>
          ))}
          {matches.length > shown.length && (
            <div className="combobox-empty">{matches.length - shown.length} more — keep typing…</div>
          )}
        </div>
      )}
    </div>
  );
}

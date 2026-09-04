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
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);
  const q = query.trim().toLowerCase();
  const matches = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  // Cap the rendered list so an unfiltered 1,000-set list stays snappy.
  const shown = matches.slice(0, 100);

  useEffect(() => {
    // pointerdown covers touch as well as mouse, so a tap outside closes it.
    const onDown = (event: Event) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  const choose = (next: string) => {
    onChange(next);
    setQuery('');
    setOpen(false);
    // Drop focus so the field can't immediately re-open (and the phone keyboard
    // dismisses), which is what left the list hanging open on mobile.
    inputRef.current?.blur();
  };

  return (
    <div className="combobox" ref={ref}>
      <input
        ref={inputRef}
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
              // pointerDown + preventDefault: selects before the input blurs, so
              // the tap is never lost and the list closes at once on touch.
              onPointerDown={(e) => { e.preventDefault(); choose(o.value); }}
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

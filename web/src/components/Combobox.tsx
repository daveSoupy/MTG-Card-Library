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
  // When a choice was just made, so the focus iOS bounces back to the field
  // right afterwards can be ignored instead of re-opening the list.
  const chosenAt = useRef(0);

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

  // Backstop: any change to the chosen value closes the list. Combined with the
  // focus guard below, a selection can't leave it hanging open on iOS.
  useEffect(() => { setOpen(false); }, [value]);

  const choose = (next: string) => {
    chosenAt.current = Date.now();
    onChange(next);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="combobox" ref={ref}>
      <input
        ref={inputRef}
        value={open ? query : (selected?.label ?? '')}
        placeholder={placeholder}
        onFocus={() => {
          // Ignore the focus iOS bounces back into the field right after a pick,
          // which was re-opening the list; a real re-tap later still opens it.
          if (Date.now() - chosenAt.current < 600) { inputRef.current?.blur(); return; }
          setOpen(true); setQuery('');
        }}
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
              // Select on click, not pointerdown: a click never fires during a
              // scroll drag, so the list stays scrollable on touch. choose()
              // closes the list and blurs the field, so it doesn't linger.
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

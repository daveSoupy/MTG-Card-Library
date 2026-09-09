import { useEffect, useRef, useState } from 'react';

/**
 * The manual category on a deck slot, as a checklist.
 *
 * Free text is gone: what a category is worth is being counted by a template
 * row, and a typo could never be. So the list is exactly the categories the
 * server resolves, ticked rather than typed — several at once, since a card
 * that is genuinely both ramp and card draw should satisfy both rows.
 *
 * Values are stored as labels ("Board wipes") rather than keys ("sweeper"):
 * the server matches either, and the label is what a group heading shows.
 */

/** Splits the stored form. The server normalises it, so this only reads. */
function entriesOf(value: string | null | undefined): string[] {
  return (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

export function CategoryPicker({
  value,
  labels,
  onChange,
  cardName,
}: {
  /** The stored comma-separated list, or null for no override. */
  value: string | null;
  /** Category key → display name, from /api/v1/status. */
  labels: Record<string, string>;
  onChange: (next: string | null) => void;
  cardName: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  /**
   * What has been ticked but not yet confirmed by the server.
   *
   * Each toggle round-trips through the deck, so `value` is a tick behind. Two
   * quick ticks would otherwise both compute from the same pre-first state and
   * the second would drop the first — the same race the want-list toggle
   * guards against, and the reason ticking two boxes fast lost one of them.
   */
  const [pending, setPending] = useState<string[] | null>(null);

  // The server has caught up (or rejected it) — either way, follow it again.
  useEffect(() => { setPending(null); }, [value]);

  // Same close-on-outside-tap as the alerts and view panels; mouse-leave never
  // fires on touch, and the deck list is reachable from a phone.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: Event) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const entries = pending ?? entriesOf(value);
  const isTicked = (key: string, label: string) =>
    entries.some((e) => e.toLowerCase() === key.toLowerCase() || e.toLowerCase() === label.toLowerCase());

  const canonical = Object.entries(labels);
  // Anything already on this card that is no longer offered — a category typed
  // back when this was a free-text box. Shown ticked so it can be seen and
  // removed, rather than silently dropped the next time the card is edited.
  const legacy = entries.filter(
    (entry) => !canonical.some(([key, label]) =>
      entry.toLowerCase() === key.toLowerCase() || entry.toLowerCase() === label.toLowerCase()),
  );

  const toggle = (label: string, ticked: boolean) => {
    const next = ticked
      ? entries.filter((e) => e.toLowerCase() !== label.toLowerCase())
      : [...entries, label];
    setPending(next);
    onChange(next.length > 0 ? next.join(', ') : null);
  };

  const summary = entries.length > 0 ? entries.join(', ') : 'Category';

  return (
    <div className="category-picker" ref={ref}>
      <button
        className={`category-summary${entries.length > 0 ? ' set' : ''}`}
        aria-expanded={open}
        aria-label={`Categories for ${cardName}`}
        title={entries.length > 0
          ? `Counted as ${summary} — overrides Scryfall's tags`
          : 'Count this card as something specific, overriding Scryfall’s tags'}
        onClick={() => setOpen((v) => !v)}
      >
        {summary}
      </button>

      {open && (
        <div className="category-drop">
          {canonical.map(([key, label]) => {
            const ticked = isTicked(key, label);
            return (
              <label className="category-option" key={key}>
                <input type="checkbox" checked={ticked} onChange={() => toggle(label, ticked)} />
                {label}
              </label>
            );
          })}

          {legacy.map((entry) => (
            <label className="category-option legacy" key={entry}>
              <input type="checkbox" checked onChange={() => toggle(entry, true)} />
              {entry}
              <span className="hint">no longer offered</span>
            </label>
          ))}

          {entries.length > 0 && (
            <button className="linkish" onClick={() => { setPending([]); onChange(null); }}>
              Clear — use Scryfall’s tags
            </button>
          )}
        </div>
      )}
    </div>
  );
}

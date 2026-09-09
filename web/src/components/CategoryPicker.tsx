import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The manual category on a deck slot, as a checklist.
 *
 * Free text is gone: a category is only worth anything if a template row counts
 * it, and a typo never could. So the list is exactly the categories the server
 * resolves, ticked rather than typed — several at once, since a card that is
 * genuinely both ramp and card draw should satisfy both rows.
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
  /**
   * The working selection, non-null exactly while the list is open.
   *
   * Nothing is saved until the list closes, which is what makes this a
   * checklist rather than eight one-shot buttons. Saving per tick wrote to the
   * deck mid-interaction, and with the list grouped by category that moved the
   * row into another group — remounting this control and closing it, so only
   * ever one box could be ticked.
   */
  const [draft, setDraft] = useState<string[] | null>(null);
  const [at, setAt] = useState<{ top: number; left: number; width: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const drop = useRef<HTMLDivElement>(null);

  const open = draft !== null;
  const entries = draft ?? entriesOf(value);

  const commit = (next: string[]) => {
    setDraft(null);
    setAt(null);
    const stored = next.length > 0 ? next.join(', ') : null;
    if (stored !== (value ?? null)) onChange(stored);
  };
  const close = () => { if (draft) commit(draft); else { setDraft(null); setAt(null); } };

  /**
   * Anchored to the viewport rather than the button.
   *
   * The deck list is its own scroll container, so a panel positioned inside a
   * row is clipped by it — the last options were cut off the bottom.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!button.current) return;
      const rect = button.current.getBoundingClientRect();
      // documentElement first, and a floor under both: a viewport that reads
      // as zero — which it does for a frame mid-navigation — would otherwise
      // put the panel somewhere off-screen it could never recover from.
      const vw = document.documentElement.clientWidth || window.innerWidth || 1024;
      const vh = document.documentElement.clientHeight || window.innerHeight || 768;
      const height = Math.min(drop.current?.offsetHeight || 280, vh - 16);
      const width = Math.max(rect.width, 180);
      setAt({
        // Flipped above the control when there is not room below it.
        top: vh - rect.bottom < height + 8
          ? Math.max(8, rect.top - height - 4)
          : Math.min(rect.bottom + 4, vh - height - 8),
        left: Math.min(Math.max(8, rect.right - width), Math.max(8, vw - width - 8)),
        width,
      });
    };
    place();
    // Once more after paint: the first pass measures the panel before the
    // browser has laid it out, so its height is a guess until then.
    const frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: Event) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || drop.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    // A viewport-anchored panel would drift away from its row on a scroll.
    const onScroll = () => close();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  });

  const canonical = Object.entries(labels);
  const matches = (entry: string, key: string, label: string) =>
    entry.toLowerCase() === key.toLowerCase() || entry.toLowerCase() === label.toLowerCase();
  const isTicked = (key: string, label: string) =>
    entries.some((entry) => matches(entry, key, label));

  // Anything on this card that is no longer offered — a category typed back
  // when this was a free-text box. Shown ticked so it can be seen and removed,
  // rather than silently dropped the next time the card is edited.
  const legacy = entries.filter(
    (entry) => !canonical.some(([key, label]) => matches(entry, key, label)),
  );

  const toggle = (label: string, ticked: boolean) => setDraft(
    ticked
      ? entries.filter((e) => e.toLowerCase() !== label.toLowerCase())
      : [...entries, label],
  );

  const summary = entries.length > 0 ? entries.join(', ') : 'Category';

  return (
    <div className="category-picker" ref={ref}>
      <button
        ref={button}
        className={`category-summary${entries.length > 0 ? ' set' : ''}${open ? ' open' : ''}`}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Categories for ${cardName}`}
        title={entries.length > 0
          ? `Counted as ${summary} — overrides Scryfall's tags`
          : 'Count this card as something specific, overriding Scryfall’s tags'}
        onClick={() => (open ? close() : setDraft(entriesOf(value)))}
      >
        <span className="category-summary-text">{summary}</span>
        <span className="category-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div
          className="category-drop"
          ref={drop}
          style={at ? { top: at.top, left: at.left, minWidth: at.width } : { visibility: 'hidden' }}
        >
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

          <div className="category-drop-foot">
            {entries.length > 0 && (
              <button className="linkish" onClick={() => setDraft([])}>Clear</button>
            )}
            <button className="btn secondary small" onClick={close}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

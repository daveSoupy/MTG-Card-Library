import { useEffect, useRef, useState } from 'react';
import {
  DECK_STATUSES, DECK_STATUS_HINT, DECK_STATUS_LABEL, DECK_STATUS_RESERVES,
  type DeckStatus,
} from '../api.ts';
import { useNarrow } from '../viewport.ts';

/**
 * The single most-glanced-at fact about a deck: whether it is holding cards.
 *
 * Colour-coded through `data-status`, so the four states are distinguishable
 * before the label is read. The pill says what the deck *is*; the line under
 * each option in the menu says what that costs you in cardboard, because
 * "brew" and "assembled" only differ in a way you cannot see from the name.
 *
 * The menu is a popover beside the pill on a desktop and a bottom sheet on a
 * phone — the same split (and the same 760px) as the deck header it sits in.
 * The pill lives at the right end of that header, so a popover hung off its
 * left edge runs off a phone screen with every hint clipped mid-word.
 */
export function DeckStatusPill({
  status,
  onChange,
  disabled,
}: {
  status: DeckStatus;
  onChange: (next: DeckStatus) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Which edge of the pill the desktop popover hangs from. Decided as it
  // opens, from where the pill sits in its row: a pill in the right half
  // grows leftwards so the menu stays inside the row it belongs to.
  const [align, setAlign] = useState<'left' | 'right'>('left');
  const sheet = useNarrow(760);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    const pill = wrapper.current;
    const row = pill?.parentElement;
    if (pill && row) {
      const pillBox = pill.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const pillMid = pillBox.left + pillBox.width / 2;
      setAlign(pillMid > rowBox.left + rowBox.width / 2 ? 'right' : 'left');
    }
    setOpen((current) => !current);
  };

  const menu = (
    <div className="status-menu" role="listbox" aria-label="Deck status" data-align={align}>
      {DECK_STATUSES.map((option) => (
        <button
          key={option}
          role="option"
          aria-selected={option === status}
          className={option === status ? 'on' : ''}
          data-status={option}
          onClick={() => { setOpen(false); if (option !== status) onChange(option); }}
        >
          <span className="status-menu-label">
            <span className="status-dot" data-status={option} aria-hidden="true" />
            {DECK_STATUS_LABEL[option]}
            <span className="status-menu-reserve">
              {DECK_STATUS_RESERVES[option] ? 'claims copies' : 'claims nothing'}
            </span>
          </span>
          <span className="status-menu-hint">{DECK_STATUS_HINT[option]}</span>
        </button>
      ))}
      <p className="status-menu-foot">
        Changing this never edits what the deck says it draws from your collection —
        it only decides whether those copies count as spoken for.
      </p>
    </div>
  );

  return (
    <div className="status-pill-wrap" ref={wrapper}>
      <button
        className="status-pill"
        data-status={status}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
        title={DECK_STATUS_HINT[status]}
      >
        {DECK_STATUS_LABEL[status]}
      </button>

      {open && (sheet ? (
        // The backdrop is inside the wrapper, so the outside-click listener
        // above never sees a tap on it; the backdrop closes itself instead.
        <div className="status-sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="status-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="floating-head">
              <span className="count">Deck status</span>
              <button className="btn secondary" onClick={() => setOpen(false)}>Done</button>
            </div>
            {menu}
          </div>
        </div>
      ) : menu)}
    </div>
  );
}

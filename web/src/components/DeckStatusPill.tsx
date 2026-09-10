import { useEffect, useRef, useState } from 'react';
import {
  DECK_STATUSES, DECK_STATUS_HINT, DECK_STATUS_LABEL, DECK_STATUS_RESERVES,
  type DeckStatus,
} from '../api.ts';

/**
 * The single most-glanced-at fact about a deck: whether it is holding cards.
 *
 * Colour-coded through `data-status`, so the four states are distinguishable
 * before the label is read. The pill says what the deck *is*; the line under
 * each option in the menu says what that costs you in cardboard, because
 * "brew" and "assembled" only differ in a way you cannot see from the name.
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

  return (
    <div className="status-pill-wrap" ref={wrapper}>
      <button
        className="status-pill"
        data-status={status}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        title={DECK_STATUS_HINT[status]}
      >
        {DECK_STATUS_LABEL[status]}
      </button>

      {open && (
        <div className="status-menu" role="listbox" aria-label="Deck status">
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
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { imageUrl, type DeckCard } from '../api.ts';
import type { Density } from '../density.ts';

export function DeckTile({
  card,
  problem,
  onQuantity,
  onArt,
  onRemove,
  density = 'full',
  onPreview,
  tapOpensPreview = false,
  cascade,
  categoryLabel,
}: {
  card: DeckCard;
  problem: 'error' | 'warning' | null;
  onQuantity: (delta: number) => void;
  onArt: () => void;
  onRemove: () => void;
  /** Only Lined-up changes a tile: Full and Compact size the grid around it,
   *  and Ultra-compact renders `DeckRow` instead of any tile at all. */
  density?: Density;
  /** Lined-up covers all but a name strip, so hovering one shows it whole —
   *  the same callback `DeckRow` already uses in the text list. */
  onPreview?: () => void;
  /** Touch has no hover, so in Lined-up a tap shows the card instead of the
   *  controls. A deliberate exception to Phase 9's tap-to-reveal pattern. */
  tapOpensPreview?: boolean;
  /** Lined-up only. 'stacked' is what the stylesheet pulls up over the card
   *  before it; the first card in a column sits where it falls. */
  cascade?: 'first' | 'stacked';
  /** The one bucket this card groups under, already resolved and labelled by
   *  the caller. Shown at Full and Compact; Lined-up has no room for it. */
  categoryLabel?: string;
}) {
  // The controls are a hover affordance on a desktop, and hover never fires on
  // a touch screen — which left the qty stepper and the art picker unreachable
  // on a phone. A tap toggles the same controls open; hover is untouched.
  const [open, setOpen] = useState(false);
  const tile = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocument = (event: Event) => {
      const target = event.target as Node | null;
      if (target && tile.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('click', onDocument);
    return () => document.removeEventListener('click', onDocument);
  }, [open]);

  const lined = density === 'lined';

  return (
    <div
      ref={tile}
      className={`deck-tile${problem ? ` ${problem}` : ''}${open ? ' controls-open' : ''}`}
      data-oracle={card.oracleId}
      data-cascade={cascade}
      title={`${card.name} — ${card.typeLine}`}
      onMouseEnter={lined ? onPreview : undefined}
      onClick={(event) => {
        // A tap on a control is the control's, not a toggle: the menu stays up
        // so the stepper can be pressed more than once.
        if ((event.target as HTMLElement).closest('.tile-controls')) return;
        if (tapOpensPreview) { onPreview?.(); return; }
        setOpen((current) => !current);
      }}
    >
      {card.printingId && card.imageSmall ? (
        <img src={imageUrl(card.printingId, 'small')} alt={card.name} loading="lazy" decoding="async" />
      ) : (
        <div className="placeholder">{card.name}</div>
      )}

      <span className="tile-qty">{card.quantity}</span>
      {card.quantityFromCollection > 0 && (
        <span className="tile-owned" title="Claimed from your collection">
          {card.quantityFromCollection}
        </span>
      )}
      {/* Lined-up leaves only the card's own printed name/cost strip showing.
          A placeholder has no printed name, so it gets one. */}
      {lined && !(card.printingId && card.imageSmall) && (
        <span className="cascade-strip">{card.name}</span>
      )}
      {/* Under the art rather than over it: the tile is already dense, and
          covering a card's own text to say what it does would be perverse. */}
      {!lined && categoryLabel && <div className="tile-category">{categoryLabel}</div>}

      {/* Controls sit over the art on hover — or after a tap — so the grid
          stays scannable when you are only reading it. */}
      <div className="tile-controls">
        <button onClick={() => onQuantity(-1)} aria-label={`One fewer ${card.name}`}>−</button>
        <button onClick={() => onQuantity(1)} aria-label={`One more ${card.name}`}>+</button>
        <button onClick={onArt} aria-label={`Choose art for ${card.name}`} title="Choose printing / art">◆</button>
        <button onClick={onRemove} aria-label={`Remove ${card.name}`}>×</button>
      </div>
    </div>
  );
}

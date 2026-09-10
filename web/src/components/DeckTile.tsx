import { useEffect, useRef, useState } from 'react';
import { imageUrl, type BuildabilityRow, type DeckCard } from '../api.ts';
import { slotAction } from '../deckSlot.ts';
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
  coverage,
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
  /** Phase 24's coverage for this card, when the deck's figures are loaded.
   *  Absent while they are in flight — the tile simply shows no chip. */
  coverage?: BuildabilityRow | null;
}) {
  // The same chip the text row shows, so every density finally says the same
  // thing about a card. Absent while the deck's figures are still loading.
  const action = slotAction(card, coverage);
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
      {card.quantityProxied > 0 && (
        <span className="tile-proxied" title="Filled by a proxy — neither owned nor to buy">
          {card.quantityProxied}p
        </span>
      )}
      {/* What to do about this card, in the same words the text row uses. The
          deck's claim on the collection is the server's business now, so there
          is no count of it here to misread. */}
      {action && action.kind !== 'untracked' && (
        <span className="tile-chip" data-kind={action.kind} title={action.title}>
          {action.label}
        </span>
      )}
      {/* Lined-up leaves only the card's own printed name/cost strip showing.
          A placeholder has no printed name, so it gets one. */}
      {lined && !(card.printingId && card.imageSmall) && (
        <span className="cascade-strip">{card.name}</span>
      )}

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

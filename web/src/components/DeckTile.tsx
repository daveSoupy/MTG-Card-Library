import { useEffect, useRef, useState } from 'react';
import { imageUrl, type DeckCard } from '../api.ts';
import type { Density } from '../density.ts';

const money = (value: number | null | undefined) =>
  value == null ? '—' : `$${Number(value).toFixed(2)}`;

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
}: {
  card: DeckCard;
  problem: 'error' | 'warning' | null;
  onQuantity: (delta: number) => void;
  onArt: () => void;
  onRemove: () => void;
  density?: Density;
  /** Lined-up covers all but a name strip, so hovering one shows it whole —
   *  the same callback `DeckRow` already uses in list view. */
  onPreview?: () => void;
  /** Touch has no hover, so in Lined-up a tap shows the card instead of the
   *  controls. A deliberate exception to Phase 9's tap-to-reveal pattern. */
  tapOpensPreview?: boolean;
  /** Lined-up only. 'stacked' is what the stylesheet pulls up over the card
   *  before it; the first card in a column sits where it falls. */
  cascade?: 'first' | 'stacked';
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
      {/* Ultra-compact has no art element at all — not a hidden one. The row
          carries what the art was standing in for. */}
      {density === 'ultra' ? (
        <div className="text-row">
          <span className="tr-qty">×{card.quantity}</span>
          <span className="tr-name">{card.name}</span>
          <span className="tr-set">
            {card.manaCost ?? ''}
            {card.setCode ? ` · ${card.setCode.toUpperCase()}` : ''}
          </span>
          <span className="tr-price">{money(card.priceUsd)}</span>
        </div>
      ) : (
        <>
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
          {/* Lined-up leaves only the card's own printed name/cost strip
              showing. A placeholder has no printed name, so it gets one. */}
          {lined && !(card.printingId && card.imageSmall) && (
            <span className="cascade-strip">{card.name}</span>
          )}
        </>
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

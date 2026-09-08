import { useEffect, useRef, useState } from 'react';
import { imageUrl, type DeckCard } from '../api.ts';

export function DeckTile({
  card,
  problem,
  onQuantity,
  onArt,
  onRemove,
}: {
  card: DeckCard;
  problem: 'error' | 'warning' | null;
  onQuantity: (delta: number) => void;
  onArt: () => void;
  onRemove: () => void;
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

  return (
    <div
      ref={tile}
      className={`deck-tile${problem ? ` ${problem}` : ''}${open ? ' controls-open' : ''}`}
      data-oracle={card.oracleId}
      title={`${card.name} — ${card.typeLine}`}
      onClick={(event) => {
        // A tap on a control is the control's, not a toggle: the menu stays up
        // so the stepper can be pressed more than once.
        if ((event.target as HTMLElement).closest('.tile-controls')) return;
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

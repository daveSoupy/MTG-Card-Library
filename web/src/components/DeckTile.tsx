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
  return (
    <div
      className={`deck-tile${problem ? ` ${problem}` : ''}`}
      data-oracle={card.oracleId}
      title={`${card.name} — ${card.typeLine}`}
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

      {/* Controls sit over the art on hover so the grid
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

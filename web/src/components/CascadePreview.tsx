import { imageUrl, type DeckCard } from '../api.ts';

/**
 * The card a Lined-up strip was clicked on, shown whole and held still.
 *
 * Lined-up covers all but a name strip. A mouse over the strip shows the card
 * beside the cursor, but that goes the moment the pointer moves; this stays,
 * with the tile's controls laid out under it — quantity, art, details, remove
 * — so a covered card can be changed without hunting for a hover target. On a
 * touch screen, which has no hover at all, it is the only way in.
 */
export function CascadePreview({
  card,
  onQuantity,
  onArt,
  onDetail,
  onRemove,
  onClose,
}: {
  card: DeckCard;
  onQuantity: (delta: number) => void;
  onArt: () => void;
  onDetail?: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <div className="cascade-preview" role="dialog" aria-label={card.name} onClick={onClose}>
      <div className="cascade-preview-body" onClick={(event) => event.stopPropagation()}>
        {card.printingId && card.imageSmall ? (
          <img src={imageUrl(card.printingId, 'normal')} alt={card.name} decoding="async" />
        ) : (
          <div className="placeholder">{card.name}</div>
        )}

        <div className="cascade-preview-bar">
          <strong>{card.name}</strong>
          <span className="count">×{card.quantity}</span>
          <button className="btn secondary small" onClick={onClose}>Close</button>
        </div>

        <div className="cascade-preview-controls">
          <button onClick={() => onQuantity(-1)} aria-label={`One fewer ${card.name}`}>−</button>
          <button onClick={() => onQuantity(1)} aria-label={`One more ${card.name}`}>+</button>
          <button onClick={onArt} aria-label={`Choose art for ${card.name}`} title="Choose printing / art">◆</button>
          {onDetail && (
            <button onClick={onDetail} aria-label={`Details for ${card.name}`} title="Card details">ⓘ</button>
          )}
          <button onClick={() => { onRemove(); onClose(); }} aria-label={`Remove ${card.name}`}>×</button>
        </div>
      </div>
    </div>
  );
}

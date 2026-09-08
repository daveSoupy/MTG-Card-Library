import { useState } from 'react';
import { imageUrl, type DeckCard } from '../api.ts';

/**
 * The card a Lined-up tile was tapped on, shown whole.
 *
 * Lined-up covers all but a name strip, and a touch screen has no hover to
 * uncover it with — so on touch a tap opens this instead of the tile controls.
 * Those controls are still one button away rather than gone.
 */
export function CascadePreview({
  card,
  onQuantity,
  onArt,
  onRemove,
  onClose,
}: {
  card: DeckCard;
  onQuantity: (delta: number) => void;
  onArt: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [showControls, setShowControls] = useState(false);

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
          <button
            className="btn secondary small"
            aria-expanded={showControls}
            aria-label={`Edit ${card.name}`}
            title="Quantity, art and remove"
            onClick={() => setShowControls((v) => !v)}
          >
            ⋯
          </button>
          <button className="btn secondary small" onClick={onClose}>Close</button>
        </div>

        {showControls && (
          <div className="cascade-preview-controls">
            <button onClick={() => onQuantity(-1)} aria-label={`One fewer ${card.name}`}>−</button>
            <button onClick={() => onQuantity(1)} aria-label={`One more ${card.name}`}>+</button>
            <button onClick={onArt} aria-label={`Choose art for ${card.name}`} title="Choose printing / art">◆</button>
            <button onClick={() => { onRemove(); onClose(); }} aria-label={`Remove ${card.name}`}>×</button>
          </div>
        )}
      </div>
    </div>
  );
}

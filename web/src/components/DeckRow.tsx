import type { Board, BuildabilityRow, DeckCard } from '../api.ts';
import { effectiveCategories, identityKey } from '../deckView.ts';
import { canSwap, slotAction, swapTitle } from '../deckSlot.ts';
import { ManaCost } from './ManaCost.tsx';

export function DeckRow({
  card,
  problem,
  onQuantity,
  onBoard,
  onRemove,
  onPreview,
  onArt,
  categoryLabels,
  coverage,
  onSwap,
}: {
  card: DeckCard;
  problem: 'error' | 'warning' | null;
  onQuantity: (delta: number) => void;
  onBoard: (board: Board) => void;
  onRemove: () => void;
  onPreview: () => void;
  onArt: () => void;
  /** Category key → display name, from /api/v1/status. */
  categoryLabels: Record<string, string>;
  /** Phase 24's coverage for this card, when the deck's figures are loaded. */
  coverage?: BuildabilityRow | null;
  /** Phase 27: opens the substitutes sheet. Makes a Buy/held chip a button. */
  onSwap?: () => void;
}) {
  const action = slotAction(card, coverage);
  const categories = effectiveCategories(card, categoryLabels);

  return (
    // The colour bar down the left edge reads a decklist the way a pile of
    // cards does. Keyed off the same identity buckets deckView.ts groups by, so
    // a colour-grouped list and its tints can never disagree.
    <div
      className={`deck-row${problem ? ` ${problem}` : ''}`}
      data-identity={identityKey(card.colorIdentity)}
      onMouseEnter={onPreview}
    >
      <div className="qty">
        <button onClick={() => onQuantity(-1)} aria-label={`One fewer ${card.name}`}>−</button>
        <span>{card.quantity}</span>
        <button onClick={() => onQuantity(1)} aria-label={`One more ${card.name}`}>+</button>
      </div>

      <button className="deck-name" onClick={onPreview} title={card.typeLine}>
        {card.name}
        {/* What the template rows count this card as, read rather than set —
            quiet enough beside the name to scan past when you are not looking
            for it. */}
        {categories.length > 0 && (
          <span className="deck-name-tags" title={`Counted as ${categories.join(', ')}`}>
            {categories.join(', ')}
          </span>
        )}
        {card.legality === 'banned' && <span className="tag bad">banned</span>}
        {card.legality === 'restricted' && <span className="tag warn">restricted</span>}
      </button>

      <ManaCost cost={card.manaCost} cmc={card.cmc} />

      {/* One grid cell, so a basic land — which reads only "basic" — does not
          shift every column after it. Empty while the deck's figures load: a
          blank cell for a moment beats a wrong one. */}
      <div className="slot-alloc">
        {/* A chip you cannot act on is a label; one that says "Buy 2" is also
            the way in to what you already own that would do instead. */}
        {action && (onSwap && canSwap(action) ? (
          <button
            className="slot-chip swappable"
            data-kind={action.kind}
            title={swapTitle(action)}
            onClick={onSwap}
          >
            {action.label}
          </button>
        ) : (
          <span className="slot-chip" data-kind={action.kind} title={action.title}>
            {action.label}
          </span>
        ))}
      </div>

      <select
        className="board-select"
        value={card.board}
        onChange={(e) => onBoard(e.target.value as Board)}
        aria-label={`Move ${card.name}`}
      >
        <option value="main">Deck</option>
        <option value="side">Sideboard</option>
        <option value="command">Command zone</option>
        <option value="maybe">Maybeboard</option>
      </select>

      <button className="row-art" onClick={onArt} aria-label={`Choose art for ${card.name}`} title="Choose printing / art">◆</button>
      <button className="row-remove" onClick={onRemove} aria-label={`Remove ${card.name}`}>×</button>
    </div>
  );
}

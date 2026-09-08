import type { Board, DeckCard } from '../api.ts';

export function DeckRow({
  card,
  problem,
  onQuantity,
  onBoard,
  onRemove,
  onToggleOwned,
  onPreview,
  onArt,
  onCategory,
  categoryOptions,
}: {
  card: DeckCard;
  problem: 'error' | 'warning' | null;
  onQuantity: (delta: number) => void;
  onBoard: (board: Board) => void;
  onRemove: () => void;
  onToggleOwned: () => void;
  onPreview: () => void;
  onArt: () => void;
  /** A manual category always wins over Scryfall's tag-derived ones; empty clears it. */
  onCategory: (category: string | null) => void;
  categoryOptions: string[];
}) {
  const claimed = card.quantityFromCollection;
  const shortfall = claimed > card.availableQuantity;

  return (
    <div className={`deck-row${problem ? ` ${problem}` : ''}`} onMouseEnter={onPreview}>
      <div className="qty">
        <button onClick={() => onQuantity(-1)} aria-label={`One fewer ${card.name}`}>−</button>
        <span>{card.quantity}</span>
        <button onClick={() => onQuantity(1)} aria-label={`One more ${card.name}`}>+</button>
      </div>

      <button className="deck-name" onClick={onPreview} title={card.typeLine}>
        {card.name}
        {card.legality === 'banned' && <span className="tag bad">banned</span>}
        {card.legality === 'restricted' && <span className="tag warn">restricted</span>}
      </button>

      <span className="mana">{card.manaCost ?? ''}</span>

      <button
        className={`owned-chip${claimed > 0 ? ' on' : ''}${shortfall ? ' short' : ''}`}
        onClick={onToggleOwned}
        title={
          card.ownedQuantity === 0
            ? 'You do not own this card yet — counted as "need to buy"'
            : `You own ${card.ownedQuantity}; ${card.availableQuantity} not claimed by other decks`
        }
      >
        {claimed > 0 ? `${claimed} owned` : 'to buy'}
      </button>

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

      <input
        className="row-category"
        list={`deck-categories-${card.id}`}
        defaultValue={card.category ?? ''}
        placeholder={card.categories.length > 0 ? card.categories.join(', ') : 'Category'}
        title={card.category
          ? 'Manual category — wins over any tag-derived one'
          : card.categories.length > 0
            ? `Tag-derived: ${card.categories.join(', ')}. Type to override.`
            : 'No category yet'}
        onBlur={(e) => onCategory(e.target.value.trim() || null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        aria-label={`Category for ${card.name}`}
      />
      <datalist id={`deck-categories-${card.id}`}>
        {categoryOptions.map((option) => <option key={option} value={option} />)}
      </datalist>

      <button className="row-art" onClick={onArt} aria-label={`Choose art for ${card.name}`} title="Choose printing / art">◆</button>
      <button className="row-remove" onClick={onRemove} aria-label={`Remove ${card.name}`}>×</button>
    </div>
  );
}

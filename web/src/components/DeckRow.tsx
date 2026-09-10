import type { Board, DeckCard } from '../api.ts';
import { effectiveCategories, identityKey } from '../deckView.ts';
import { ownedChip } from '../deckSlot.ts';

export function DeckRow({
  card,
  problem,
  onQuantity,
  onBoard,
  onRemove,
  onToggleOwned,
  onProxy,
  onPreview,
  onArt,
  categoryLabels,
}: {
  card: DeckCard;
  problem: 'error' | 'warning' | null;
  onQuantity: (delta: number) => void;
  onBoard: (board: Board) => void;
  onRemove: () => void;
  onToggleOwned: () => void;
  /** Steps `quantity_proxied` by ±1. Clamped by the caller, refused by the API. */
  onProxy: (delta: number) => void;
  onPreview: () => void;
  onArt: () => void;
  /** Category key → display name, from /api/v1/status. */
  categoryLabels: Record<string, string>;
}) {
  const chip = ownedChip(card);
  const categories = effectiveCategories(card, categoryLabels);
  const proxyRoom = card.quantity - card.quantityFromCollection - card.quantityProxied;

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

      <span className="mana">{card.manaCost ?? ''}</span>

      {/* One grid cell, so a basic land — which gets no badge and no stepper —
          does not shift every column after it. A basic under the exemption is
          not tracked at all: a blank badge beats a wrong one, and a proxy of a
          card nobody counts would be counting nothing. */}
      <div className="slot-alloc">
        {card.allocationTracked ? (
          <>
            <button
              className={`owned-chip${chip.claimed > 0 ? ' on' : ''}${chip.short ? ' short' : ''}`}
              onClick={onToggleOwned}
              title={chip.title}
            >
              {chip.label}
            </button>

            <div className="proxy-step" title={chip.title}>
              <button
                onClick={() => onProxy(-1)}
                disabled={card.quantityProxied === 0}
                aria-label={`One fewer proxy of ${card.name}`}
              >
                −
              </button>
              <span className={card.quantityProxied > 0 ? 'on' : ''}>
                {card.quantityProxied > 0 ? `${card.quantityProxied} proxy` : 'proxy'}
              </span>
              <button
                onClick={() => onProxy(1)}
                disabled={proxyRoom <= 0}
                aria-label={`One more proxy of ${card.name}`}
              >
                +
              </button>
            </div>
          </>
        ) : (
          <span className="owned-chip untracked" title={chip.title}>basic</span>
        )}
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

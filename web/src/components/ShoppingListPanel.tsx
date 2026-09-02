import { useCallback, useEffect, useState } from 'react';
import { fetchShoppingList, imageUrl, pushToWantList, type ShoppingList } from '../api.ts';

const money = (value: number | null) => (value == null ? '—' : `$${value.toFixed(2)}`);

/**
 * What a deck still needs buying.
 *
 * No separate table backs this: a slot's shortfall is
 * `quantity - quantity_from_collection`, which allocation already maintains, so
 * the list cannot drift out of step with the deck.
 */
export function ShoppingListPanel({ deckId, onClose }: { deckId: number; onClose: () => void }) {
  const [list, setList] = useState<ShoppingList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushed, setPushed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchShoppingList(deckId).then(setList).catch((e) => setError(e.message));
  }, [deckId]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const push = async (oracleIds?: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await pushToWantList(deckId, oracleIds);
      const total = result.added + result.updated;
      setPushed(`${total} card${total === 1 ? '' : 's'} on "${result.listName}".`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="playtest-card" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h2>Shopping list</h2>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {error && <div className="error">{error}</div>}
        {pushed && <div className="verdict ok">Added {pushed}</div>}
        {!list && !error && <p className="loading">Loading…</p>}

        {list && list.entries.length === 0 && (
          <p className="empty">
            Nothing to buy — every card in this deck is covered by copies you already own.
          </p>
        )}

        {list && list.entries.length > 0 && (
          <>
            <div className="playtest-summary">
              <span><strong>{list.totalCards}</strong> cards to buy</span>
              <span>about <strong>{money(list.totalUsd)}</strong></span>
              {list.unpricedCards > 0 && (
                <span className="tag warn">{list.unpricedCards} unpriced</span>
              )}
            </div>

            <div className="shopping-rows">
              {list.entries.map((entry) => (
                <div className="shopping-row" key={entry.oracleId}>
                  {entry.printingId && entry.imageSmall && (
                    <img src={imageUrl(entry.printingId, 'small')} alt="" loading="lazy" decoding="async" />
                  )}
                  <div className="shopping-name">
                    <span>{entry.needed}× {entry.name}</span>
                    {entry.availableElsewhere > 0 && (
                      <span className="note-inline">
                        {entry.availableElsewhere} free in your collection — claim instead of buying
                      </span>
                    )}
                  </div>
                  <span className="shopping-price">{money(entry.estimatedUsd)}</span>
                  <button className="linkish" disabled={busy} onClick={() => push([entry.oracleId])}>
                    Want
                  </button>
                </div>
              ))}
            </div>

            <div className="btnrow">
              <button className="btn" disabled={busy} onClick={() => push()}>
                Add all to want list
              </button>
            </div>
            <p className="note">
              Want-list entries remember which deck needed them, and a card wanted by
              several decks stays one row with each deck's need listed.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

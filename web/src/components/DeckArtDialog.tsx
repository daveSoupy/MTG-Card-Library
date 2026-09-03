import { useEffect, useState } from 'react';
import {
  fetchCard, imageUrl, updateDeckCard,
  type CardDetail, type Deck, type DeckCard,
} from '../api.ts';

const money = (usd: number | null) => (usd == null ? '' : `$${usd.toFixed(2)}`);

/**
 * Choosing which printing's art a deck card wears.
 *
 * The deck normally shows each card's representative printing; this overrides it
 * for one card in one deck (`deck_cards.preferred_printing_id`) without touching
 * the global art preference. Picking a printing also warms its images so the
 * tile updates without a fetch wait.
 */
export function DeckArtDialog({ deckId, card, onClose, onDeck }: {
  deckId: number;
  card: DeckCard;
  onClose: () => void;
  onDeck: (deck: Deck) => void;
}) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchCard(card.oracleId, controller.signal)
      .then(setDetail)
      .catch((cause) => { if (cause.name !== 'AbortError') setError(cause.message); });
    return () => controller.abort();
  }, [card.oracleId]);

  const choose = async (printingId: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const deck = await updateDeckCard(deckId, card.id, { preferredPrintingId: printingId });
      if (printingId) {
        // Warm the sizes the tile and preview use, so the art swaps in at once.
        new Image().src = imageUrl(printingId, 'small');
        new Image().src = imageUrl(printingId, 'normal');
      }
      onDeck(deck);
      onClose();
    } catch (cause: any) {
      setError(cause.message);
      setSaving(false);
    }
  };

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="porting-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h3>Art for “{card.name}”</h3>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {error && <div className="error">{error}</div>}

        <p className="hint">
          Pick the printing this deck should show. This changes the art here only,
          not everywhere the card appears.
        </p>

        <button
          className="btn secondary small"
          disabled={saving || card.printingId == null}
          onClick={() => choose(null)}
        >
          Use default art
        </button>

        {!detail && !error && <p className="loading">Loading printings…</p>}

        {detail && (
          <div className="printings">
            {detail.printings.map((p) => (
              <button
                key={p.id}
                className="printing"
                aria-pressed={p.id === card.printingId}
                disabled={saving}
                onClick={() => choose(p.id)}
              >
                <span className="pset">
                  {p.setName} · #{p.collectorNumber}
                  {p.ownedQuantity > 0 ? ` · owned ${p.ownedQuantity}` : ''}
                </span>
                <span className="pprice">{money(p.priceUsd)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

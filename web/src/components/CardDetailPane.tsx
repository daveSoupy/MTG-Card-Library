import { useEffect, useState } from 'react';
import { fetchCard, setCardArt, imageUrl, type CardDetail } from '../api.ts';

const RULING_SOURCE_LABEL: Record<string, string> = { wotc: 'WotC', scryfall: 'Scryfall' };

/** Card Kingdom has no per-card id in Scryfall's data, so link to their search. */
function cardKingdomUrl(name: string): string {
  return `https://www.cardkingdom.com/catalog/search?search=header&filter%5Bname%5D=${encodeURIComponent(name)}`;
}

function tcgplayerUrl(name: string, tcgplayerId: number | null): string {
  return tcgplayerId
    ? `https://www.tcgplayer.com/product/${tcgplayerId}`
    : `https://www.tcgplayer.com/search/magic/product?q=${encodeURIComponent(name)}`;
}

const money = (value: number | null) => (value == null ? '—' : `$${value.toFixed(2)}`);

function legalityClass(status: string): string {
  if (status === 'legal') return 'ok';
  if (status === 'banned') return 'banned';
  if (status === 'restricted') return 'restricted';
  return 'no';
}

export function CardDetailPane({
  oracleId,
  floating,
  onClose,
  canToggleWantList = false,
  wantOverride,
  wantPending = false,
  onToggleWantList,
}: {
  oracleId: string | null;
  floating: boolean;
  onClose: () => void;
  /** Whether at least one want list exists to toggle into. */
  canToggleWantList?: boolean;
  /** Overrides the card's own fetched wantedQuantity — same map the browse
   *  grid uses, keyed by oracle id, value is the default list's item id when
   *  wanted or null once removed this session. */
  wantOverride?: Map<string, number | null>;
  /** The card on screen has a toggle in flight — disables the button so a
   *  second click before the first resolves can't repeat the same action
   *  (add-then-add) instead of reversing it. */
  wantPending?: boolean;
  onToggleWantList?: (oracleId: string, currentlyWanted: boolean) => void;
}) {
  const [card, setCard] = useState<CardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPrinting, setSelectedPrinting] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const [rulingsOpen, setRulingsOpen] = useState(false);

  useEffect(() => {
    if (!oracleId) { setCard(null); return; }
    const controller = new AbortController();
    setError(null);
    setRulingsOpen(false);
    fetchCard(oracleId, controller.signal)
      .then((detail) => {
        setCard(detail);
        setSelectedPrinting(detail.printingId);
      })
      .catch((e) => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [oracleId]);

  if (!oracleId) {
    return (
      <aside className={`detail-pane${floating ? ' floating' : ''}`}>
        <p className="empty">Select a card to see its details.</p>
      </aside>
    );
  }

  const printing = card?.printings.find((p) => p.id === selectedPrinting) ?? card?.printings[0];
  // Face images belong to the default printing, so only use them when that is
  // the printing on screen; otherwise fall back to the chosen printing's art.
  const showFaces = card && card.faces.length > 1 && selectedPrinting === card.printingId;

  return (
    <aside className={`detail-pane${floating ? ' floating' : ''}`}>
      {floating && (
        <button className="btn secondary" onClick={onClose} style={{ marginBottom: 10 }}>
          Close
        </button>
      )}

      {error && <div className="error">{error}</div>}
      {!card && !error && <p className="loading">Loading…</p>}

      {card && (
        <>
          <div className="detail-title-row">
            <h2>{card.name}</h2>
            {canToggleWantList && (() => {
              const wanted = wantOverride?.has(card.oracleId)
                ? wantOverride.get(card.oracleId) !== null
                : (card.wantedQuantity ?? 0) > 0;
              return (
                <button
                  type="button"
                  className={`btn secondary small want-btn${wanted ? ' wanted' : ''}`}
                  disabled={wantPending}
                  title={wanted ? 'Remove from want list' : 'Add to want list'}
                  onClick={() => onToggleWantList?.(card.oracleId, wanted)}
                >
                  {wanted ? '✓ Wanted' : '+ Want'}
                </button>
              );
            })()}
          </div>
          <div className="detail-sub">
            {card.typeLine}
            {card.manaCost ? ` · ${card.manaCost}` : ''}
          </div>

          {showFaces ? (
            <div className="faces">
              {card.faces.map((face) =>
                face.imageNormal && printing ? (
                  <img
                    key={face.index}
                    src={imageUrl(printing.id, 'normal', face.index)}
                    alt={face.name}
                    loading="lazy" decoding="async"
                  />
                ) : null,
              )}
            </div>
          ) : printing ? (
            <img
              className="detail-img"
              src={imageUrl(printing.id, 'normal')}
              alt={card.name}
              loading="lazy" decoding="async"
            />
          ) : null}

          {card.faces.length > 1 ? (
            card.faces.map((face) => (
              <div key={face.index} className="oracle">
                <strong>{face.name}</strong>
                {face.manaCost ? <span className="mana"> {face.manaCost}</span> : null}
                {face.typeLine ? `\n${face.typeLine}` : ''}
                {face.oracleText ? `\n\n${face.oracleText}` : ''}
                {face.powerToughness ? `\n\n${face.powerToughness}` : ''}
              </div>
            ))
          ) : card.oracleText ? (
            <div className="oracle">{card.oracleText}</div>
          ) : null}

          {card.flavorText && <div className="oracle flavor">{card.flavorText}</div>}

          <div className="kv"><span>Mana value</span><span>{card.cmc}</span></div>
          {card.power && card.toughness && (
            <div className="kv"><span>Power / toughness</span><span>{card.power}/{card.toughness}</span></div>
          )}
          {card.loyalty && <div className="kv"><span>Loyalty</span><span>{card.loyalty}</span></div>}
          <div className="kv"><span>Colour identity</span><span>{card.colorIdentity || 'Colourless'}</span></div>
          {card.artist && <div className="kv"><span>Artist</span><span>{card.artist}</span></div>}
          {card.isReserved && <div className="kv"><span>Reserved list</span><span>Yes</span></div>}
          {card.ownedQuantity > 0 && (
            <div className="kv"><span>In your collection</span><span>{card.ownedQuantity}</span></div>
          )}

          <div className="buylinks">
            <a href={tcgplayerUrl(card.name, printing?.tcgplayerId ?? null)} target="_blank" rel="noreferrer">
              TCGplayer
            </a>
            <a href={cardKingdomUrl(card.name)} target="_blank" rel="noreferrer">
              Card Kingdom
            </a>
            {printing?.scryfallUri && (
              <a href={printing.scryfallUri} target="_blank" rel="noreferrer">Scryfall</a>
            )}
          </div>

          <div className="fgroup">
            <h3>Prices</h3>
            <div className="kv"><span>Normal</span><span>{money(printing?.priceUsd ?? null)}</span></div>
            <div className="kv"><span>Foil</span><span>{money(printing?.priceUsdFoil ?? null)}</span></div>
          </div>

          <div className="fgroup">
            <h3>Legality</h3>
            <div className="legalities">
              {card.legalities.map((legality) => (
                <div className="legal-row" key={legality.format}>
                  <span className={`dot ${legalityClass(legality.status)}`} />
                  <span>{legality.displayName}</span>
                </div>
              ))}
            </div>
          </div>

          {card.rulings.length > 0 && (
            <div className="fgroup">
              <button
                className="linkish rulings-toggle"
                onClick={() => setRulingsOpen((v) => !v)}
                aria-expanded={rulingsOpen}
              >
                {rulingsOpen ? '▾' : '▸'} Rulings ({card.rulings.length})
              </button>
              {rulingsOpen && (
                <div className="rulings">
                  {card.rulings.map((r, i) => (
                    <div className="ruling" key={i}>
                      <div className="ruling-meta">
                        <span>{RULING_SOURCE_LABEL[r.source] ?? r.source}</span>
                        <span>{r.publishedAt}</span>
                      </div>
                      <div className="ruling-comment">{r.comment}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="fgroup">
            <h3>Printings ({card.printings.length})</h3>
            {selectedPrinting && selectedPrinting !== card.printingId && (
              <button
                className="btn secondary small art-pin"
                disabled={pinning}
                onClick={async () => {
                  setPinning(true);
                  try {
                    setCard(await setCardArt(card.oracleId, selectedPrinting));
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  } finally {
                    setPinning(false);
                  }
                }}
              >
                Always show this art
              </button>
            )}
            {selectedPrinting && selectedPrinting === card.printingId && card.artIsPinned && (
              <button
                className="btn secondary small art-pin"
                disabled={pinning}
                onClick={async () => {
                  setPinning(true);
                  try {
                    setCard(await setCardArt(card.oracleId, null));
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  } finally {
                    setPinning(false);
                  }
                }}
              >
                Stop pinning this art
              </button>
            )}
            <div className="printings">
              {card.printings.map((p) => (
                <button
                  key={p.id}
                  className="printing"
                  aria-pressed={p.id === selectedPrinting}
                  onClick={() => setSelectedPrinting(p.id)}
                >
                  <span className="pset">
                    {p.setName} · #{p.collectorNumber}
                    {p.ownedQuantity > 0 ? ` · owned ${p.ownedQuantity}` : ''}
                  </span>
                  <span className="pprice">{money(p.priceUsd)}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

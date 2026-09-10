import { imageUrl, type CollectionCard } from '../api.ts';
import type { Density } from '../density.ts';
import { ManaCost } from './ManaCost.tsx';

const money = (value: number | null | undefined) =>
  value == null ? '—' : `$${Number(value).toFixed(2)}`;

export type OwnedGridSelection = { oracleId: string; printingId: string | null; finish: string };

/** Owned lot tiles — the browse tab's `.card` grid, with foil overlay and badges. */
export function OwnedGrid({
  cards,
  selected,
  onSelect,
  density = 'full',
}: {
  cards: CollectionCard[];
  selected: OwnedGridSelection | null;
  onSelect: (card: CollectionCard) => void;
  density?: Density;
}) {
  // Ultra-compact drops the art from the DOM rather than hiding it, which is
  // the whole point at collection scale: a thousand rows and no thumbnails.
  const ultra = density === 'ultra';

  return (
    <div className="grid">
      {cards.map((card) => (
        <button
          className={`card${card.finish !== 'nonfoil' ? ' is-foil' : ''}`}
          key={`${card.printingId ?? card.oracleId}:${card.finish}`}
          aria-selected={selected?.printingId === card.printingId && selected?.finish === card.finish}
          onClick={() => onSelect(card)}
          title={`${card.name} — ${card.setName ?? card.setCode?.toUpperCase()} #${card.collectorNumber}`}
        >
          {ultra ? (
            <span className="text-row">
              <span className="tr-name">{card.name}</span>
              <span className="tr-set">
                {card.setCode?.toUpperCase() ?? ''} #{card.collectorNumber}
                {card.finish !== 'nonfoil' && ` · ${card.finish}`}
              </span>
              <span className="tr-qty">×{card.ownedQuantity}</span>
              <span className="tr-price">{money(card.valueUsd)}</span>
            </span>
          ) : (
            <>
              <span className="card-art">
                {card.printingId && card.imageSmall
                  ? <img src={imageUrl(card.printingId, 'small')} alt={card.name} loading="lazy" decoding="async" />
                  : <div className="placeholder">{card.name}</div>}
                {card.finish !== 'nonfoil' && <span className="foil-overlay" aria-hidden="true" />}
              </span>
              <span className="owned-badge">{card.ownedQuantity}</span>
              {card.finish !== 'nonfoil' && (
                <span className="foil-badge" title={card.finish}>{card.finish === 'etched' ? 'etched' : 'foil'}</span>
              )}
              {card.locationCount > 1 && (
                <span className="split-badge" title={`Split across ${card.locationCount} locations`}>
                  {card.locationCount} places
                </span>
              )}
              <div className="cname">
                <span className="cname-text">{card.name}</span>
                <ManaCost cost={card.manaCost} cmc={card.cmc} className="cmana" />
              </div>
              <div className="cset">{(card.setCode?.toUpperCase() ?? '')} · #{card.collectorNumber}</div>
              <div className="cvalue">{money(card.valueUsd)}</div>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

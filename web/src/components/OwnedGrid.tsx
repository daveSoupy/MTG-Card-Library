import { imageUrl, type CollectionCard } from '../api.ts';

const money = (value: number | null | undefined) =>
  value == null ? '—' : `$${Number(value).toFixed(2)}`;

export type OwnedGridSelection = { oracleId: string; printingId: string | null; finish: string };

/** Owned lot tiles — the browse tab's `.card` grid, with foil overlay and badges. */
export function OwnedGrid({
  cards,
  selected,
  onSelect,
}: {
  cards: CollectionCard[];
  selected: OwnedGridSelection | null;
  onSelect: (card: CollectionCard) => void;
}) {
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
          <div className="cname">{card.name}</div>
          <div className="cset">{(card.setCode?.toUpperCase() ?? '')} · #{card.collectorNumber}</div>
          <div className="cvalue">{money(card.valueUsd)}</div>
        </button>
      ))}
    </div>
  );
}

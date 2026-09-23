import type { CollectionValue } from '../api.ts';
import { count, money } from '../format.ts';


/**
 * The top of the value axis: the smallest 1 / 2 / 2.5 / 5 × 10ⁿ at or above
 * `value`, so the labels read as round numbers rather than as $72,044.
 */
export function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = value / magnitude;
  const nice = step <= 1 ? 1 : step <= 2 ? 2 : step <= 2.5 ? 2.5 : step <= 5 ? 5 : 10;
  return nice * magnitude;
}

/**
 * Value over time, as a plain SVG area — no chart library for one line.
 *
 * Anchored at zero, with the axis labelled. It used to stretch min-to-max over
 * the full height with no labels, so a 13% dip drew as a fall to the floor.
 * An area's height reads as an amount, and an amount starts at nothing.
 */
export function ValueChart({ history }: { history: CollectionValue['history'] }) {
  if (history.length < 2) {
    return (
      <p className="note">
        One data point so far. A snapshot is taken after each price sync, so the trend
        fills in over the coming days.
      </p>
    );
  }

  const width = 640;
  const height = 160;
  const pad = 4;
  const values = history.map((h) => h.total_value_usd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const top = niceCeiling(max);

  const y = (value: number) => height - pad - (value / top) * (height - pad * 2);
  const point = (index: number, value: number) => {
    const x = pad + (index / (history.length - 1)) * (width - pad * 2);
    return `${x.toFixed(1)},${y(value).toFixed(1)}`;
  };

  const line = history.map((h, i) => point(i, h.total_value_usd)).join(' ');
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;

  return (
    <>
      <div className="value-chart-frame">
        {/* HTML rather than SVG text: the SVG scales with the page, and its
            labels would shrink to nothing on a phone. */}
        <div className="value-axis" aria-hidden="true">
          <span>{money(top, { wholeDollars: true })}</span>
          <span>{money(top / 2, { wholeDollars: true })}</span>
          <span>$0</span>
        </div>
        <svg className="value-chart" viewBox={`0 0 ${width} ${height}`} role="img"
             aria-label={`Collection value from ${money(min)} to ${money(max)} over ${history.length} days, on an axis from $0 to ${money(top)}`}>
          <line x1={pad} x2={width - pad} y1={y(top / 2)} y2={y(top / 2)}
                stroke="var(--line)" strokeDasharray="3 4" />
          <polygon points={area} fill="var(--accent)" opacity="0.14" />
          <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2"
                    strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      </div>
      <div className="chart-axis">
        <span>{history[0].captured_on}</span>
        <span>low {money(min)} · high {money(max)}</span>
        <span>{history.at(-1)!.captured_on}</span>
      </div>
    </>
  );
}

export function CollectionValuePanel({ value }: { value: CollectionValue | null }) {
  const totalValue = value?.value.total_value_usd ?? 0;
  const totalCost = value?.value.total_cost_basis_usd ?? null;
  const gain = value?.value.unrealized_gain_usd ?? null;
  const knownCopies = value?.value.cost_known_cards ?? 0;
  const allCopies = value?.value.total_cards ?? 0;
  const knownValue = value?.value.cost_known_value_usd ?? null;
  // Every copy has a cost: the two tiles cover the whole collection and need
  // no qualifier.
  const partial = knownCopies < allCopies;

  return (
    <div className="results">
      <div className="value-summary">
        <div className="stat"><b>{money(totalValue)}</b><span>market value</span></div>
        {/* The coverage sits in the tile, not in a footnote: "$17,820 paid"
            beside "$72,044 value" reads as a $54k gain unless you know the cost
            is known for only a third of the copies. */}
        <div className="stat">
          <b>{money(totalCost)}</b><span>what you paid</span>
          {partial && <small>for {count(knownCopies)} of {count(allCopies)} copies</small>}
        </div>
        <div className="stat">
          <b className={Number(gain) >= 0 ? 'gain-up' : 'gain-down'}>{money(gain)}</b>
          <span>unrealised</span>
          {partial && knownValue != null && (
            <small>those copies are worth {money(knownValue)}</small>
          )}
        </div>
        <div className="stat"><b>{count(allCopies)}</b><span>copies</span></div>
      </div>
      {value && <ValueChart history={value.history} />}
      <p className="note">
        Copies with no recorded purchase price are left out of what you paid and of the
        unrealised gain, rather than counted as free — so the gain is not inflated.
      </p>
    </div>
  );
}

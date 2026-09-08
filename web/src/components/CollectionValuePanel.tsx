import type { CollectionValue } from '../api.ts';

const money = (value: number | null | undefined) =>
  value == null ? '—' : `$${Number(value).toFixed(2)}`;

/** Value over time, as a plain SVG line — no chart library for one sparkline. */
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
  const span = max - min || 1;

  const point = (index: number, value: number) => {
    const x = pad + (index / (history.length - 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };

  const line = history.map((h, i) => point(i, h.total_value_usd)).join(' ');
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;

  return (
    <>
      <svg className="value-chart" viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label={`Collection value from ${money(min)} to ${money(max)} over ${history.length} days`}>
        <polygon points={area} fill="var(--accent)" opacity="0.14" />
        <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2"
                  strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="chart-axis">
        <span>{history[0].captured_on}</span>
        <span>{money(min)} – {money(max)}</span>
        <span>{history.at(-1)!.captured_on}</span>
      </div>
    </>
  );
}

export function CollectionValuePanel({ value }: { value: CollectionValue | null }) {
  const totalValue = value?.value.total_value_usd ?? 0;
  const totalCost = value?.value.total_cost_basis_usd ?? null;
  const gain = value?.value.unrealized_gain_usd ?? null;

  return (
    <div className="results">
      <div className="value-summary">
        <div className="stat"><b>{money(totalValue)}</b><span>market value</span></div>
        <div className="stat"><b>{money(totalCost)}</b><span>what you paid</span></div>
        <div className="stat">
          <b className={Number(gain) >= 0 ? 'gain-up' : 'gain-down'}>{money(gain)}</b>
          <span>unrealised</span>
        </div>
        <div className="stat"><b>{value?.value.total_cards ?? 0}</b><span>cards</span></div>
      </div>
      {value && <ValueChart history={value.history} />}
      <p className="note">
        Cost covers only the {value?.value.cost_known_cards ?? 0} copies with a known
        purchase price; the rest are recorded as unknown rather than free, so the
        unrealised figure is not inflated.
      </p>
    </div>
  );
}

import type { DeckStats, DeckValidation } from '../api.ts';

const money = (value: number | null) => (value == null ? '—' : `$${value.toFixed(2)}`);

/**
 * Deck size, drawn as progress toward the format's requirement.
 *
 * Formats with an exact size get a target rather than a floor, because a
 * 101-card Commander deck is as wrong as a 99-card one.
 */
function SizeReadout({ validation }: { validation: DeckValidation }) {
  const { countedTotal, requiredExactSize, requiredMinSize } = validation;
  const target = requiredExactSize ?? requiredMinSize;
  if (target == null) {
    return <div className="size-readout"><strong>{countedTotal}</strong> cards</div>;
  }

  const exact = requiredExactSize !== null;
  const met = exact ? countedTotal === target : countedTotal >= target;
  const pct = Math.min(100, (countedTotal / target) * 100);

  return (
    <div className="size-readout">
      <div className="size-numbers">
        <strong className={met ? 'ok' : 'short'}>{countedTotal}</strong>
        <span>{exact ? `of exactly ${target}` : `of ${target} minimum`}</span>
      </div>
      <div className="bar">
        <div className={met ? 'ok' : ''} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ManaCurve({ stats }: { stats: DeckStats }) {
  const peak = Math.max(1, ...stats.manaCurve.map((b) => b.count));
  return (
    <div className="curve">
      {stats.manaCurve.map((bucket) => (
        <div className="curve-col" key={bucket.cmc} title={`${bucket.count} card${bucket.count === 1 ? '' : 's'} at mana value ${bucket.label}`}>
          <span className="curve-count">{bucket.count || ''}</span>
          <div className="curve-bar" style={{ height: `${(bucket.count / peak) * 100}%` }} />
          <span className="curve-label">{bucket.label}</span>
        </div>
      ))}
    </div>
  );
}

const COLOR_CLASS: Record<string, string> = {
  White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G', Colourless: 'C',
};

export function DeckStatsPanel({
  stats,
  validation,
  onJumpToCard,
}: {
  stats: DeckStats;
  validation: DeckValidation;
  onJumpToCard: (oracleId: string) => void;
}) {
  const errors = validation.issues.filter((i) => i.severity === 'error');
  const warnings = validation.issues.filter((i) => i.severity === 'warning');
  const maxColor = Math.max(1, ...stats.colorDistribution.map((c) => c.count));

  return (
    <aside className="stats-pane">
      <div className="fgroup">
        <h3>{validation.formatName ?? 'No format'}</h3>
        <SizeReadout validation={validation} />
        {validation.sideboardLimit ? (
          <div className="kv">
            <span>Sideboard</span>
            <span className={validation.sideboardCount > validation.sideboardLimit ? 'short' : ''}>
              {validation.sideboardCount} / {validation.sideboardLimit}
            </span>
          </div>
        ) : null}
        {validation.commandCount > 0 && (
          <div className="kv"><span>Command zone</span><span>{validation.commandCount}</span></div>
        )}
      </div>

      <div className="fgroup">
        <h3>Legality</h3>
        {errors.length === 0 && warnings.length === 0 ? (
          <div className="verdict ok">Legal in {validation.formatName}</div>
        ) : (
          <>
            {errors.length > 0 && (
              <div className="verdict bad">
                {errors.length} problem{errors.length === 1 ? '' : 's'} to fix
              </div>
            )}
            <ul className="issues">
              {[...errors, ...warnings].map((issue, index) => (
                <li key={`${issue.code}-${issue.oracleId ?? index}`} className={issue.severity}>
                  {issue.oracleId ? (
                    <button className="linkish" onClick={() => onJumpToCard(issue.oracleId!)}>
                      {issue.message}
                    </button>
                  ) : (
                    issue.message
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="fgroup">
        <h3>Mana curve</h3>
        <ManaCurve stats={stats} />
        <div className="kv">
          <span>Average mana value</span>
          <span>{stats.averageManaValue ?? '—'}</span>
        </div>
        <p className="note">Lands are excluded from the curve and the average.</p>
      </div>

      <div className="fgroup">
        <h3>Colours{stats.colorIdentity ? ` · ${stats.colorIdentity}` : ''}</h3>
        {stats.colorDistribution.length === 0 ? (
          <p className="note">No cards yet.</p>
        ) : (
          stats.colorDistribution.map((entry) => (
            <div className="colorbar" key={entry.color}>
              <span className="colorbar-name">{entry.color}</span>
              <div className="colorbar-track">
                <div
                  className={`colorbar-fill c${COLOR_CLASS[entry.color] ?? 'C'}`}
                  style={{ width: `${(entry.count / maxColor) * 100}%` }}
                />
              </div>
              <span className="colorbar-count">{entry.count}</span>
            </div>
          ))
        )}
      </div>

      <div className="fgroup">
        <h3>Composition</h3>
        {stats.typeDistribution.map((entry) => (
          <div className="kv" key={entry.type}><span>{entry.type}</span><span>{entry.count}</span></div>
        ))}
        <div className="kv"><span>Distinct cards</span><span>{stats.uniqueCards}</span></div>
      </div>

      <div className="fgroup">
        <h3>Collection</h3>
        <div className="kv"><span>From your collection</span><span>{stats.ownedCount}</span></div>
        <div className="kv"><span>Need to buy</span><span>{stats.needToBuyCount}</span></div>
        <div className="kv"><span>Estimated value</span><span>{money(stats.estimatedValueUsd)}</span></div>
      </div>
    </aside>
  );
}

import {
  imageUrl, type BuildabilityRow, type DeckBuildability, type DeckStats, type DeckValidation,
  type ManaBase, type TemplateProgress,
} from '../api.ts';
import { missingRows, shortfallLine } from '../buildability.ts';
import { legalityVerdict } from '../legality.ts';
import { HelpButton } from './helpTopics.tsx';
import { money } from '../format.ts';


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

/**
 * Sources against pips.
 *
 * Colour distribution says how many cards are green; this says whether the
 * lands can cast them, which is the question that actually changes a deck.
 */
function ManaBasePanel({ manaBase }: { manaBase: ManaBase }) {
  if (manaBase.requirements.length === 0) {
    return <p className="note">Add some cards to see the mana base.</p>;
  }
  const pct = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <>
      <div className="manabase-head">
        <span>Colour</span><span>Pips</span><span>Sources</span>
      </div>
      {manaBase.requirements.map((requirement) => (
        <div className={`manabase-row${requirement.isShort ? ' short' : ''}`} key={requirement.color}>
          <span className={`manabase-name c${requirement.color}`}>{requirement.colorName}</span>
          <span className="manabase-num" title={`${pct(requirement.pipShare)} of coloured pips`}>
            {requirement.pips}
          </span>
          <span className="manabase-num" title={`${pct(requirement.sourceShare)} of mana sources`}>
            {requirement.sources}
            {requirement.isShort && <span className="tag warn">short</span>}
          </span>
        </div>
      ))}

      <div className="kv"><span>Lands</span><span>{manaBase.landCount}</span></div>
      <div className="kv"><span>Other mana sources</span><span>{manaBase.nonLandSources}</span></div>
      {manaBase.colorlessSources > 0 && (
        <div className="kv"><span>Colourless-only sources</span><span>{manaBase.colorlessSources}</span></div>
      )}
      <p className="note">
        A colour is flagged when its share of your mana sources falls well below its
        share of your coloured pips. Hybrid symbols count toward both colours.
      </p>
    </>
  );
}

/**
 * "N short" / "N over" per category, against a template's targets.
 *
 * Rows deliberately do not sum to the deck size — a card counts toward every
 * category it matches, so the panel says so rather than implying a partition.
 */
function TemplatePanel({
  progress,
  onFilterShortfall,
  onResolveCategories,
}: {
  progress: TemplateProgress;
  onFilterShortfall: (category: string) => void;
  onResolveCategories: () => void;
}) {
  return (
    <>
      <p className="note">
        {progress.templateName} — a starting point, not a rule. Categories overlap, so
        rows do not add up to the {progress.countedTotal}-card total.
      </p>
      {/* Without this, every tag-derived row reads zero and looks like a
          verdict on the deck rather than on the missing data. */}
      {!progress.tagDataAvailable && (
        <div className="tmpl-nodata">
          <span>
            Scryfall's card categories have not been resolved yet, so only categories you
            set by hand are counted.
          </span>
          <button className="btn secondary small" onClick={onResolveCategories}>
            Resolve now
          </button>
        </div>
      )}
      {progress.rows.map((row) => (
        <div className={`tmpl-row${row.isShort ? ' short' : ''}`} key={row.category}>
          <span className="tmpl-name">{row.label}</span>
          <span className="tmpl-num">
            {row.isShort ? (
              <button
                className="linkish"
                onClick={() => onFilterShortfall(row.category)}
                title={`Show ${row.label.toLowerCase()} cards to add`}
              >
                {row.current} / {row.ideal}
                <span className="tag warn">{row.ideal - row.current} short</span>
              </button>
            ) : (
              <>
                {row.current} / {row.ideal}
                {row.isOver && <span className="tag warn">over</span>}
              </>
            )}
          </span>
        </div>
      ))}
      <div className="kv">
        <span>Uncategorised</span>
        <span>{progress.uncategorisedCount}</span>
      </div>
    </>
  );
}

/** Short cards named in the pane before it hands over to the Missing list. */
const SHORT_LIMIT = 8;

export function DeckStatsPanel({
  stats,
  validation,
  manaBase,
  templateProgress,
  showTemplates,
  onResolveCategories,
  onJumpToCard,
  onFilterShortfall,
  floating = false,
  onClose,
  preview,
  onOpenPreview,
  buildability = null,
  coverage,
  onShowMissing,
}: {
  stats: DeckStats;
  validation: DeckValidation;
  /** The deck header's figures — covered, missing, basics left out. */
  buildability?: DeckBuildability | null;
  /** Per-card coverage, for naming what is short and why. */
  coverage?: Map<string, BuildabilityRow>;
  onShowMissing?: () => void;
  manaBase: ManaBase;
  templateProgress: TemplateProgress | null;
  /** The showDeckTemplates global setting — off hides the section entirely. */
  showTemplates: boolean;
  onResolveCategories: () => void;
  onJumpToCard: (oracleId: string) => void;
  onFilterShortfall: (category: string) => void;
  /** Below 1200px the pane is not a column; it opens as an overlay instead of
   *  disappearing, the same way the card detail pane does. */
  floating?: boolean;
  onClose?: () => void;
  /** The card last hovered in the deck list or the picker, shown whole at the
   *  top of the pane. Stays until another is hovered, so the figures below
   *  do not jump as the mouse moves. */
  preview?: { printingId: string; name: string } | null;
  /** Clicking the card opens its details. */
  onOpenPreview?: () => void;
}) {
  const verdict = legalityVerdict(validation);
  const short = coverage ? missingRows([...coverage.values()]) : [];
  const maxColor = Math.max(1, ...stats.colorDistribution.map((c) => c.count));

  return (
    <aside className={`stats-pane${floating ? ' floating' : ''}`}>
      {floating && (
        <div className="floating-head">
          <strong>Deck stats</strong>
          <button className="btn secondary small" onClick={onClose}>Done</button>
        </div>
      )}
      {preview && (
        <button
          type="button"
          className="stats-art"
          onClick={onOpenPreview}
          aria-label={`Open ${preview.name}`}
          title="Card details"
        >
          <img
            src={imageUrl(preview.printingId, 'normal')}
            alt={preview.name}
            decoding="async"
          />
        </button>
      )}
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
        {validation.commanderIdentity !== null && (
          <div className="kv">
            <span>Colour identity</span>
            <span>{validation.commanderIdentity || 'Colourless'}</span>
          </div>
        )}
      </div>

      <div className="fgroup">
        <h3>Legality</h3>
        {verdict.errors.length === 0 && verdict.notes.length === 0 ? (
          <div className="verdict ok">Legal in {validation.formatName}</div>
        ) : (
          <>
            {/* The header chip's words exactly — both come from legalityVerdict. */}
            <div className={`verdict ${verdict.ok ? 'ok' : 'bad'}`}>{verdict.text}</div>
            <ul className="issues">
              {[...verdict.errors, ...verdict.notes].map((issue, index) => (
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
        <h3>Mana base</h3>
        <ManaBasePanel manaBase={manaBase} />
      </div>

      {showTemplates && templateProgress && (
        <div className="fgroup">
          <h3>Template</h3>
          <TemplatePanel
            progress={templateProgress}
            onFilterShortfall={onFilterShortfall}
            onResolveCategories={onResolveCategories}
          />
        </div>
      )}

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
        {/* Not a legality question, so not in the Legality section: whether
            your collection can supply the deck is buildability's, and every
            figure here is the deck header's. */}
        <h3>From your collection <HelpButton topic="allocation" /></h3>
        {buildability && buildability.buildablePct !== null ? (
          <>
            <div className="kv">
              <span>Covered</span>
              <span>{buildability.coveredCards} of {buildability.requiredCards}</span>
            </div>
            {stats.proxiedCount > 0 && (
              <div className="kv"><span>Proxied</span><span>{stats.proxiedCount}</span></div>
            )}
            <div className="kv">
              <span>Missing</span>
              {buildability.missingCards > 0 && onShowMissing ? (
                <button className="linkish" onClick={onShowMissing}>{buildability.missingCards}</button>
              ) : (
                <span>{buildability.missingCards}</span>
              )}
            </div>
            {buildability.exemptBasicCards > 0 && (
              <div className="kv" title="Basic lands are left out of allocation — never claimed, never short.">
                <span>Basic lands, not counted</span><span>{buildability.exemptBasicCards}</span>
              </div>
            )}
            {short.length > 0 && (
              <ul className="issues">
                {short.slice(0, SHORT_LIMIT).map((row) => (
                  <li key={row.oracleId} className="warning">
                    <button className="linkish" onClick={() => onJumpToCard(row.oracleId)}>
                      {row.name}: {shortfallLine(row)}
                    </button>
                  </li>
                ))}
                {short.length > SHORT_LIMIT && onShowMissing && (
                  <li>
                    <button className="linkish" onClick={onShowMissing}>
                      and {short.length - SHORT_LIMIT} more
                    </button>
                  </li>
                )}
              </ul>
            )}
          </>
        ) : buildability ? (
          <p className="note">No cards to count yet.</p>
        ) : (
          <p className="note">Working it out…</p>
        )}
        <div className="kv"><span>Estimated value</span><span>{money(stats.estimatedValueUsd)}</span></div>
      </div>
    </aside>
  );
}

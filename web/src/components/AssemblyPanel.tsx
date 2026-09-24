import { useEffect, useState } from 'react';
import {
  cancelAssembly, completeAssembly, pushMissingToWantList, setLinePicked,
  type AssemblyCompletion, type AssemblySheet, type SheetLine,
} from '../api.ts';
import { money } from '../buildability.ts';
import {
  completionFacts, lineTraits, lineWarning, printingLabel, progressFraction, progressText,
  RUN_NOUN, runIntent,
} from '../assembly.ts';

/**
 * The pull sheet: which binder to open, in what order.
 *
 * Built for the way it actually gets used — standing up, one hand on a binder,
 * the other on a phone. Big tap targets, the current location pinned to the top
 * of the screen so you always know which box you are in, and a progress count
 * that never moves out of view. Nothing here is a hover affordance.
 *
 * The tick state lives on the server, so being interrupted halfway through a
 * binder costs nothing: closing the panel, locking the phone or reloading the
 * page all resume exactly where they left off.
 */
export function AssemblyPanel({
  sheet: initial,
  onClose,
  onFinished,
}: {
  sheet: AssemblySheet;
  onClose: () => void;
  /** The deck's status and allocation have both changed; the builder reloads. */
  onFinished: () => void;
}) {
  const [sheet, setSheet] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AssemblyCompletion | null>(null);
  const [pushed, setPushed] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Nothing ticked yet makes this a preview, not a job in progress — closing it
  // any of the three ways (✕, backdrop, Escape) quietly discards the run rather
  // than leaving it open for the deck header to offer "Resume pull sheet 0/61".
  // Once a line is ticked, closing keeps the run open to resume later.
  const close = () => {
    if (sheet.run.status === 'open' && sheet.summary.pickedCards === 0) {
      cancelAssembly(sheet.run.id).catch(() => undefined).finally(onClose);
    } else {
      onClose();
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.run.id, sheet.run.status, sheet.summary.pickedCards, onClose]);

  const run = async <T,>(action: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const toggle = (line: SheetLine) =>
    run(async () => setSheet(await setLinePicked(sheet.run.id, line.id, !line.picked)));

  /** Ticks whatever is left. The impatient path, for a deck you pulled in one go. */
  const pickRest = () => run(async () => {
    let latest = sheet;
    for (const group of sheet.groups) {
      for (const line of group.lines) {
        if (!line.picked) latest = await setLinePicked(sheet.run.id, line.id, true);
      }
    }
    setSheet(latest);
  });

  const finish = () => run(async () => {
    const completion = await completeAssembly(sheet.run.id);
    setResult(completion);
    onFinished();
  });

  const abandon = () => run(async () => {
    await cancelAssembly(sheet.run.id);
    onFinished();
    onClose();
  });

  const pushWants = () => run(async () => {
    const pushedTo = await pushMissingToWantList(sheet.deck.id);
    const total = pushedTo.added + pushedTo.updated;
    setPushed(`${total} card${total === 1 ? '' : 's'} on “${pushedTo.listName}”.`);
  });

  // Completion is a different screen, not a banner on the old one: the sheet it
  // replaces is no longer true the moment the run is finished.
  if (result) {
    return (
      <div className="sync-overlay" onClick={onClose}>
        <div className="playtest-card assembly-card" onClick={(e) => e.stopPropagation()}>
          <div className="syntax-head">
            <h2>{result.kind === 'assemble' ? 'Deck assembled' : 'Deck put away'}</h2>
            <button className="btn secondary" onClick={onClose}>Close</button>
          </div>

          {error && <div className="error">{error}</div>}
          {pushed && <div className="verdict ok">Added {pushed}</div>}

          <ul className="assembly-facts">
            {completionFacts(result).map((fact) => (
              <li key={fact.key} className={`fact ${fact.tone}`}>{fact.text}</li>
            ))}
          </ul>

          {result.problems.length > 0 && (
            <div className="assembly-problems">
              <h3>Worth knowing</h3>
              {result.problems.map((problem) => <p key={problem}>{problem}</p>)}
            </div>
          )}

          {result.stillMissingCards > 0 && (
            <div className="deck-card-actions" style={{ marginTop: 14 }}>
              <button className="btn" onClick={pushWants} disabled={busy || pushed !== null}>
                {pushed ? 'Added to want list' : 'Add what is missing to my want list'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const fraction = progressFraction(sheet);
  const remaining = sheet.summary.cardsToPull - sheet.summary.pickedCards;

  return (
    <div className="sync-overlay" onClick={close}>
      <div className="playtest-card assembly-card" onClick={(e) => e.stopPropagation()}>
        <div className="assembly-head">
          <div className="assembly-title">
            <h2>{sheet.deck.name}</h2>
            <span className="dim">{RUN_NOUN[sheet.run.kind]}</span>
          </div>
          <button className="btn secondary" onClick={close}>Close</button>
        </div>

        {/* Sticky, because it is the number you look at between every card. */}
        <div className="assembly-progress">
          <div className="build-bar" data-tone={fraction >= 1 ? 'done' : 'far'}>
            <span style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
          <strong>{progressText(sheet)}</strong>
          {remaining > 0 && (
            <button className="btn secondary small" onClick={pickRest} disabled={busy}>
              Tick the rest
            </button>
          )}
        </div>

        <p className="hint">{runIntent(sheet)}</p>
        {sheet.movesLotsBlocked && <div className="verdict warn">{sheet.movesLotsBlocked}</div>}
        {error && <div className="error">{error}</div>}

        {sheet.groups.length === 0 && (
          <p className="empty">
            Nothing to pull — every card this deck needs is either proxied or one you do not own.
          </p>
        )}

        {sheet.groups.map((group) => (
          <section className="assembly-group" key={group.locationId ?? 'none'}>
            {/* The location is a sticky header rather than a plain heading: it
                is the answer to "which box am I holding?", which you need at
                every line, not only at the top of the section. */}
            <h3 className="assembly-location">
              <span>{group.locationName}</span>
              <span className="dim">{group.pickedCount}/{group.cardCount}</span>
            </h3>

            {group.lines.map((line) => {
              const warning = lineWarning(line);
              const traits = lineTraits(line);
              return (
                <label
                  className={`assembly-line${line.picked ? ' picked' : ''}`}
                  key={line.id}
                >
                  <input
                    type="checkbox"
                    checked={line.picked}
                    disabled={busy}
                    onChange={() => toggle(line)}
                  />
                  <span className="assembly-qty">{line.quantity}×</span>
                  <span className="assembly-name">
                    {line.name}
                    <span className="dim">
                      {[printingLabel(line), ...traits].filter(Boolean).join(' · ')}
                    </span>
                    {warning && <span className="tag warn">{warning}</span>}
                  </span>
                  {line.toLocationName && (
                    <span className="assembly-dest dim">→ {line.toLocationName}</span>
                  )}
                </label>
              );
            })}
          </section>
        ))}

        {sheet.unavailable.length > 0 && (
          <section className="assembly-group">
            <h3 className="assembly-location">
              <span>Not available</span>
              <span className="dim">
                {money(sheet.summary.unavailableCostUsd)}
                {sheet.summary.unpricedCount > 0 && ` + ${sheet.summary.unpricedCount} unpriced`}
              </span>
            </h3>
            {/* The buy list, in the same sheet: these are the copies your
                collection could not supply, priced as of right now. */}
            {sheet.unavailable.map((line) => (
              <div className="assembly-line missing" key={line.id}>
                <span className="assembly-qty">{line.quantity}×</span>
                <span className="assembly-name">
                  {line.name}
                  {printingLabel(line) && <span className="dim">{printingLabel(line)}</span>}
                </span>
                <span className="assembly-dest">
                  {line.extendedUsd == null
                    ? <span className="tag warn">no price</span>
                    : money(line.extendedUsd)}
                </span>
              </div>
            ))}
          </section>
        )}

        {sheet.alsoPull.length > 0 && (
          <p className="hint">
            Also pull: {sheet.alsoPull.map((line) => `${line.name} ×${line.quantity}`).join(', ')}
            {' '}— basics aren't tracked.
          </p>
        )}

        <div className="assembly-actions">
          <button className="btn" onClick={finish} disabled={busy}>
            {sheet.run.kind === 'assemble' ? 'Finish — mark assembled' : 'Finish — put away'}
          </button>
          {confirming ? (
            <>
              <span className="dim">Discard this sheet?</span>
              <button className="btn danger" onClick={abandon} disabled={busy}>Discard</button>
              <button className="btn secondary" onClick={() => setConfirming(false)}>Keep</button>
            </>
          ) : (
            <button className="btn secondary" onClick={() => setConfirming(true)} disabled={busy}>
              Discard sheet
            </button>
          )}
          {remaining > 0 && (
            // Said before the button is pressed, not after: an un-ticked line
            // becomes a copy the deck stops claiming, and that is a surprise
            // worth spending a sentence to avoid.
            <span className="dim">
              {remaining} un-ticked {remaining === 1 ? 'copy' : 'copies'} will be recorded as
              {' '}not found.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

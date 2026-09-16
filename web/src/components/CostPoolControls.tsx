import { useEffect, useState } from 'react';
import {
  closeCostPool, fetchOpenCostPool, fetchSettings, openCostPool, setCostPoolSet,
  undoImportBatch, updateCostPoolTotal,
  type CostMethod, type CostPool,
} from '../api.ts';
import { HelpButton } from './helpTopics.tsx';

const money = (value: number | null | undefined) =>
  value == null ? '—' : `$${Number(value).toFixed(2)}`;

/**
 * Cost-pool state (box split / draft) for the "add by set" flow. Lives on the
 * server so it survives leaving the screen, a reload, or a break, and only
 * ends when the caller finishes it.
 */
export function useCostPool({
  setCode,
  setSetCode,
  setError,
  reloadCards,
  onChanged,
}: {
  setCode: string;
  setSetCode: (code: string) => void;
  setError: (message: string | null) => void;
  reloadCards: () => void;
  onChanged: () => void;
}) {
  const [costMethod, setCostMethod] = useState<CostMethod | 'draft'>('unknown');
  const [fixedAmount, setFixedAmount] = useState('');
  const [boosterPrice, setBoosterPrice] = useState(4);
  const [pool, setPool] = useState<CostPool | null>(null);
  const [poolTotalStr, setPoolTotalStr] = useState('');
  const pooled = costMethod === 'box' || costMethod === 'draft';

  // Seed from the saved defaults, then resume any pool the server still has open.
  useEffect(() => {
    (async () => {
      let settings: Awaited<ReturnType<typeof fetchSettings>> | null = null;
      try { settings = await fetchSettings(); } catch { /* keep safe defaults */ }
      if (settings) {
        setBoosterPrice(settings.draftBoosterPriceUsd);
        setFixedAmount(settings.defaultCostFixedUsd ? String(settings.defaultCostFixedUsd) : '');
      }
      let open: CostPool | null = null;
      try { open = await fetchOpenCostPool(); } catch { /* ignore */ }
      if (open) {
        setPool(open);
        setCostMethod(open.label === 'Draft' ? 'draft' : 'box');
        setPoolTotalStr(String(open.totalCostUsd));
        if (open.setCode) setSetCode(open.setCode); // reopen the set it was working through
      } else if (settings) {
        setCostMethod(settings.defaultCostMethod);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  // While a pool is open, remember the last set the session actually opened, so
  // resuming reopens it. Clearing the field is not "forget" — the pool keeps the
  // set so the banner can offer to reopen it.
  useEffect(() => {
    if (!pool || !setCode || setCode === pool.setCode) return;
    setCostPoolSet(pool.id, setCode).then((p) => { if (p) setPool(p); }).catch(() => {});
  }, [setCode, pool]);

  // Switching the pooled method (with nothing open yet) pre-fills a sensible
  // starting total: 3× a booster for a draft, blank for a box.
  const pickMethod = (m: CostMethod | 'draft') => {
    setCostMethod(m);
    if (!pool) setPoolTotalStr(m === 'draft' ? (boosterPrice * 3).toFixed(2) : m === 'box' ? '' : poolTotalStr);
  };

  // Editing the total of an open pool re-splits it; with none open it's just the
  // amount the next pool will start with.
  const commitTotal = async () => {
    if (!pool) return;
    try { setPool(await updateCostPoolTotal(pool.id, Number(poolTotalStr) || 0)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const finishPool = async () => {
    try { await closeCostPool(); } catch { /* ignore */ }
    setPool(null);
    setPoolTotalStr(costMethod === 'draft' ? (boosterPrice * 3).toFixed(2) : '');
  };

  // Cancel abandons the session and removes every card it added — the opposite
  // of Finish, which keeps them.
  const cancelPool = async () => {
    if (!pool) return;
    const n = pool.cardCount;
    if (n > 0 && !confirm(`Discard this ${pool.label.toLowerCase()} and remove the ${n} card${n === 1 ? '' : 's'} it added?`)) return;
    setError(null);
    try {
      if (n > 0) await undoImportBatch(pool.id);
      await closeCostPool();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setPool(null);
    setPoolTotalStr(costMethod === 'draft' ? (boosterPrice * 3).toFixed(2) : '');
    reloadCards();
    onChanged();
  };

  /** Opens the pool on the first add of a session, and refreshes its running total. */
  const ensurePoolOpen = async () => {
    if (!pooled) return null;
    let current = pool;
    if (!current) {
      current = await openCostPool(Math.max(0, Number(poolTotalStr) || 0), costMethod === 'draft' ? 'Draft' : 'Box split', setCode || undefined);
      setPool(current);
    }
    return current;
  };

  const refreshPool = async () => {
    try { setPool(await fetchOpenCostPool()); } catch { /* keep prior */ }
  };

  return {
    costMethod, pickMethod, fixedAmount, setFixedAmount, boosterPrice,
    pool, poolTotalStr, setPoolTotalStr, commitTotal, finishPool, cancelPool,
    pooled, ensurePoolOpen, refreshPool,
  };
}

export type CostPoolState = ReturnType<typeof useCostPool>;

/** The "Cost" select and, for a fixed amount, the $ input beside it. */
export function CostPoolFields({ state }: { state: CostPoolState }) {
  const { costMethod, pickMethod, fixedAmount, setFixedAmount, pooled, poolTotalStr, setPoolTotalStr, commitTotal } = state;
  return (
    <>
      {/* Not a wrapping <label>: a <button> is a labelable element, so a ? inside
          one becomes the label's control and steals its clicks from the select. */}
      <div className="entry-field">
        <span><label htmlFor="cost-method">Cost</label> <HelpButton topic="costPools" /></span>
        <select id="cost-method" value={costMethod} onChange={(e) => pickMethod(e.target.value as CostMethod | 'draft')}>
          <option value="unknown">Unknown</option>
          <option value="free">Free ($0)</option>
          <option value="market">Market price</option>
          <option value="fixed">Fixed each</option>
          <option value="draft">Draft</option>
          <option value="box">Box split</option>
        </select>
      </div>
      {costMethod === 'fixed' && (
        <label style={{ width: 96 }}>
          <span>$ each</span>
          <input
            type="number" min="0" step="0.01" placeholder="0.00"
            value={fixedAmount} onChange={(e) => setFixedAmount(e.target.value)}
          />
        </label>
      )}
      {pooled && (
        <label style={{ width: 120 }}>
          <span>{costMethod === 'draft' ? 'Draft cost $' : 'Box total $'}</span>
          <input
            type="number" min="0" step="0.01" placeholder={costMethod === 'draft' ? 'e.g. 12' : 'e.g. 120'}
            value={poolTotalStr}
            onChange={(e) => setPoolTotalStr(e.target.value)}
            onBlur={commitTotal}
          />
        </label>
      )}
    </>
  );
}

/** The open-pool banner (with Finish/Cancel), or the explanatory hint before one opens. */
export function CostPoolBanner({
  state,
  setCode,
  setSetCode,
  setName,
}: {
  state: CostPoolState;
  setCode: string;
  setSetCode: (code: string) => void;
  setName: (code: string) => string;
}) {
  const { pool, pooled, costMethod, finishPool, cancelPool } = state;

  if (pool) {
    return (
      <div className="pool-banner">
        <span>
          <strong>{pool.label} open</strong> · {money(pool.totalCostUsd)} · {pool.cardCount}{' '}
          {pool.cardCount === 1 ? 'card' : 'cards'} · {money(pool.perCopy)} each
          {pool.setCode && (
            <>
              {' · '}
              <button
                className="linkish"
                onClick={() => setSetCode(pool.setCode!)}
                title="Reopen this set"
              >
                {setName(pool.setCode)}{pool.setCode === setCode ? '' : ' ↩'}
              </button>
            </>
          )}
        </span>
        <span className="pool-actions">
          <button className="btn secondary small" onClick={finishPool} title="Keep these cards and close the pool">Finish</button>
          <button className="btn secondary small cancel" onClick={cancelPool} title="Remove every card this pool added and close it">Cancel</button>
        </span>
      </div>
    );
  }

  if (!pooled) return null;
  return (
    <p className="hint">
      The first card you add opens a pool — the {costMethod === 'draft' ? 'draft cost' : 'box total'} is
      split evenly across everything you add and keeps re-dividing as you go. It stays open
      (even if you leave and come back) until you tap <strong>Finish</strong>.
      {costMethod === 'draft' && ' The total defaults to 3× the booster pack price from Data → Settings.'}
    </p>
  );
}

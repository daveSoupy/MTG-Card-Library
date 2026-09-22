import type Database from 'better-sqlite3';
import { AlertStore } from '../alerts/store.ts';
import {
  RESERVING_BOARDS, allocationForMany, allocationSettings, reserves, type DeckStatus,
} from './allocation.ts';
import {
  buildabilityForDecks, reservingDeckRows, type DeckBuildability, type StatusOverrides,
} from './buildability.ts';

/**
 * Which of my decks are fighting over the same cards, and what happens if I
 * break one up?
 *
 * Two different things get called a conflict here, and this module reports
 * both under one alert because the user's question — "do I buy a second copy
 * or move the one I own?" — is the same either way:
 *
 * - **Over-allocation.** Reserving decks' stored claims exceed what the
 *   collection can honour. Under the derived claim this is rare on purpose —
 *   reconciliation keeps the sum within what you own — so when it does happen
 *   it means the ground moved under a built deck *after* it claimed: a trade
 *   shipped the copy out, a copy went on a trade list, a status flipped.
 * - **Contention.** A reserving deck is short of a card while another reserving
 *   deck holds copies of it. Never over-allocated, because reconciliation is
 *   first come first served, but exactly as real: the second deck wants the
 *   copy and cannot have it.
 *
 * Neither figure is computed here. Over-allocation is `allocation.ts`'s numbers
 * compared; contention is `buildability.ts`'s per-row `contested` flag read
 * across every reserving deck. This module only lifts them to the collection,
 * sorts them, and turns them into an alert and a "give it to…" action.
 */

export class ContentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentionError';
  }
}

// -- shapes -------------------------------------------------------------------

export interface HoldingDeck {
  deckId: number;
  deckName: string;
  status: DeckStatus;
  /** Copies this deck's claim holds. */
  quantity: number;
}

export interface ShortDeck {
  deckId: number;
  deckName: string;
  status: DeckStatus;
  required: number;
  covered: number;
  missing: number;
}

export interface ContestedCard {
  oracleId: string;
  name: string;
  owned: number;
  tradeListed: number;
  /** `Σ (required − proxied)` across reserving decks. */
  wanted: number;
  /** `Σ claims` across reserving decks — `allocation.ts`'s `reserved`. */
  held: number;
  /**
   * Copies that would have to appear for every reserving deck to be whole:
   * `wanted − (owned − tradeListed)`. Not `Σ missing`, which double-counts a
   * copy every deck reads short of in the over-allocated case.
   */
  shortfall: number;
  unitPriceUsd: number | null;
  /** Stored claims exceed supply — the ground moved after a deck claimed. */
  overAllocated: boolean;
  holders: HoldingDeck[];
  shortDecks: ShortDeck[];
}

/** What an `allocation_conflict` alert carries. A superset of Phase 0's shape. */
export interface ContentionAlertPayload {
  oracleId: string;
  name: string;
  owned: number;
  allocated: number;
  short: number;
  holders: HoldingDeck[];
  shortDecks: ShortDeck[];
}

// -- the contested set --------------------------------------------------------

/**
 * Every contested card, worst first.
 *
 * `oracleIds` now narrows the work as well as the answer: the engine is
 * gathered only for the decks that reference those cards. It used to gather
 * every slot of every deck whatever was asked, which is what made
 * `reconcileAlerts` — one card, at the tail of every write — cost a whole-
 * collection pass. Called with no ids it still gathers everything, because
 * then everything is the answer. Sorted by shortfall, then price — the
 * expensive fights first.
 */
export function contestedCards(
  db: Database.Database,
  options: { oracleIds?: Iterable<string>; statusOverrides?: StatusOverrides } = {},
): ContestedCard[] {
  const only = options.oracleIds ? new Set(options.oracleIds) : null;
  const { settings, decks } = reservingDeckRows(db, options.statusOverrides, only ?? undefined);

  interface Accumulator {
    name: string;
    wanted: number;
    unitPriceUsd: number | null;
    contended: boolean;
    holders: HoldingDeck[];
    shortDecks: ShortDeck[];
  }
  const cards = new Map<string, Accumulator>();
  const touch = (oracleId: string, name: string, unitPriceUsd: number | null): Accumulator => {
    const existing = cards.get(oracleId);
    if (existing) return existing;
    const fresh: Accumulator = {
      name, wanted: 0, unitPriceUsd, contended: false, holders: [], shortDecks: [],
    };
    cards.set(oracleId, fresh);
    return fresh;
  };

  for (const deck of decks) {
    for (const row of deck.rows) {
      if (only && !only.has(row.oracleId)) continue;
      const card = touch(row.oracleId, row.name, row.unitPriceUsd);
      card.wanted += Math.max(0, row.required - row.proxied);
      if (row.contested) card.contended = true;
      if (row.missing > 0) {
        card.shortDecks.push({
          deckId: deck.deckId, deckName: deck.deckName, status: deck.status,
          required: row.required, covered: row.covered, missing: row.missing,
        });
      }
      const claim = deck.claims.get(row.oracleId) ?? 0;
      if (claim > 0) {
        card.holders.push({
          deckId: deck.deckId, deckName: deck.deckName, status: deck.status, quantity: claim,
        });
      }
    }
  }
  if (cards.size === 0) return [];

  // The over-allocation test is allocation.ts's own numbers compared, with the
  // trade-list term following the setting exactly as `available` does.
  const allocation = allocationForMany(db, cards.keys(), { settings });

  const result: ContestedCard[] = [];
  for (const [oracleId, card] of cards) {
    const figures = allocation.get(oracleId)!;
    // An exempt basic is outside allocation entirely; it cannot be fought over.
    if (!figures.tracked) continue;
    const subtracted = settings.tradeListReduces ? figures.tradeListed : 0;
    const supply = figures.owned - subtracted;
    const overAllocated = figures.reserved > supply;
    if (!overAllocated && !card.contended) continue;

    result.push({
      oracleId,
      name: card.name,
      owned: figures.owned,
      tradeListed: figures.tradeListed,
      wanted: card.wanted,
      held: figures.reserved,
      shortfall: Math.max(0, card.wanted - supply),
      unitPriceUsd: card.unitPriceUsd,
      overAllocated,
      holders: card.holders.sort((a, b) => b.quantity - a.quantity
        || a.deckName.localeCompare(b.deckName, undefined, { sensitivity: 'base' })),
      shortDecks: card.shortDecks.sort((a, b) => b.missing - a.missing
        || a.deckName.localeCompare(b.deckName, undefined, { sensitivity: 'base' })),
    });
  }

  return result.sort((a, b) => b.shortfall - a.shortfall
    || (b.unitPriceUsd ?? -1) - (a.unitPriceUsd ?? -1)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// -- alerts -------------------------------------------------------------------

/**
 * Brings `allocation_conflict` alerts in line with the contested set, for the
 * cards named.
 *
 * One alert per card, keyed `allocation_conflict:<oracle_id>`, raised when the
 * card is contested and resolved when it is not — so a repeat re-raises rather
 * than being swallowed by the dedupe key. Returns the shortfalls it found, in
 * Phase 0's shape, for the trade path that reports them.
 *
 * The contested set changes only when one of its inputs changes, and this is
 * called at every such point. Most of them funnel through `reconcile.ts` —
 * every `DeckStore` and `CollectionStore` write that can change a claim ends
 * there, and it calls this — so the explicit calls are the paths that
 * deliberately do *not* reconcile claims:
 *
 *   deck_cards insert/update/delete ........ reconcile.ts (via DeckStore)
 *   deck status change ..................... reconcile.ts (via DeckStore.update)
 *   deck duplicate / snapshot restore ...... reconcile.ts
 *   deck delete ............................ DeckStore.delete, after the cascade
 *   collection lot / location change ....... reconcile.ts (via CollectionStore)
 *   trade completion, incoming ............. reconcile.ts (via addLot)
 *   trade completion, outgoing ............. TradeStore — opts out of reconcile
 *   trade_list_items add/update/delete ..... TradeListStore
 *   assembly run completion ................ reconcile.ts (via assembly.ts)
 *   reassignment ........................... reassign(), below
 *   allocation setting change .............. PUT /settings, every reserving slot
 *
 * A trigger missing from this list is a stale alert. Each row has a test.
 */
export function reconcileAlerts(
  db: Database.Database,
  oracleIds: Iterable<string>,
): ContentionAlertPayload[] {
  const ids = [...new Set(oracleIds)];
  if (ids.length === 0) return [];
  const alerts = new AlertStore(db);
  const contested = new Map(contestedCards(db, { oracleIds: ids }).map((c) => [c.oracleId, c]));

  const raised: ContentionAlertPayload[] = [];
  for (const oracleId of ids) {
    const key = `allocation_conflict:${oracleId}`;
    const card = contested.get(oracleId);
    if (!card) {
      alerts.resolveByKey(key);
      continue;
    }
    const payload: ContentionAlertPayload = {
      oracleId, name: card.name, owned: card.owned, allocated: card.held,
      short: card.shortfall, holders: card.holders, shortDecks: card.shortDecks,
    };
    alerts.raise({
      kind: 'allocation_conflict',
      dedupeKey: key,
      subjectType: 'oracle_card',
      title: `Not enough ${card.name} to go round`,
      message: describe(card),
      payload,
    });
    raised.push(payload);
  }
  return raised;
}

/** The alert's one sentence. */
function describe(card: ContestedCard): string {
  const copies = (n: number) => `${n} cop${n === 1 ? 'y' : 'ies'}`;
  const names = (decks: Array<{ deckName: string }>) => {
    const list = decks.map((d) => d.deckName);
    return list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
  };
  const supply = card.tradeListed > 0
    ? `you own ${card.owned} with ${card.tradeListed} on a trade list`
    : `you own ${card.owned}`;
  if (card.holders.length > 0 && card.shortDecks.some((d) => !card.holders.some((h) => h.deckId === d.deckId))) {
    const short = card.shortDecks.filter((d) => !card.holders.some((h) => h.deckId === d.deckId));
    return `${names(card.holders)} ${card.holders.length === 1 ? 'has' : 'have'} it; `
      + `${names(short)} ${short.length === 1 ? 'is' : 'are'} short. `
      + `Decks want ${card.wanted} and ${supply} — ${copies(card.shortfall)} short. `
      + 'Reassign one, buy one, or take a deck apart.';
  }
  return `Decks claim ${card.held} but ${supply} — ${copies(card.shortfall)} short. `
    + 'Free one up or reacquire.';
}

/** Every card in a reserving-board slot of any deck, for the settings path. */
export function reconcileAllAlerts(db: Database.Database): ContentionAlertPayload[] {
  const boards = RESERVING_BOARDS.map((board) => `'${board}'`).join(',');
  const rows = db.prepare(`
    SELECT DISTINCT oracle_id FROM deck_cards WHERE board IN (${boards})`)
    .all() as Array<{ oracle_id: string }>;
  return reconcileAlerts(db, rows.map((row) => row.oracle_id));
}

// -- reassignment -------------------------------------------------------------

export interface ReassignResult {
  oracleId: string;
  quantity: number;
  from: DeckBuildability;
  to: DeckBuildability;
}

/**
 * Moves a claim from one deck to another.
 *
 * The one hand-write the derived claim preserves: reconciliation never takes a
 * copy from a deck already holding it, so once the winner holds the copy the
 * loser's next reconciliation finds nothing spare and leaves its 0 alone. That
 * only works between decks that reserve — a brew holds nothing, so a copy given
 * to one would be reclaimed by the loser on its next edit — and only for copies
 * the loser actually holds. Both are checked before anything is written.
 */
export function reassign(
  db: Database.Database,
  input: { oracleId: string; fromDeckId: number; toDeckId: number; quantity: number },
): ReassignResult {
  const { oracleId, fromDeckId, toDeckId } = input;
  const quantity = Math.trunc(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ContentionError('Reassign at least one copy.');
  }
  if (fromDeckId === toDeckId) throw new ContentionError('Those are the same deck.');

  const settings = allocationSettings(db);
  const boards = RESERVING_BOARDS.map((board) => `'${board}'`).join(',');
  const boardOrder: Record<string, number> = { command: 0, main: 1, side: 2 };

  db.transaction(() => {
    const deckOf = (deckId: number, role: string) => {
      const deck = db.prepare('SELECT id, name, status FROM decks WHERE id = ?').get(deckId) as
        | { id: number; name: string; status: DeckStatus } | undefined;
      if (!deck) throw new ContentionError(`No ${role} deck with that id.`);
      if (!reserves(deck.status, settings)) {
        throw new ContentionError(
          `${deck.name} is not holding cards (it is ${deck.status}), so it cannot ${role === 'source' ? 'give one up' : 'take one'}.`,
        );
      }
      return deck;
    };
    const from = deckOf(fromDeckId, 'source');
    const to = deckOf(toDeckId, 'destination');

    const slotsOf = (deckId: number) => (db.prepare(`
      SELECT id, board, quantity, quantity_from_collection, quantity_proxied
        FROM deck_cards WHERE deck_id = ? AND oracle_id = ? AND board IN (${boards})`)
      .all(deckId, oracleId) as Array<{
        id: number; board: string; quantity: number;
        quantity_from_collection: number; quantity_proxied: number;
      }>).sort((a, b) => (boardOrder[a.board] ?? 9) - (boardOrder[b.board] ?? 9) || a.id - b.id);

    const fromSlots = slotsOf(fromDeckId);
    const toSlots = slotsOf(toDeckId);
    const name = (db.prepare('SELECT name FROM oracle_cards WHERE oracle_id = ?').get(oracleId) as
      | { name: string } | undefined)?.name ?? 'that card';

    const holding = fromSlots.reduce((total, slot) => total + slot.quantity_from_collection, 0);
    if (holding < quantity) {
      throw new ContentionError(
        `${from.name} holds ${holding} of ${name}, so it cannot give up ${quantity}.`,
      );
    }
    const room = toSlots.reduce(
      (total, slot) => total + Math.max(0, slot.quantity - slot.quantity_proxied - slot.quantity_from_collection),
      0,
    );
    if (toSlots.length === 0) {
      throw new ContentionError(`${to.name} does not list ${name}.`);
    }
    if (room < quantity) {
      throw new ContentionError(
        `${to.name} only has room for ${room} more of ${name} — the rest of its slot is proxied or already held.`,
      );
    }

    const update = db.prepare('UPDATE deck_cards SET quantity_from_collection = ? WHERE id = ?');
    let left = quantity;
    for (const slot of fromSlots) {
      if (left <= 0) break;
      const take = Math.min(left, slot.quantity_from_collection);
      if (take > 0) update.run(slot.quantity_from_collection - take, slot.id);
      left -= take;
    }
    left = quantity;
    for (const slot of toSlots) {
      if (left <= 0) break;
      const space = Math.max(0, slot.quantity - slot.quantity_proxied - slot.quantity_from_collection);
      const give = Math.min(left, space);
      if (give > 0) update.run(slot.quantity_from_collection + give, slot.id);
      left -= give;
    }

    const stamp = db.prepare(
      `UPDATE decks SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
    );
    stamp.run(fromDeckId);
    stamp.run(toDeckId);
  })();

  reconcileAlerts(db, [oracleId]);

  const figures = buildabilityForDecks(db, [fromDeckId, toDeckId]);
  return {
    oracleId,
    quantity,
    from: figures.get(fromDeckId)!,
    to: figures.get(toDeckId)!,
  };
}

// -- teardown simulation ------------------------------------------------------

export interface WhatIfDelta {
  deckId: number;
  deckName: string;
  before: DeckBuildability;
  after: DeckBuildability;
}

export interface WhatIfResult {
  deckId: number;
  deckName: string;
  /** Decks whose figures would change, best improvement first. */
  changed: WhatIfDelta[];
  /** Contested cards this deck is currently holding copies of. */
  freedCards: Array<{ oracleId: string; name: string; quantity: number }>;
}

/**
 * What would breaking this deck up free?
 *
 * Pure computation: Phase 24's engine run twice, once as things are and once
 * with this deck's status overridden to `disassembled`, and the two compared.
 * Nothing is written and nothing is rolled back — the override parameter
 * exists so that no code path ever touches `decks` to ask a hypothetical.
 */
export function whatIf(db: Database.Database, deckId: number): WhatIfResult | null {
  const deck = db.prepare('SELECT id, name FROM decks WHERE id = ?').get(deckId) as
    | { id: number; name: string } | undefined;
  if (!deck) return null;

  const before = buildabilityForDecks(db);
  const after = buildabilityForDecks(db, undefined, new Map([[deckId, 'disassembled' as DeckStatus]]));
  const names = new Map((db.prepare('SELECT id, name FROM decks').all() as Array<{ id: number; name: string }>)
    .map((row) => [row.id, row.name]));

  const changed: WhatIfDelta[] = [];
  for (const [otherId, was] of before) {
    if (otherId === deckId) continue;
    const now = after.get(otherId);
    if (!now) continue;
    const same = was.coveredCards === now.coveredCards
      && was.missingCards === now.missingCards
      && was.costToCompleteUsd === now.costToCompleteUsd
      && was.contestedCount === now.contestedCount;
    if (same) continue;
    changed.push({ deckId: otherId, deckName: names.get(otherId) ?? `Deck ${otherId}`, before: was, after: now });
  }
  changed.sort((a, b) => (b.after.coveredCards - b.before.coveredCards)
    - (a.after.coveredCards - a.before.coveredCards)
    || a.deckName.localeCompare(b.deckName, undefined, { sensitivity: 'base' }));

  // Only cards this deck actually claims can appear below — a card it does not
  // hold cannot be freed by tearing it down. Asking about exactly those turns
  // the third whole-collection gather this function used to do into a scoped
  // one; before the scope existed there was no way to say so.
  const claimed = db.prepare(`
    SELECT DISTINCT oracle_id FROM deck_cards
     WHERE deck_id = ? AND quantity_from_collection > 0`).all(deckId) as Array<{
       oracle_id: string;
     }>;

  const freedCards = claimed.length === 0 ? [] : contestedCards(db, {
    oracleIds: claimed.map((row) => row.oracle_id),
  })
    .flatMap((card) => {
      const held = card.holders.find((holder) => holder.deckId === deckId);
      return held ? [{ oracleId: card.oracleId, name: card.name, quantity: held.quantity }] : [];
    });

  return { deckId, deckName: deck.name, changed, freedCards };
}

// -- the "held by" line -------------------------------------------------------

export interface CardHolders {
  oracleId: string;
  name: string;
  tracked: boolean;
  owned: number;
  reserved: number;
  tradeListed: number;
  available: number;
  /** Every deck with a claim, reserving or not — the status says which. */
  decks: Array<{
    deckId: number; deckName: string; status: DeckStatus; quantity: number;
    reserving: boolean; homeLocationName: string | null;
  }>;
  /** Where the copies physically are. */
  locations: Array<{ locationId: number; name: string; quantity: number }>;
}

/**
 * Which decks claim a card, how many, and where the copies physically live —
 * the line CLAUDE.md describes as "Deck A ×2 (home: Blue Tackle Box), Binder 3
 * ×2 available". Locations are reported raw: a claim is a count, not a lot, so
 * which physical copy a deck "has" is not knowable until Phase 25 moves it.
 */
export function cardHolders(db: Database.Database, oracleId: string): CardHolders | null {
  const card = db.prepare('SELECT name FROM oracle_cards WHERE oracle_id = ?').get(oracleId) as
    | { name: string } | undefined;
  if (!card) return null;

  const settings = allocationSettings(db);
  const figures = allocationForMany(db, [oracleId], { settings }).get(oracleId)!;
  const boards = RESERVING_BOARDS.map((board) => `'${board}'`).join(',');

  const decks = (db.prepare(`
    SELECT d.id, d.name, d.status, sl.name AS home,
           SUM(dc.quantity_from_collection) AS qty
      FROM deck_cards dc
      JOIN decks d ON d.id = dc.deck_id
      LEFT JOIN storage_locations sl ON sl.id = d.home_location_id
     WHERE dc.oracle_id = ? AND dc.board IN (${boards})
     GROUP BY d.id HAVING qty > 0
     ORDER BY qty DESC, d.name COLLATE NOCASE`).all(oracleId) as Array<{
       id: number; name: string; status: DeckStatus; home: string | null; qty: number;
     }>).map((row) => ({
       deckId: row.id, deckName: row.name, status: row.status, quantity: row.qty,
       reserving: reserves(row.status, settings), homeLocationName: row.home,
     }));

  const locations = (db.prepare(`
    SELECT sl.id, sl.name, SUM(ci.quantity) AS qty
      FROM collection_items ci
      JOIN card_printings p ON p.id = ci.printing_id
      JOIN storage_locations sl ON sl.id = ci.location_id
     WHERE p.oracle_id = ? AND sl.is_archived = 0
     GROUP BY sl.id ORDER BY sl.sort_order, sl.name COLLATE NOCASE`).all(oracleId) as Array<{
       id: number; name: string; qty: number;
     }>).map((row) => ({ locationId: row.id, name: row.name, quantity: row.qty }));

  return {
    oracleId,
    name: card.name,
    tracked: figures.tracked,
    owned: figures.owned,
    reserved: figures.reserved,
    tradeListed: figures.tradeListed,
    available: figures.available,
    decks,
    locations,
  };
}


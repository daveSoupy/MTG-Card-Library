import type Database from 'better-sqlite3';
import {
  RESERVING_BOARDS, allocationForMany, allocationSettings,
  type AllocationSettings,
} from './allocation.ts';

/**
 * Keeping a deck's claim on the collection true.
 *
 * `deck_cards.quantity_from_collection` — "the claim" — used to be the user's
 * *declaration* that a slot draws N copies from the collection, set by a chip
 * in the deck row. That chip is gone: it set the claim to the whole slot with
 * no availability check, so a deck could claim cards you owned none of, and it
 * put two numbers side by side that meant opposite things.
 *
 * With nothing setting it by hand, the claim becomes a derived figure and this
 * module owns it. The rule is simply "claim what the collection can actually
 * spare", which is a statement about reality rather than intent — so it is
 * recomputed after anything that could change reality, and never asked of the
 * user again.
 *
 * Two properties this deliberately has:
 *
 * **It raises as well as lowers.** `setQuantity` already clamps a claim down
 * into a shrinking slot, but nothing ever topped one up, so buying a card a
 * deck already listed left the deck reserving nothing — reading as covered
 * while quietly holding no cardboard, which Phase 25's pull sheets would then
 * skip.
 *
 * **It only ever touches the deck it is called for.** A global pass would let
 * editing deck A pull a contested copy out of deck B, silently. Because
 * `availableFor` already excludes copies other reserving decks hold, the deck
 * that claimed a scarce copy first keeps it, and the second deck simply reads
 * as short — which is exactly what the app showed before.
 */

/** Where a slot's claim should sit, given what the collection can spare. */
export function reconcileDeckClaims(
  db: Database.Database,
  deckId: number,
  options: { settings?: AllocationSettings } = {},
): void {
  const settings = options.settings ?? allocationSettings(db);
  const boards = RESERVING_BOARDS.map((board) => `'${board}'`).join(',');

  // Every slot, so the loop below can tell a reserving one from the rest.
  const slots = db.prepare(`
    SELECT dc.id, dc.oracle_id, dc.quantity, dc.quantity_from_collection, dc.quantity_proxied,
           dc.board IN (${boards}) AS reserving
      FROM deck_cards dc
     WHERE dc.deck_id = ?`).all(deckId) as Array<{
       id: number; oracle_id: string; reserving: number;
       quantity: number; quantity_from_collection: number; quantity_proxied: number;
     }>;
  if (slots.length === 0) return;

  // One query for the whole deck. `excludeDeckId` drops this deck's own claim
  // out of the reservation total, so a slot never competes with itself and
  // running this twice changes nothing the second time.
  const allocation = allocationForMany(
    db, slots.map((slot) => slot.oracle_id), { excludeDeckId: deckId, settings },
  );

  const update = db.prepare(
    'UPDATE deck_cards SET quantity_from_collection = ? WHERE id = ?',
  );

  for (const slot of slots) {
    const card = allocation.get(slot.oracle_id)!;
    // A slot that reserves nothing is left exactly as it is — a maybeboard
    // slot, or a basic land while the exemption is on. Their stored claim is
    // already inert: `allocation.ts` filters the maybeboard out of the
    // reservation rollup and zeroes an exempt basic's reserved count. Writing
    // 0 over it would only destroy something — turn the basics exemption off
    // and those claims are meaningful again, and the same for a card that
    // comes back off the maybeboard. This is the rule `clampDeckAllocations`
    // already applies to brews.
    if (!slot.reserving || !card.tracked) continue;

    // A proxy already fills its part of the slot, so the claim covers only
    // what is left over.
    const room = Math.max(0, slot.quantity - slot.quantity_proxied);
    const claim = Math.max(0, Math.min(room, card.available));
    if (claim !== slot.quantity_from_collection) update.run(claim, slot.id);
  }
}

/**
 * Every deck holding a card, for when the *collection* moves under them.
 *
 * Selling a lot or archiving a location changes what several decks can claim
 * at once, and none of them were being edited. Returns deck ids rather than
 * reconciling directly so the caller keeps control of transaction scope.
 */
export function decksHolding(db: Database.Database, oracleId: string): number[] {
  const boards = RESERVING_BOARDS.map((board) => `'${board}'`).join(',');
  const rows = db.prepare(`
    SELECT DISTINCT deck_id FROM deck_cards
     WHERE oracle_id = ? AND board IN (${boards})`).all(oracleId) as Array<{ deck_id: number }>;
  return rows.map((row) => row.deck_id);
}

/** Reconciles every deck that lists a card. Use after a collection change. */
export function reconcileDecksHolding(
  db: Database.Database,
  oracleId: string,
  options: { settings?: AllocationSettings } = {},
): void {
  const settings = options.settings ?? allocationSettings(db);
  for (const deckId of decksHolding(db, oracleId)) {
    reconcileDeckClaims(db, deckId, { settings });
  }
}

/** Every deck, for the one-time repair. */
export function reconcileAllDecks(db: Database.Database): number {
  const settings = allocationSettings(db);
  const decks = db.prepare('SELECT id FROM decks').all() as Array<{ id: number }>;
  for (const deck of decks) reconcileDeckClaims(db, deck.id, { settings });
  return decks.length;
}

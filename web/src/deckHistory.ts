import {
  addDeckCard, removeDeckCard, updateDeckCard,
  type Board, type Deck, type DeckCard,
} from './api.ts';

/**
 * Undo/redo for the deck builder.
 *
 * Decks autosave server-side, so a history cannot be a stack of client state:
 * the truth lives in the database. What is stacked instead is a pair of deck
 * *snapshots* — the slots as they were before a mutation and as they were
 * after — and undoing replays whichever one is wanted as API calls.
 *
 * A snapshot rather than a single inverse call, because one edit is not always
 * one change: with auto-maintain-lands on, adding a nonbasic rebalances the
 * basics in the same request. Reverting only the add would leave the basics
 * tuned for a card that is no longer there, so the whole step — add and
 * rebalance — is what gets undone.
 */

export interface DeckSlot {
  oracleId: string;
  board: Board;
  quantity: number;
  fromCollection: number;
  proxied: number;
  category: string | null;
  commanderRole: string | null;
  isBasicLand: boolean;
}

export type DeckSnapshot = DeckSlot[];

/** Slots are unique per (card, board) server-side, which is what makes them
 *  addressable across a remove-and-re-add: deck_cards ids are not. */
export const slotKey = (slot: { oracleId: string; board: Board }) =>
  `${slot.oracleId}|${slot.board}`;

export function snapshotDeck(deck: Deck): DeckSnapshot {
  return deck.cards.map((card) => ({
    oracleId: card.oracleId,
    board: card.board,
    quantity: card.quantity,
    fromCollection: card.quantityFromCollection,
    proxied: card.quantityProxied,
    category: card.category,
    commanderRole: card.commanderRole,
    isBasicLand: card.isBasicLand,
  }));
}

/** `set` means "make this slot look like this", whether or not it exists yet —
 *  which of add or update that becomes is decided against the live deck. */
export type DeckOp =
  | { kind: 'remove'; slot: DeckSlot }
  | { kind: 'set'; slot: DeckSlot };

function sameSlot(a: DeckSlot, b: DeckSlot): boolean {
  return a.quantity === b.quantity
    && a.fromCollection === b.fromCollection
    && a.proxied === b.proxied
    && a.category === b.category
    && a.commanderRole === b.commanderRole;
}

/**
 * The calls that turn `current` back into `target`.
 *
 * Ordering is load-bearing. Every nonbasic mutation re-runs the server's
 * auto-maintain-lands, which rewrites the basics; a basic-land edit does not
 * (the server skips the rebalance when the edited card is itself a basic). So
 * all nonbasic work happens first and the basics are set last, where nothing
 * can come along afterwards and re-tune them.
 *
 * Removals lead within each half so a slot's copies are released before
 * anything reclaims them.
 */
export function planRestore(current: DeckSnapshot, target: DeckSnapshot): DeckOp[] {
  const currentByKey = new Map(current.map((slot) => [slotKey(slot), slot]));
  const targetByKey = new Map(target.map((slot) => [slotKey(slot), slot]));

  const removes: DeckOp[] = [];
  const sets: DeckOp[] = [];

  for (const slot of current) {
    if (!targetByKey.has(slotKey(slot))) removes.push({ kind: 'remove', slot });
  }
  for (const slot of target) {
    const live = currentByKey.get(slotKey(slot));
    if (!live || !sameSlot(live, slot)) sets.push({ kind: 'set', slot });
  }

  const basic = (op: DeckOp) => op.slot.isBasicLand;
  return [
    ...removes.filter((op) => !basic(op)),
    ...sets.filter((op) => !basic(op)),
    ...removes.filter(basic),
    ...sets.filter(basic),
  ];
}

export interface DeckCalls {
  add: typeof addDeckCard;
  update: typeof updateDeckCard;
  remove: typeof removeDeckCard;
}

const LIVE_CALLS: DeckCalls = {
  add: addDeckCard,
  update: updateDeckCard,
  remove: removeDeckCard,
};

/** The changes a PATCH needs to bring `live` in line with `slot`, or null. */
function changesFor(live: DeckCard, slot: DeckSlot) {
  const changes: Parameters<typeof updateDeckCard>[2] = {};
  if (live.quantity !== slot.quantity) changes.quantity = slot.quantity;
  // Sent together, so a slot that swapped an owned copy for a proxy is never
  // judged mid-swap against a total it only briefly had.
  if (live.quantityFromCollection !== slot.fromCollection) {
    changes.fromCollection = slot.fromCollection;
  }
  if (live.quantityProxied !== slot.proxied) changes.quantityProxied = slot.proxied;
  if (live.category !== slot.category) changes.category = slot.category;
  if (live.commanderRole !== slot.commanderRole) {
    // Only setBoard writes the role, so the board is resent alongside it.
    changes.board = slot.board;
    changes.commanderRole = slot.commanderRole;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Replays a snapshot against the live deck.
 *
 * Every call returns the whole deck, so the plan is resolved one op at a time
 * against the freshest copy rather than against ids captured up front — the
 * server's own land rebalancing deletes and recreates basic-land slots
 * underneath us, and their ids change when it does.
 */
export async function restoreSnapshot(
  deckId: number,
  target: DeckSnapshot,
  live: Deck,
  calls: DeckCalls = LIVE_CALLS,
): Promise<Deck> {
  let latest = live;
  const ops = planRestore(snapshotDeck(live), target);

  for (const op of ops) {
    const key = slotKey(op.slot);
    const existing = latest.cards.find((card) => slotKey(card) === key);

    if (op.kind === 'remove') {
      // Already gone — the rebalance beat us to it.
      if (existing) latest = await calls.remove(deckId, existing.id);
      continue;
    }

    if (existing) {
      const changes = changesFor(existing, op.slot);
      if (changes) latest = await calls.update(deckId, existing.id, changes);
    } else {
      latest = await calls.add(deckId, op.slot.oracleId, {
        board: op.slot.board,
        quantity: op.slot.quantity,
        fromCollection: op.slot.fromCollection,
        commanderRole: op.slot.commanderRole,
      });
    }
  }

  return latest;
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planRestore, restoreSnapshot, snapshotDeck, type DeckSnapshot } from './deckHistory.ts';
import type { Board, Deck, DeckCard } from './api.ts';

/**
 * A stand-in for the deck endpoints, complete with the one server behaviour
 * undo has to survive: auto-maintain-lands rebalances the basics after every
 * nonbasic edit, and skips the rebalance when the edited card is itself a
 * basic. Here one Plains is wanted per nonbasic card, which is enough to make
 * an add or a remove move the land count.
 */
class FakeDeckApi {
  private nextId = 100;
  cards: DeckCard[] = [];

  constructor(slots: Array<Partial<DeckCard> & { oracleId: string }>) {
    for (const slot of slots) this.insert(slot);
  }

  private insert(slot: Partial<DeckCard> & { oracleId: string }): DeckCard {
    const card = {
      id: this.nextId++,
      board: 'main' as Board,
      quantity: 1,
      quantityFromCollection: 0,
      category: null,
      commanderRole: null,
      isBasicLand: false,
      name: slot.oracleId,
      ...slot,
    } as DeckCard;
    this.cards.push(card);
    return card;
  }

  private deck(): Deck {
    // Only the slots matter here; the rest of the deck resource is untouched
    // by a replay.
    return { id: 1, cards: this.cards.map((card) => ({ ...card })) } as unknown as Deck;
  }

  private maintainLands(editedOracleId: string): void {
    if (this.cards.some((c) => c.oracleId === editedOracleId && c.isBasicLand)) return;
    const wanted = this.cards
      .filter((c) => !c.isBasicLand && c.board === 'main')
      .reduce((total, c) => total + c.quantity, 0);
    const plains = this.cards.find((c) => c.isBasicLand && c.board === 'main');
    if (wanted === 0) {
      this.cards = this.cards.filter((c) => c !== plains);
    } else if (plains) {
      plains.quantity = wanted;
    } else {
      this.insert({ oracleId: 'PLAINS', isBasicLand: true, quantity: wanted });
    }
  }

  add = async (
    _deckId: number,
    oracleId: string,
    options: { board?: Board; quantity?: number; fromCollection?: number; commanderRole?: string | null } = {},
  ): Promise<Deck> => {
    const board = options.board ?? 'main';
    const existing = this.cards.find((c) => c.oracleId === oracleId && c.board === board);
    if (existing) {
      existing.quantity += options.quantity ?? 1;
      existing.quantityFromCollection += options.fromCollection ?? 0;
    } else {
      this.insert({
        oracleId,
        board,
        quantity: options.quantity ?? 1,
        quantityFromCollection: options.fromCollection ?? 0,
        commanderRole: options.commanderRole ?? null,
        isBasicLand: oracleId === 'PLAINS',
      });
    }
    this.maintainLands(oracleId);
    return this.deck();
  };

  update = async (_deckId: number, cardId: number, changes: Record<string, any>): Promise<Deck> => {
    const card = this.cards.find((c) => c.id === cardId);
    assert.ok(card, `no slot ${cardId}`);
    if (changes.quantity !== undefined) {
      if (changes.quantity <= 0) this.cards = this.cards.filter((c) => c !== card);
      else {
        card.quantity = changes.quantity;
        card.quantityFromCollection = Math.min(card.quantityFromCollection, changes.quantity);
      }
    }
    if (changes.fromCollection !== undefined) {
      card.quantityFromCollection = Math.max(0, Math.min(card.quantity, changes.fromCollection));
    }
    if (changes.category !== undefined) card.category = changes.category;
    if (changes.board !== undefined) {
      card.board = changes.board;
      card.commanderRole = changes.commanderRole ?? null;
    }
    if (changes.quantity !== undefined || changes.board !== undefined) {
      this.maintainLands(card.oracleId);
    }
    return this.deck();
  };

  remove = async (_deckId: number, cardId: number): Promise<Deck> => {
    const card = this.cards.find((c) => c.id === cardId);
    assert.ok(card);
    this.cards = this.cards.filter((c) => c !== card);
    this.maintainLands(card.oracleId);
    return this.deck();
  };

  get current(): Deck { return this.deck(); }
}

const slots = (snapshot: DeckSnapshot) =>
  snapshot.map((s) => `${s.oracleId}:${s.board}:${s.quantity}/${s.fromCollection}`).sort();

describe('planRestore', () => {
  it('sets a slot back only when something about it changed', () => {
    const before: DeckSnapshot = [{
      oracleId: 'SOL', board: 'main', quantity: 2, fromCollection: 1, proxied: 0,
      category: null, commanderRole: null, isBasicLand: false,
    }];
    assert.deepEqual(planRestore(before, before), []);

    const after: DeckSnapshot = [{ ...before[0], quantity: 3 }];
    const ops = planRestore(before, after);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'set');
    assert.equal(ops[0].slot.quantity, 3);
  });

  it('leaves the basics until last, so no rebalance can follow them', () => {
    const current: DeckSnapshot = [
      { oracleId: 'PLAINS', board: 'main', quantity: 9, fromCollection: 0, proxied: 0, category: null, commanderRole: null, isBasicLand: true },
      { oracleId: 'SOL', board: 'main', quantity: 1, fromCollection: 0, proxied: 0, category: null, commanderRole: null, isBasicLand: false },
      { oracleId: 'BOLT', board: 'main', quantity: 1, fromCollection: 0, proxied: 0, category: null, commanderRole: null, isBasicLand: false },
    ];
    const target: DeckSnapshot = [
      { ...current[0], quantity: 12 },
      { ...current[2], quantity: 4 },
    ];

    const ops = planRestore(current, target);
    assert.deepEqual(
      ops.map((op) => `${op.kind} ${op.slot.oracleId}`),
      ['remove SOL', 'set BOLT', 'set PLAINS'],
    );
  });
});

describe('restoreSnapshot', () => {
  it('puts a removed slot back with its exact quantity and allocation', async () => {
    const api = new FakeDeckApi([
      { oracleId: 'SOL', quantity: 2, quantityFromCollection: 1 },
      { oracleId: 'PLAINS', quantity: 2, isBasicLand: true },
    ]);
    const before = snapshotDeck(api.current);

    // The removal the user is about to undo, rebalancing the basics with it.
    const sol = api.cards.find((c) => c.oracleId === 'SOL')!;
    await api.remove(1, sol.id);
    assert.equal(api.cards.find((c) => c.oracleId === 'SOL'), undefined);
    assert.equal(api.cards.find((c) => c.oracleId === 'PLAINS'), undefined);

    await restoreSnapshot(1, before, api.current, api);

    assert.deepEqual(slots(snapshotDeck(api.current)), slots(before));
    const restored = api.cards.find((c) => c.oracleId === 'SOL')!;
    assert.equal(restored.quantity, 2);
    assert.equal(restored.quantityFromCollection, 1);
    // The basics are back at their pre-removal count, not at whatever the
    // rebalance left behind.
    assert.equal(api.cards.find((c) => c.oracleId === 'PLAINS')!.quantity, 2);
  });

  it('undoes an add and the basic-land rebalance it triggered as one step', async () => {
    const api = new FakeDeckApi([
      { oracleId: 'SOL', quantity: 1 },
      { oracleId: 'PLAINS', quantity: 1, isBasicLand: true },
    ]);
    const before = snapshotDeck(api.current);

    await api.add(1, 'BOLT', { quantity: 3 });
    assert.equal(api.cards.find((c) => c.oracleId === 'PLAINS')!.quantity, 4);

    await restoreSnapshot(1, before, api.current, api);

    assert.deepEqual(slots(snapshotDeck(api.current)), slots(before));
    assert.equal(api.cards.find((c) => c.oracleId === 'BOLT'), undefined);
    assert.equal(api.cards.find((c) => c.oracleId === 'PLAINS')!.quantity, 1);
  });

  it('redoes a step by replaying the snapshot taken after it', async () => {
    const api = new FakeDeckApi([{ oracleId: 'SOL', quantity: 1 }]);
    const before = snapshotDeck(api.current);
    await api.add(1, 'BOLT', { quantity: 2 });
    const after = snapshotDeck(api.current);

    await restoreSnapshot(1, before, api.current, api);
    await restoreSnapshot(1, after, api.current, api);

    assert.deepEqual(slots(snapshotDeck(api.current)), slots(after));
  });

  it('restores a command-zone slot with its role', async () => {
    const api = new FakeDeckApi([
      { oracleId: 'ATRAXA', board: 'command', quantity: 1, commanderRole: 'commander' },
    ]);
    const before = snapshotDeck(api.current);
    await api.remove(1, api.cards[0].id);

    await restoreSnapshot(1, before, api.current, api);

    const restored = api.cards.find((c) => c.oracleId === 'ATRAXA')!;
    assert.equal(restored.board, 'command');
    assert.equal(restored.commanderRole, 'commander');
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { DeckStore } from './store.ts';
import { TemplateStore, computeTemplateProgress, loadTemplate, TemplateNotFoundError } from './templates.ts';
import type { DeckCard } from './types.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function card(overrides: Partial<DeckCard>): DeckCard {
  return {
    id: 1, oracleId: 'o-x', name: 'X', board: 'main', quantity: 1, quantityFromCollection: 0,
    commanderRole: null, category: null, categories: [], sortOrder: 0, cmc: 1, typeLine: '',
    manaCost: null, colorIdentity: '', colorIdentityMask: 0, colorsMask: 0, isBasicLand: false,
    isLegendary: false, canBeCommander: false, hasUncommonPrinting: false, producedMana: [],
    partnerKind: null, partnerWith: null, legality: null, ownedQuantity: 0, availableQuantity: 0,
    printingId: null, setCode: null, rarity: null, imageSmall: null, priceUsd: null,
    ...overrides,
  };
}

test('computeTemplateProgress: a card counts toward every tag category it matches', () => {
  const template = loadTemplateFixture([
    { category: 'ramp', ideal: 10 },
    { category: 'draw', ideal: 10 },
  ]);
  const cards = [
    card({ id: 1, oracleId: 'o-cultivate', quantity: 1, categories: ['ramp', 'draw'] }),
  ];
  const progress = computeTemplateProgress(cards, template);
  assert.equal(progress.rows.find((r) => r.category === 'ramp')!.current, 1);
  assert.equal(progress.rows.find((r) => r.category === 'draw')!.current, 1);
  // Deliberately not claiming to equal deck size — see the phase's counting rule.
  assert.equal(progress.countedTotal, 1);
});

test('computeTemplateProgress: a manual category overrides tag categories entirely', () => {
  const template = loadTemplateFixture([
    { category: 'ramp', ideal: 10 },
    { category: 'draw', ideal: 10 },
  ]);
  const cards = [
    card({ id: 1, category: 'Draw', categories: ['ramp'] }),
  ];
  const progress = computeTemplateProgress(cards, template);
  assert.equal(progress.rows.find((r) => r.category === 'ramp')!.current, 0);
  assert.equal(progress.rows.find((r) => r.category === 'draw')!.current, 1);
});

test('computeTemplateProgress: lands and creatures resolve from type_line, not tags', () => {
  const template = loadTemplateFixture([
    { category: 'lands', ideal: 38 },
    { category: 'creatures', ideal: 20 },
  ]);
  const cards = [
    card({ id: 1, typeLine: 'Basic Land — Forest', quantity: 10 }),
    card({ id: 2, typeLine: 'Legendary Creature — Angel', quantity: 1 }),
  ];
  const progress = computeTemplateProgress(cards, template);
  assert.equal(progress.rows.find((r) => r.category === 'lands')!.current, 10);
  assert.equal(progress.rows.find((r) => r.category === 'creatures')!.current, 1);
});

test('computeTemplateProgress: a category at or above its ideal is reported as met, not short', () => {
  // Mirrors the phase doc's verification case: a seeded 38/10/10 Commander
  // deck reports lands, ramp and draw as met.
  const template = loadTemplateFixture([
    { category: 'lands', ideal: 38 },
    { category: 'ramp', ideal: 10 },
    { category: 'draw', ideal: 10 },
  ]);
  const cards = [
    card({ id: 1, typeLine: 'Basic Land — Forest', quantity: 38 }),
    ...Array.from({ length: 10 }, (_, i) => card({ id: 100 + i, categories: ['ramp'], quantity: 1 })),
    ...Array.from({ length: 10 }, (_, i) => card({ id: 200 + i, categories: ['draw'], quantity: 1 })),
  ];
  const progress = computeTemplateProgress(cards, template);
  for (const row of progress.rows) {
    assert.equal(row.isShort, false, `${row.category} should read as met`);
    assert.equal(row.current, row.ideal);
  }
});

test('computeTemplateProgress: tagDataAvailable is carried through and changes no count', () => {
  // The flag exists so the panel can say *why* a row reads zero. It must not
  // become a second way to compute the row itself.
  const template = loadTemplateFixture([{ category: 'ramp', ideal: 10 }]);
  const cards = [card({ id: 1, quantity: 2, categories: ['ramp'] })];

  const withTags = computeTemplateProgress(cards, template, true);
  const without = computeTemplateProgress(cards, template, false);

  assert.equal(withTags.tagDataAvailable, true);
  assert.equal(without.tagDataAvailable, false);
  assert.equal(without.rows[0].current, withTags.rows[0].current);
  assert.equal(without.uncategorisedCount, withTags.uncategorisedCount);
  // Defaults to true, so every existing caller reads unchanged.
  assert.equal(computeTemplateProgress(cards, template).tagDataAvailable, true);
});

test('computeTemplateProgress: uncategorised is its own count, not hidden', () => {
  const template = loadTemplateFixture([{ category: 'ramp', ideal: 10 }]);
  const cards = [
    card({ id: 1, quantity: 3, categories: [] }),
    card({ id: 2, quantity: 2, categories: ['ramp'] }),
  ];
  const progress = computeTemplateProgress(cards, template);
  assert.equal(progress.uncategorisedCount, 3);
  assert.equal(progress.rows[0].current, 2);
});

test('computeTemplateProgress: sideboard and maybeboard are excluded', () => {
  const template = loadTemplateFixture([{ category: 'ramp', ideal: 10 }]);
  const cards = [
    card({ id: 1, board: 'side', quantity: 5, categories: ['ramp'] }),
    card({ id: 2, board: 'maybe', quantity: 5, categories: ['ramp'] }),
    card({ id: 3, board: 'main', quantity: 1, categories: ['ramp'] }),
  ];
  const progress = computeTemplateProgress(cards, template);
  assert.equal(progress.rows[0].current, 1);
});

function loadTemplateFixture(targets: Array<{ category: string; ideal: number }>) {
  return {
    id: 1,
    name: 'Fixture',
    formatCode: null,
    archetype: null,
    description: null,
    isBuiltin: false,
    sortOrder: 0,
    targets: targets.map((t, i) => ({
      category: t.category, label: t.category, ideal: t.ideal,
      minCount: null, maxCount: null, note: null, sortOrder: i,
    })),
  };
}

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

test('TemplateStore: seeded builtins resolve their counts from schema.sql', () => {
  const db = fixtureDb();
  const templates = new TemplateStore(db);
  const general = templates.list().find((t) => t.name === 'Commander — General')!;
  assert.ok(general);
  assert.equal(general.isBuiltin, true);
  const lands = general.targets.find((t) => t.category === 'lands')!;
  assert.equal(lands.ideal, 38);
  db.close();
});

test('TemplateStore: create, update targets, and clone', () => {
  const db = fixtureDb();
  const templates = new TemplateStore(db);

  const id = templates.create({
    name: 'My template',
    targets: [{ category: 'ramp', ideal: 8 }],
  });
  assert.equal(templates.get(id)!.targets[0].ideal, 8);

  templates.update(id, { targets: [{ category: 'ramp', ideal: 12 }, { category: 'draw', ideal: 6 }] });
  const updated = templates.get(id)!;
  assert.equal(updated.targets.length, 2);
  assert.equal(updated.targets.find((t) => t.category === 'ramp')!.ideal, 12);

  const cloneId = templates.clone(id, 'Clone');
  const clone = templates.get(cloneId)!;
  assert.equal(clone.name, 'Clone');
  assert.equal(clone.isBuiltin, false);
  assert.equal(clone.targets.length, 2);
  db.close();
});

test('TemplateStore: deleting a template sets decks.template_id to NULL, not deleting the deck', () => {
  const db = fixtureDb();
  const templates = new TemplateStore(db);
  const decks = new DeckStore(db);

  const templateId = templates.create({ name: 'Temp', targets: [{ category: 'ramp', ideal: 5 }] });
  const deckId = decks.create({ name: 'Test deck' });
  decks.update(deckId, { templateId });
  assert.equal(decks.get(deckId)!.templateId, templateId);

  templates.delete(templateId);
  const deck = decks.get(deckId)!;
  assert.equal(deck.templateId, null);
  assert.equal(deck.templateProgress, null);
  db.close();
});

test('TemplateStore: operating on a missing template throws TemplateNotFoundError', () => {
  const db = fixtureDb();
  const templates = new TemplateStore(db);
  assert.throws(() => templates.update(9999, { name: 'x' }), TemplateNotFoundError);
  assert.throws(() => templates.delete(9999), TemplateNotFoundError);
  db.close();
});

test('DeckStore.get: turning a template off (template_id -> null) leaves the deck untouched', () => {
  const db = fixtureDb();
  const templates = new TemplateStore(db);
  const decks = new DeckStore(db);

  const templateId = templates.create({ name: 'Temp', targets: [{ category: 'ramp', ideal: 5 }] });
  const deckId = decks.create({ name: 'Test deck' });
  decks.update(deckId, { templateId });
  assert.ok(decks.get(deckId)!.templateProgress);

  decks.update(deckId, { templateId: null });
  const deck = decks.get(deckId)!;
  assert.equal(deck.templateId, null);
  assert.equal(deck.templateProgress, null);
  assert.equal(loadTemplate(db, templateId)?.name, 'Temp');
  db.close();
});

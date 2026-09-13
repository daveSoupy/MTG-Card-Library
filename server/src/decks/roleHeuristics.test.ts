import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_ROOTS } from '../sync/categories.ts';
import { ROLE_PATTERNS, heuristicRoles } from './roleHeuristics.ts';

/**
 * The keyword stand-in for card_categories. Real oracle text, chosen so that
 * each rule has one card that should fire it and one near-miss that must not —
 * precision is what the heuristic is for.
 */

const roles = (text: string, type = 'Instant') => heuristicRoles(text, type).sort();

test('every pattern maps to a category the tagger also produces', () => {
  for (const rule of ROLE_PATTERNS) assert.ok(rule.category in CATEGORY_ROOTS, rule.category);
});

test('removal: destroy, exile, damage, edicts, fight, -X/-X', () => {
  assert.deepEqual(roles('Destroy target creature.'), ['removal']);
  assert.deepEqual(roles('Destroy target nonblack creature.'), ['removal']);
  assert.deepEqual(roles('Exile target creature. Its controller gains 2 life.'), ['removal']);
  assert.deepEqual(roles('Lightning Bolt deals 3 damage to any target.'), ['removal']);
  assert.deepEqual(roles('Target creature gets -3/-3 until end of turn.'), ['removal']);
  assert.deepEqual(roles('Target creature gets -X/-X until end of turn.'), ['removal']);
  assert.deepEqual(roles('Each opponent sacrifices a creature.'), ['removal']);
  assert.deepEqual(roles('Target creature you control fights target creature you don\'t control.', 'Sorcery'), ['removal']);
  assert.deepEqual(roles('Whenever a creature enters, destroy target artifact.'), ['removal']);
});

test('sweeper: all creatures, and damage to each', () => {
  assert.deepEqual(roles('Destroy all creatures. They can\'t be regenerated.', 'Sorcery'), ['sweeper']);
  assert.deepEqual(roles('Anger of the Gods deals 3 damage to each creature.', 'Sorcery'), ['sweeper']);
  assert.deepEqual(roles('All creatures get -2/-2 until end of turn.'), ['sweeper']);
  assert.deepEqual(roles('Exile all nonland permanents.', 'Sorcery'), ['sweeper']);
});

test('draw', () => {
  assert.deepEqual(roles('Scry 1. Draw a card.'), ['draw']);
  assert.deepEqual(roles('Draw three cards, then discard a card.'), ['draw']);
  assert.deepEqual(roles('Draw X cards.'), ['draw']);
  assert.deepEqual(roles('Each player draws a card.'), [], 'symmetric effects are not card draw');
});

test('ramp: rocks, dorks, land search — but not a land\'s own mana', () => {
  assert.deepEqual(roles('{T}: Add {C}.', 'Artifact'), ['ramp']);
  assert.deepEqual(roles('{T}: Add {G}.', 'Creature — Elf Druid'), ['ramp']);
  assert.deepEqual(roles('Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.', 'Sorcery'), ['ramp']);
  assert.deepEqual(roles('Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', 'Sorcery'), ['ramp']);
  assert.deepEqual(roles('You may play an additional land on each of your turns.', 'Enchantment'), ['ramp']);
  assert.deepEqual(roles('{T}: Add {G}.', 'Basic Land — Forest'), [], 'a Forest is not ramp');
  assert.deepEqual(roles('{T}: Add {G}.', 'Land'), []);
  assert.deepEqual(roles('Flying // {T}: Add {U}.', 'Creature — Bird // Land'), [], 'nor is a modal DFC\'s land face');
  assert.deepEqual(roles('{T}: Add {G}.', 'Land Creature — Forest Dryad'), ['ramp'], 'but Dryad Arbor is a creature');
});

test('counterspell — and Ward\'s reminder text is not one', () => {
  assert.deepEqual(roles('Counter target spell.'), ['counterspell']);
  assert.deepEqual(roles('Counter target noncreature spell.'), ['counterspell']);
  assert.deepEqual(roles('Counter target activated or triggered ability.'), ['counterspell']);
  assert.deepEqual(roles('Ward {2} (Whenever this creature becomes the target of a spell or ability an opponent controls, counter it unless that player pays {2}.)', 'Creature — Giant'), []);
});

test('tutor: non-land searches; a land search is ramp, and a card that does both is both', () => {
  assert.deepEqual(roles('Search your library for a card, put that card into your hand, then shuffle.'), ['tutor']);
  assert.deepEqual(roles('Search your library for a creature card, reveal it, put it into your hand, then shuffle.', 'Sorcery'), ['tutor']);
  assert.deepEqual(roles('Search your library for an artifact card, reveal it, put it into your hand, then shuffle.', 'Sorcery'), ['tutor']);
  assert.deepEqual(roles('Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.', 'Sorcery'), ['ramp']);
  assert.deepEqual(
    roles('Search your library for a land card, put it onto the battlefield, then shuffle. Draw a card.', 'Sorcery'),
    ['draw', 'ramp'],
  );
});

test('recursion', () => {
  assert.deepEqual(roles('Return target creature card from your graveyard to the battlefield.', 'Sorcery'), ['recursion']);
  assert.deepEqual(roles('Return up to two target creature cards from your graveyard to your hand.'), ['recursion']);
  assert.deepEqual(roles('Return target permanent card from your graveyard to your hand.'), ['recursion']);
});

test('protection: granted, not merely possessed', () => {
  assert.deepEqual(roles('Target creature gains hexproof and indestructible until end of turn.'), ['protection']);
  assert.deepEqual(roles('Creatures you control gain indestructible until end of turn.'), ['protection']);
  assert.deepEqual(roles('You have hexproof.', 'Enchantment'), ['protection']);
  // Turn Aside is honestly both: it counters, and it does so to protect.
  assert.deepEqual(roles('Counter target spell that targets a creature you control.'), ['counterspell', 'protection']);
  assert.deepEqual(roles('Hexproof', 'Creature — Human Rogue'), [], 'a creature that has hexproof protects nobody else');
});

test('nothing in, nothing out', () => {
  assert.deepEqual(heuristicRoles(null, 'Creature — Bear'), []);
  assert.deepEqual(heuristicRoles('', 'Creature — Bear'), []);
  assert.deepEqual(heuristicRoles('Flying, vigilance', 'Creature — Angel'), []);
});

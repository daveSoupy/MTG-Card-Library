import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv, guessMapping, applyMapping, normalizeCondition, normalizeFinish, normalizeLanguage, } from './csv.ts';

test('quoted fields keep their commas', () => {
  // The reason a naive split(',') cannot be used: card names contain commas.
  const table = parseCsv('Name,Count\n"Atraxa, Praetors\' Voice",1\nSol Ring,2');
  assert.deepEqual(table.headers, ['Name', 'Count']);
  assert.deepEqual(table.rows[0], ["Atraxa, Praetors' Voice", '1']);
  assert.deepEqual(table.rows[1], ['Sol Ring', '2']);
});

test('escaped quotes inside a quoted field survive', () => {
  const table = parseCsv('Name\n"Say ""Hello"" Twice"');
  assert.equal(table.rows[0][0], 'Say "Hello" Twice');
});

test('a UTF-8 BOM does not become part of the first header', () => {
  const table = parseCsv('﻿Name,Count\nSol Ring,1');
  assert.deepEqual(table.headers, ['Name', 'Count']);
  assert.equal(guessMapping(table.headers)[0], 'name');
});

test('CRLF line endings and trailing blank lines are handled', () => {
  const table = parseCsv('Name,Count\r\nSol Ring,1\r\n\r\n');
  assert.equal(table.rows.length, 1);
  assert.deepEqual(table.rows[0], ['Sol Ring', '1']);
});

test('Deckbox headers are recognised', () => {
  const mapping = guessMapping(['Count', 'Name', 'Edition', 'Card Number', 'Condition', 'Language', 'Foil']);
  assert.deepEqual(mapping,
    ['quantity', 'name', 'setName', 'collectorNumber', 'condition', 'language', 'finish']);
});

test('ManaBox headers are recognised', () => {
  const mapping = guessMapping(['Name', 'Set code', 'Set name', 'Collector number', 'Foil', 'Quantity', 'Condition']);
  assert.deepEqual(mapping,
    ['name', 'setCode', 'setName', 'collectorNumber', 'finish', 'quantity', 'condition']);
});

test('unrecognised columns are ignored rather than guessed at', () => {
  const mapping = guessMapping(['Name', 'Quantity', 'Rarity', 'My Personal Notes']);
  assert.deepEqual(mapping, ['name', 'quantity', 'ignore', 'ignore']);
});

test('a role is claimed once, so a second name-like column does not steal it', () => {
  const mapping = guessMapping(['Name', 'Simple Name', 'Quantity']);
  assert.deepEqual(mapping, ['name', 'ignore', 'quantity']);
});

test('foil spellings across exporters all resolve', () => {
  for (const value of ['foil', 'Foil', 'yes', 'true', '1', 'premium']) {
    assert.equal(normalizeFinish(value), 'foil', value);
  }
  assert.equal(normalizeFinish('etched'), 'etched');
  for (const value of ['', 'no', 'false', '0', 'normal']) {
    assert.equal(normalizeFinish(value), 'nonfoil', value);
  }
});

test('condition names map onto the schema’s vocabulary', () => {
  assert.equal(normalizeCondition('Near Mint'), 'NM');
  assert.equal(normalizeCondition('nm'), 'NM');
  assert.equal(normalizeCondition('Slightly Played'), 'LP');
  assert.equal(normalizeCondition('Heavily Played'), 'HP');
  assert.equal(normalizeCondition('Damaged'), 'DMG');
  // Anything unrecognised is recorded as unknown rather than guessed at NM.
  assert.equal(normalizeCondition('pristine-ish'), 'unknown');
  assert.equal(normalizeCondition(''), 'unknown');
});

test('a mapped row carries everything needed to create a lot', () => {
  const table = parseCsv([
    'Name,Set code,Collector number,Quantity,Foil,Condition,Purchase price',
    '"Atraxa, Praetors\' Voice",cmr,3,2,foil,Near Mint,$12.50',
  ].join('\n'));
  const { rows, skipped } = applyMapping(table, guessMapping(table.headers));

  assert.equal(skipped.length, 0);
  assert.deepEqual(rows[0], {
    name: "Atraxa, Praetors' Voice",
    setCode: 'cmr', setName: null, collectorNumber: '3',
    quantity: 2, finish: 'foil', condition: 'NM', language: 'en',
    price: 12.5, lineNumber: 2,
  });
});

test('a missing quantity column defaults to one copy', () => {
  const table = parseCsv('Name\nSol Ring');
  const { rows } = applyMapping(table, guessMapping(table.headers));
  assert.equal(rows[0].quantity, 1);
});

test('unusable rows are reported with their line number, not dropped silently', () => {
  const table = parseCsv('Name,Quantity\nSol Ring,2\n,3\nCounterspell,zero');
  const { rows, skipped } = applyMapping(table, guessMapping(table.headers));

  assert.equal(rows.length, 1);
  assert.deepEqual(skipped.map((s) => s.lineNumber), [3, 4]);
  assert.match(skipped[0].reason, /No card name/);
  assert.match(skipped[1].reason, /not a positive number/);
});

test('the user can override a guessed mapping', () => {
  const table = parseCsv('Card,Amount\nSol Ring,3');
  // Suppose the guess were wrong; an explicit mapping must win.
  const { rows } = applyMapping(table, ['name', 'quantity']);
  assert.equal(rows[0].name, 'Sol Ring');
  assert.equal(rows[0].quantity, 3);
});

test('language spellings collapse to one code, so lots do not split', () => {
  assert.equal(normalizeLanguage('English'), 'en');
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(normalizeLanguage('EN'), 'en');
  assert.equal(normalizeLanguage(''), 'en', 'blank means English');
  assert.equal(normalizeLanguage('Japanese'), 'ja');
  assert.equal(normalizeLanguage('jp'), 'ja', "exporters write Japanese as 'jp'");
  // Not recognised, so kept rather than silently relabelled English.
  assert.equal(normalizeLanguage('Klingon'), 'klingon');
});

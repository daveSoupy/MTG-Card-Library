import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeckIssue, DeckValidation } from './api.ts';
import { legalityVerdict } from './legality.ts';

const validation = (issues: DeckIssue[]): DeckValidation => ({
  formatCode: 'modern', formatName: 'Modern', commanderIdentity: null, countedTotal: 60,
  mainCount: 60, sideboardCount: 0, commandCount: 0, maybeCount: 0,
  requiredExactSize: null, requiredMinSize: 60, sideboardLimit: 15,
  issues, isLegal: !issues.some((issue) => issue.severity === 'error'),
});

const error: DeckIssue = { severity: 'error', code: 'banned', message: 'Banned.' };
const warning: DeckIssue = { severity: 'warning', code: 'no_format', message: 'No format.' };

test('errors are problems, and the count is of what the section lists as problems', () => {
  const verdict = legalityVerdict(validation([error, error, warning]));
  assert.equal(verdict.text, '2 problems');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.length + verdict.notes.length, 3, 'every issue is listed somewhere');
});

test('warnings alone leave a deck legal, and say so', () => {
  assert.equal(legalityVerdict(validation([warning])).text, 'Legal · 1 note');
  assert.equal(legalityVerdict(validation([])).text, 'Legal');
  assert.equal(legalityVerdict(validation([error])).text, '1 problem');
});

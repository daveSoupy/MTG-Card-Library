import type { DeckCard, DeckIssue, DeckValidation, FormatRules } from './types.ts';

/**
 * Checks a deck against its format's rules.
 *
 * Every rule reads from the seeded `formats` row rather than branching on the
 * format's name, so adding a format is a database row and not a code change.
 *
 * Nothing here blocks editing — a deck is always saveable. Errors mean "this
 * would not be legal at a table"; warnings mean "you should know about this".
 */
export function validateDeck(cards: DeckCard[], rules: FormatRules | null): DeckValidation {
  const issues: DeckIssue[] = [];

  const main = cards.filter((c) => c.board === 'main');
  const side = cards.filter((c) => c.board === 'side');
  const command = cards.filter((c) => c.board === 'command');
  const maybe = cards.filter((c) => c.board === 'maybe');

  const sum = (list: DeckCard[]) => list.reduce((total, card) => total + card.quantity, 0);
  const mainCount = sum(main);
  const sideboardCount = sum(side);
  const commandCount = sum(command);
  const maybeCount = sum(maybe);

  if (!rules) {
    issues.push({
      severity: 'warning',
      code: 'no_format',
      message: 'No format selected, so deck rules are not being checked.',
    });
    return {
      formatCode: null, formatName: null,
      countedTotal: mainCount + commandCount,
      mainCount, sideboardCount, commandCount, maybeCount,
      requiredExactSize: null, requiredMinSize: null, sideboardLimit: null,
      issues,
      isLegal: true,
    };
  }

  // The command zone counts toward a Commander deck's 100: 99 + the commander.
  // The maybeboard never counts — it is a scratch pad.
  const countedTotal = mainCount + commandCount;

  checkDeckSize(issues, rules, countedTotal);
  checkSideboard(issues, rules, sideboardCount);
  checkCopyLimits(issues, rules, cards);
  checkLegality(issues, rules, cards);
  checkCommander(issues, rules, command, commandCount);
  checkAllocation(issues, cards);

  return {
    formatCode: rules.code,
    formatName: rules.displayName,
    countedTotal,
    mainCount, sideboardCount, commandCount, maybeCount,
    requiredExactSize: rules.exactDeckSize,
    requiredMinSize: rules.minDeckSize,
    sideboardLimit: rules.sideboardSize,
    issues,
    isLegal: !issues.some((issue) => issue.severity === 'error'),
  };
}

/**
 * Formats with an exact size must hit it precisely — a 101-card Commander deck
 * is as illegal as a 99-card one, which is why this is not a minimum check.
 */
function checkDeckSize(issues: DeckIssue[], rules: FormatRules, total: number): void {
  if (rules.exactDeckSize !== null) {
    if (total !== rules.exactDeckSize) {
      const difference = total - rules.exactDeckSize;
      const detail = difference > 0
        ? `${difference} too many`
        : `${-difference} more needed`;
      issues.push({
        severity: 'error',
        code: 'deck_size_exact',
        message: `${rules.displayName} decks must be exactly ${rules.exactDeckSize} cards. This deck has ${total} — ${detail}.`,
      });
    }
    return;
  }

  if (rules.minDeckSize !== null && total < rules.minDeckSize) {
    issues.push({
      severity: 'error',
      code: 'deck_size_min',
      message: `${rules.displayName} decks need at least ${rules.minDeckSize} cards. This deck has ${total} — ${rules.minDeckSize - total} more needed.`,
    });
  }
}

function checkSideboard(issues: DeckIssue[], rules: FormatRules, sideboardCount: number): void {
  const limit = rules.sideboardSize ?? 0;
  if (sideboardCount > limit) {
    issues.push({
      severity: 'error',
      code: 'sideboard_size',
      message: limit === 0
        ? `${rules.displayName} does not use a sideboard, but this deck has ${sideboardCount} card${sideboardCount === 1 ? '' : 's'} in one.`
        : `A ${rules.displayName} sideboard holds at most ${limit} cards. This one has ${sideboardCount}.`,
    });
  }
}

/**
 * Copy limits count main and sideboard together, which is the actual rule —
 * four Lightning Bolts maindeck plus one in the sideboard is five, not "four
 * and one". Basic lands are exempt, and so are cards whose text overrides the
 * limit (Relentless Rats and friends).
 */
function checkCopyLimits(issues: DeckIssue[], rules: FormatRules, cards: DeckCard[]): void {
  const counted = cards.filter((c) => c.board === 'main' || c.board === 'side' || c.board === 'command');
  const totals = new Map<string, { card: DeckCard; quantity: number }>();

  for (const card of counted) {
    const existing = totals.get(card.oracleId);
    if (existing) existing.quantity += card.quantity;
    else totals.set(card.oracleId, { card, quantity: card.quantity });
  }

  for (const { card, quantity } of totals.values()) {
    if (rules.basicsExempt && card.isBasicLand) continue;
    // A restricted card is capped at 1 regardless of the format's usual limit.
    const limit = card.legality === 'restricted' ? 1 : rules.maxCopies;
    if (quantity <= limit) continue;

    if (card.legality === 'restricted') {
      issues.push({
        severity: 'error',
        code: 'restricted',
        message: `${card.name} is restricted in ${rules.displayName} — only 1 copy allowed, this deck has ${quantity}.`,
        oracleId: card.oracleId,
        cardName: card.name,
      });
    } else if (rules.isSingleton) {
      issues.push({
        severity: 'error',
        code: 'singleton',
        message: `${rules.displayName} is singleton — only 1 copy of ${card.name} allowed, this deck has ${quantity}.`,
        oracleId: card.oracleId,
        cardName: card.name,
      });
    } else {
      issues.push({
        severity: 'error',
        code: 'copy_limit',
        message: `Only ${limit} copies of ${card.name} allowed in ${rules.displayName}, this deck has ${quantity}.`,
        oracleId: card.oracleId,
        cardName: card.name,
      });
    }
  }
}

function checkLegality(issues: DeckIssue[], rules: FormatRules, cards: DeckCard[]): void {
  const seen = new Set<string>();
  for (const card of cards) {
    if (card.board === 'maybe' || seen.has(card.oracleId)) continue;
    seen.add(card.oracleId);

    if (card.legality === 'banned') {
      issues.push({
        severity: 'error',
        code: 'banned',
        message: `${card.name} is banned in ${rules.displayName}.`,
        oracleId: card.oracleId,
        cardName: card.name,
      });
    } else if (card.legality === 'not_legal') {
      issues.push({
        severity: 'error',
        code: 'not_legal',
        message: `${card.name} is not legal in ${rules.displayName}.`,
        oracleId: card.oracleId,
        cardName: card.name,
      });
    }
  }
}

/**
 * Commander presence only. The colour-identity restriction, the separate
 * Commander ban list and Partner/Background pairing are Phase 3.
 */
function checkCommander(
  issues: DeckIssue[],
  rules: FormatRules,
  command: DeckCard[],
  commandCount: number,
): void {
  if (!rules.requiresCommander) {
    if (commandCount > 0) {
      issues.push({
        severity: 'warning',
        code: 'too_many_commanders',
        message: `${rules.displayName} has no command zone, but this deck has ${commandCount} card${commandCount === 1 ? '' : 's'} in one.`,
      });
    }
    return;
  }

  if (commandCount === 0) {
    issues.push({
      severity: 'error',
      code: 'missing_commander',
      message: `${rules.displayName} decks need a commander. Choose one from the deck list.`,
    });
    return;
  }

  // Two are allowed only via Partner or a Background, which Phase 3 verifies;
  // here anything past two is unambiguously wrong.
  if (commandCount > 2) {
    issues.push({
      severity: 'error',
      code: 'too_many_commanders',
      message: `A ${rules.displayName} deck can have at most two commanders, and only with Partner or a Background. This deck has ${commandCount}.`,
    });
  }

  for (const card of command) {
    if (!card.canBeCommander) {
      issues.push({
        severity: 'error',
        code: 'missing_commander',
        message: `${card.name} cannot be a commander — it is not a legendary creature, Vehicle or Spacecraft, and its text does not say it can be.`,
        oracleId: card.oracleId,
        cardName: card.name,
      });
    }
  }
}

/**
 * Warns when other decks already claim copies this one wants.
 *
 * CLAUDE.md is explicit that this must flag rather than block: you may be
 * planning decks you never intend to assemble at the same time.
 */
function checkAllocation(issues: DeckIssue[], cards: DeckCard[]): void {
  for (const card of cards) {
    if (card.board === 'maybe' || card.quantityFromCollection === 0) continue;
    if (card.quantityFromCollection > card.availableQuantity) {
      const short = card.quantityFromCollection - card.availableQuantity;
      issues.push({
        severity: 'warning',
        code: 'over_allocated',
        message: `${card.name}: this deck claims ${card.quantityFromCollection} from your collection but only ${card.availableQuantity} ${card.availableQuantity === 1 ? 'is' : 'are'} free — ${short} short. Other decks are using the rest.`,
        oracleId: card.oracleId,
        cardName: card.name,
      });
    }
  }
}

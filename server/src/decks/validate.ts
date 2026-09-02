import { colorsFromMask, normalizeName } from '../model/mtg.ts';
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
      formatCode: null, formatName: null, commanderIdentity: null,
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
  const commanderIdentity = checkColorIdentity(issues, rules, cards, command);
  checkAllocation(issues, cards);

  return {
    formatCode: rules.code,
    formatName: rules.displayName,
    commanderIdentity,
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
 * Whether a card may lead a deck in this format.
 *
 * "Commander" is not one rule. oracle_cards.can_be_commander answers only the
 * Commander-format question — legendary creature, Vehicle or Spacecraft, or
 * text that says it can be — and applying it everywhere rejected Oathbreaker's
 * planeswalkers, of which only 46 of 351 carry the flag.
 */
export function canLeadDeck(card: DeckCard, rules: FormatRules): boolean {
  const isPlaneswalker = card.isLegendary && card.typeLine.includes('Planeswalker');

  switch (rules.commanderKind) {
    case 'planeswalker':
      return isPlaneswalker;
    case 'legendary_or_planeswalker':
      return card.canBeCommander || isPlaneswalker;
    case 'uncommon_creature':
      // Pauper Commander asks about the printing, not the card: an uncommon
      // creature leads, whatever else it has been printed at.
      return card.typeLine.includes('Creature') && card.hasUncommonPrinting;
    case 'legendary':
    default:
      return card.canBeCommander;
  }
}

/** What this format wants, for the message when a card cannot lead. */
const COMMANDER_KIND_TEXT: Record<FormatRules['commanderKind'], string> = {
  legendary: 'a legendary creature, Vehicle or Spacecraft, or a card whose text says it can be',
  planeswalker: 'a legendary planeswalker',
  legendary_or_planeswalker: 'a legendary creature or planeswalker',
  uncommon_creature: 'a creature printed at uncommon',
};

/**
 * Commander presence, eligibility and pairing. The colour-identity restriction
 * is checked separately in checkColorIdentity, and the Commander ban list needs
 * no special handling — checkLegality already reads per-format legality, and
 * Commander's list is simply a different set of rows.
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

  if (commandCount > 2) {
    issues.push({
      severity: 'error',
      code: 'too_many_commanders',
      message: `A ${rules.displayName} deck can have at most two commanders, and only with Partner or a Background. This deck has ${commandCount}.`,
    });
  } else if (command.length === 2 && !pairingIsLegal(command[0], command[1])) {
    issues.push({
      severity: 'error',
      code: 'invalid_pairing',
      message: `${command[0].name} and ${command[1].name} cannot be commanders together. Two commanders need Partner, matching "Partner with" names, Friends forever, or a Background and a card that chooses one.`,
    });
  }

  for (const card of command) {
    if (!canLeadDeck(card, rules)) {
      issues.push({
        severity: 'error',
        code: 'missing_commander',
        message: `${card.name} cannot lead a ${rules.displayName} deck — it needs ${COMMANDER_KIND_TEXT[rules.commanderKind]}.`,
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

/**
 * Rule 903.4 — a card may only be in the deck if its colour identity fits
 * inside the commander's.
 *
 * Identity is not the same as colour: Kenrith is a mono-white card with a
 * WUBRG identity, because activated abilities in his rules text use every
 * colour. Scryfall's `color_identity` already folds in rules text and the back
 * face of a double-faced card, so it is used as-is rather than re-derived.
 *
 * Returns the permitted identity for display, or null when the rule does not
 * apply to this deck.
 */
function checkColorIdentity(
  issues: DeckIssue[],
  rules: FormatRules,
  cards: DeckCard[],
  command: DeckCard[],
): string | null {
  if (!rules.enforcesColorIdentity || command.length === 0) return null;

  const allowed = command.reduce((mask, card) => mask | card.colorIdentityMask, 0);
  const allowedText = colorsFromMask(allowed).join('') || 'colourless';

  for (const card of cards) {
    // The commanders define the identity, and the maybeboard is a scratch pad.
    if (card.board === 'command' || card.board === 'maybe') continue;
    const outside = card.colorIdentityMask & ~allowed;
    if (outside === 0) continue;

    issues.push({
      severity: 'error',
      code: 'color_identity',
      message: `${card.name} is outside your commander's colour identity — it needs ${colorsFromMask(outside).join('')}, and this deck allows ${allowedText}.`,
      oracleId: card.oracleId,
      cardName: card.name,
    });
  }

  return colorsFromMask(allowed).join('');
}

/**
 * Whether two cards may legally share a command zone.
 *
 * The four mechanics do not interchange: two plain Partner cards pair with each
 * other, but "Partner with [name]" pairs only with the card it names.
 */
export function pairingIsLegal(a: DeckCard, b: DeckCard): boolean {
  const kinds = [a.partnerKind, b.partnerKind];

  if (kinds[0] === 'partner' && kinds[1] === 'partner') return true;
  if (kinds[0] === 'friends_forever' && kinds[1] === 'friends_forever') return true;

  // Named partners must name each other; matching one direction is enough,
  // since Scryfall prints the clause on both halves of a real pair.
  const namesEachOther = (left: DeckCard, right: DeckCard) =>
    left.partnerKind === 'partner_with' &&
    left.partnerWith !== null &&
    normalizeName(left.partnerWith) === normalizeName(right.name);
  if (namesEachOther(a, b) || namesEachOther(b, a)) return true;

  const backgroundPair = (left: DeckCard, right: DeckCard) =>
    left.partnerKind === 'choose_background' && right.partnerKind === 'background';
  if (backgroundPair(a, b) || backgroundPair(b, a)) return true;

  const doctorPair = (left: DeckCard, right: DeckCard) =>
    left.partnerKind === 'doctors_companion' && right.typeLine.includes('Time Lord Doctor');
  if (doctorPair(a, b) || doctorPair(b, a)) return true;

  return false;
}

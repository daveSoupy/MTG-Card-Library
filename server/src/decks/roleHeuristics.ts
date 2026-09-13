import { CATEGORY_ROOTS } from '../sync/categories.ts';

/**
 * Phase 27's stand-in for `card_categories` when the tag sync has never run.
 *
 * Scryfall's `oracle_tags` bulk file is the real source of a card's role, and
 * `sync/categories.ts` loads it. This file exists for the database where that
 * has not happened — a fresh install before the first sync, or a tag fetch
 * that has been failing — so that the substitute finder can still say
 * "removal" about a card rather than only "instant, two mana". It is coarse
 * and it says so: every category it produces is labelled `heuristic`, and the
 * UI renders the reason as "role (heuristic)".
 *
 * The patterns are data, not code, so a bad guess is a one-line fix. They are
 * matched against `oracle_text_all` (every face), case-insensitively. The
 * category keys are the same ones the tagger produces, so a card matched here
 * and a card matched there compare equal downstream.
 *
 * Never consulted while `card_categories` has rows — mixing a curated source
 * with a regex over the same card would make the reason line lie about which
 * one spoke.
 *
 * How coarse, measured against the Tagger data over the 8,000 most-played
 * cards when this was written (2026-09): precision 91–100% for every role,
 * recall 21% (protection) to 87% (draw), ~50% for removal and tutor. That is
 * the shape a stand-in should have — it rarely calls a card something it is
 * not; it mostly just fails to notice. Tighten a pattern before loosening one.
 */

export interface RolePattern {
  /** One of `CATEGORY_ROOTS`' keys. */
  category: string;
  patterns: RegExp[];
  /** Skip this rule for lands: "add {G}" on a land is a mana source, not ramp. */
  notOnLands?: boolean;
}

/**
 * Ordered only for readability; every rule is evaluated and a card can carry
 * several roles, exactly as a tagger-sourced card can.
 */
export const ROLE_PATTERNS: RolePattern[] = [
  {
    category: 'removal',
    patterns: [
      /\b(destroy|exile) target (non\w+ |tapped |untapped |attacking |blocking |attacking or blocking )?(creature|artifact|enchantment|planeswalker|permanent|creature or planeswalker|artifact or enchantment|land)\b/i,
      /\bdeals? (\d+|x) damage to (any target|target creature|target creature or planeswalker|target creature or player|target attacking or blocking creature)\b/i,
      /\btarget creature gets -\d+\/-\d+ until end of turn\b/i,
      /\btarget creature'?s owner (puts|shuffles) it\b/i,
      /\btarget creature'?s controller sacrifices\b/i,
      /\bexile target (nonland )?permanent\b/i,
      /\b(each|target) (player|opponent) sacrifices an? (creature|permanent|nonland permanent)\b/i,
      /\bfights? (another |up to one other |another target |target )?(target )?creature\b/i,
      /\btarget creature gets -x\/-x\b/i,
      /\bdeals damage equal to [a-z' ]+ to (any target|target creature|that creature)\b/i,
      /\b(destroy|exile) (up to (one|two|three) target|another target|any number of target) (creature|artifact|enchantment|permanent|nonland permanent)s?\b/i,
    ],
  },
  {
    category: 'sweeper',
    patterns: [
      /\b(destroy|exile) all (creatures|nonland permanents|artifacts|enchantments|permanents|other creatures|artifacts and enchantments)\b/i,
      /\bdeals? (\d+|x) damage to each (creature|creature and each (player|planeswalker))\b/i,
      /\b(all|each) creatures? gets? -\d+\/-\d+ until end of turn\b/i,
      /\beach player sacrifices all creatures\b/i,
    ],
  },
  {
    category: 'draw',
    patterns: [
      /\bdraw (a|two|three|four|five|x|\d+) cards?\b/i,
      /\bdraws? that many cards\b/i,
    ],
  },
  {
    category: 'ramp',
    notOnLands: true,
    patterns: [
      /\bsearch your library for (a|an|up to (one|two|three|\d+)) (basic )?lands?( cards?)?\b/i,
      /\badd \{[wubrgc]\}/i,
      /\badd (one|two|three|\d+) mana\b/i,
      /\badd (\{[wubrgc]\}|\{[wubrgc]\}\{[wubrgc]\})+\b/i,
      /\bput (a|that|the|those) (basic )?lands? cards? (from your hand )?onto the battlefield\b/i,
      /\byou may play an additional land\b/i,
    ],
  },
  {
    category: 'counterspell',
    patterns: [
      // Not "counter it unless": that is Ward's reminder text, and a creature
      // with ward is protection, not a counterspell.
      /\bcounter target (spell|noncreature spell|creature spell|instant or sorcery spell|activated or triggered ability|activated ability|triggered ability|artifact spell|enchantment spell)\b/i,
    ],
  },
  {
    category: 'tutor',
    patterns: [
      // Anything you tutor for that is not a land — land searches are ramp,
      // above, and a card that finds both is honestly both.
      /\bsearch your library for (a|an|any|up to (one|two|three|\d+)) (?!(basic |nonbasic |snow )?lands?\b)([a-z]+ )*cards?\b/i,
    ],
  },
  {
    category: 'recursion',
    patterns: [
      /\breturn (target|up to (one|two|three|\d+) target|all|each|any number of target) [a-z ,]*cards? from your graveyard to (your hand|the battlefield)\b/i,
      /\bput (target|up to \w+ target) [a-z ]*cards? from your graveyard on(to)? (top of your library|the battlefield)\b/i,
      /\bfrom your graveyard to the battlefield\b/i,
    ],
  },
  {
    category: 'protection',
    patterns: [
      /\b(target|creatures you control|permanents you control|other creatures you control|another target) [a-z ]*gains? (hexproof|indestructible|protection|shroud)\b/i,
      /\byou (have|gain) hexproof\b/i,
      /\bcounter target spell that targets\b/i,
      /\bprevent all damage that would be dealt (this turn )?to (you|creatures you control|target creature)\b/i,
      /\bcan't be the targets? of spells or abilities your opponents control\b/i,
    ],
  },
];

/** Whether any face is a land — for `notOnLands`. A modal DFC whose back is a
 *  land adds mana on that face, which is no more ramp than a Forest is. */
const isLand = (typeLine: string | null): boolean =>
  (typeLine ?? '').split(' // ').some((face) => /\bLand\b/.test(face) && !/\bCreature\b/.test(face));

/**
 * Roles a card's rules text suggests. Empty for a card that matches nothing —
 * most creatures, for one — which is the honest answer, not a defect.
 */
export function heuristicRoles(oracleText: string | null, typeLine: string | null): string[] {
  const text = oracleText ?? '';
  if (text.length === 0) return [];
  const land = isLand(typeLine);
  const roles: string[] = [];
  for (const rule of ROLE_PATTERNS) {
    if (rule.notOnLands && land) continue;
    if (!(rule.category in CATEGORY_ROOTS)) continue;
    if (rule.patterns.some((pattern) => pattern.test(text))) roles.push(rule.category);
  }
  return roles;
}

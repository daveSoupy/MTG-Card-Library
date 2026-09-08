import type { DeckCard } from './api.ts';

/**
 * Ordering and grouping for card lists.
 *
 * This is presentation rather than a rule — a phone might reasonably group
 * differently from a desktop — so it lives in the client. It is kept as a pure
 * module with no React in it so the ordering, which is easy to get subtly
 * wrong, can be tested directly.
 *
 * Phase 10 widened it: the universal groupings (type, subtype, rarity, colour,
 * colour identity, mana value, set) work against anything card-shaped, so
 * Browse, the collection and the deck-builder picker share them through
 * `groupByField`. The deck-only groupings — category, and the template
 * priority order — stay behind `groupCards`, which is the only caller with a
 * `deck_cards` row to key off.
 */

export type DeckSort =
  | 'type' | 'type-alpha' | 'mana' | 'color' | 'name' | 'price' | 'rarity'
  | 'category' | 'template';
export type DeckViewMode = 'list' | 'cards';

export const DECK_SORTS: Array<{ value: DeckSort; label: string }> = [
  { value: 'type', label: 'Card type' },
  { value: 'type-alpha', label: 'Card type (A–Z)' },
  { value: 'mana', label: 'Mana value' },
  { value: 'color', label: 'Colour' },
  { value: 'name', label: 'Name' },
  { value: 'price', label: 'Price' },
  { value: 'rarity', label: 'Rarity' },
  { value: 'category', label: 'Category' },
  { value: 'template', label: 'Template' },
];

/** Mirrors the server's sync/categories.ts CATEGORY_LABELS for display only. */
const TAG_CATEGORY_LABEL: Record<string, string> = {
  removal: 'Removal',
  draw: 'Card draw',
  ramp: 'Ramp',
  recursion: 'Recursion',
  protection: 'Protection',
  tutor: 'Tutor',
  sweeper: 'Board wipes',
  counterspell: 'Counterspell',
};

/**
 * The shape every grouping here needs.
 *
 * Narrower than `DeckCard` on purpose — it is the intersection a browse result,
 * a collection lot and a deck slot already share, so one grouping implementation
 * covers all three. The optional fields are the ones some sources do not carry:
 * a collection row has no rarity or `colors`, and a deck slot has no set name.
 */
export interface GroupableCard {
  name: string;
  typeLine: string;
  cmc: number;
  colorIdentity: string;
  colors?: string;
  rarity?: string | null;
  setCode?: string | null;
  setName?: string | null;
  priceUsd?: number | null;
  /** Copies this row stands for. Absent means one, which is what a browse hit is. */
  quantity?: number;
  category?: string | null;
  categories?: string[];
}

export interface CardGroup<T extends GroupableCard = DeckCard> {
  key: string;
  label: string;
  /** Total copies, not distinct cards — what a decklist header shows. */
  count: number;
  cards: T[];
}

/** Decklist order: what a printed list leads with. */
const TYPE_ORDER = [
  'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery',
  'Artifact', 'Enchantment', 'Land',
] as const;

const RARITY_ORDER = ['mythic', 'rare', 'uncommon', 'common', 'special', 'bonus'] as const;
const RARITY_LABEL: Record<string, string> = {
  mythic: 'Mythic', rare: 'Rare', uncommon: 'Uncommon',
  common: 'Common', special: 'Special', bonus: 'Bonus',
};

export const COLOR_LABEL: Record<string, string> = {
  W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green',
};
export const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];

/** Mana values above this share a bucket; nobody sorts 9-drops apart from 8s. */
const MAX_MANA_BUCKET = 7;

/** The seven ways a colour string reads as one bucket — also what the deck
 *  list's colour tint keys off, so the two can never disagree. */
export type IdentityKey = 'W' | 'U' | 'B' | 'R' | 'G' | 'M' | 'C';

export function identityKey(colors: string | null | undefined): IdentityKey {
  const identity = colors ?? '';
  if (identity.length === 0) return 'C';
  if (identity.length > 1) return 'M';
  return (COLOR_ORDER.includes(identity) ? identity : 'C') as IdentityKey;
}

function typeOf(card: GroupableCard): string {
  // First match wins so an Artifact Creature files under Creature, which is
  // how a decklist is normally read.
  return TYPE_ORDER.find((type) => card.typeLine.includes(type)) ?? 'Other';
}

/**
 * The first subtype off a type line — "Creature — Human Wizard" is a Human.
 *
 * One bucket per card rather than one per subtype: a card belonging to three
 * groups at once would make every group count meaningless. The leading subtype
 * is the useful one anyway (the race, the land type, the equipment).
 */
function subtypeOf(card: GroupableCard): string {
  const [, subtypes] = card.typeLine.split(/[—–-]/, 2);
  const first = subtypes?.trim().split(/\s+/)[0];
  return first || '';
}

const byName = (a: GroupableCard, b: GroupableCard) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// ------------------------------------------------------- universal groupings

/** The groupings that need nothing but a card-shaped object. */
export type GroupBy =
  | 'none' | 'type' | 'subtype' | 'rarity' | 'color' | 'colorIdentity' | 'mana' | 'set';

export const GROUP_BY_LABEL: Record<GroupBy, string> = {
  none: 'Nothing',
  type: 'Card type',
  subtype: 'Subtype',
  rarity: 'Rarity',
  color: 'Colour',
  colorIdentity: 'Colour identity',
  mana: 'Mana value',
  set: 'Set',
};

interface Bucket { key: string; label: string; rank: number }

/** Which single bucket a card falls into. Rank orders the buckets; ties fall
 *  back to the label, so a set or subtype grouping comes out alphabetical. */
function bucketFor(card: GroupableCard, by: GroupBy): Bucket {
  switch (by) {
    case 'type': {
      const type = typeOf(card);
      const rank = TYPE_ORDER.indexOf(type as (typeof TYPE_ORDER)[number]);
      return { key: type, label: type, rank: rank === -1 ? TYPE_ORDER.length : rank };
    }
    case 'subtype': {
      const subtype = subtypeOf(card);
      // Instants, sorceries and plain artifacts have no subtype at all; they
      // collect at the end rather than under a blank heading.
      return subtype
        ? { key: subtype, label: subtype, rank: 0 }
        : { key: '~none', label: 'No subtype', rank: 1 };
    }
    case 'rarity': {
      const rarity = card.rarity ?? '';
      if (!rarity) return { key: '~none', label: 'Unknown rarity', rank: RARITY_ORDER.length + 1 };
      const rank = RARITY_ORDER.indexOf(rarity as (typeof RARITY_ORDER)[number]);
      return {
        key: rarity,
        label: RARITY_LABEL[rarity] ?? rarity,
        rank: rank === -1 ? RARITY_ORDER.length : rank,
      };
    }
    case 'color':
    case 'colorIdentity': {
      // A collection row carries only its colour identity, so "Colour" falls
      // back to it rather than filing every card as colourless.
      const source = by === 'color' ? (card.colors ?? card.colorIdentity) : card.colorIdentity;
      const key = identityKey(source);
      if (key === 'C') return { key: 'C', label: 'Colourless', rank: COLOR_ORDER.length + 1 };
      // Every gold card together, after the mono-colour groups — splitting
      // them per pair would scatter a two-colour deck across six headings.
      if (key === 'M') return { key: 'M', label: 'Multicolour', rank: COLOR_ORDER.length };
      return { key, label: COLOR_LABEL[key], rank: COLOR_ORDER.indexOf(key) };
    }
    case 'mana': {
      const bucket = Math.min(Math.floor(card.cmc), MAX_MANA_BUCKET);
      const label = bucket === MAX_MANA_BUCKET ? `${MAX_MANA_BUCKET}+ mana` : `${bucket} mana`;
      return { key: String(bucket), label, rank: bucket };
    }
    case 'set': {
      const code = card.setCode ?? '';
      if (!code) return { key: '~none', label: 'No set', rank: 1 };
      return { key: code, label: card.setName ?? code.toUpperCase(), rank: 0 };
    }
    // Name and price read as one continuous run; splitting them into headings
    // would hide exactly the ordering the sort exists to show.
    case 'none':
    default:
      return { key: 'all', label: 'All cards', rank: 0 };
  }
}

const copiesOf = (card: GroupableCard) => card.quantity ?? 1;

/** Assembles buckets into display order. `within` may reorder a group's cards;
 *  omitting it leaves them in the order they arrived. */
function assemble<T extends GroupableCard>(
  cards: T[],
  bucketOf: (card: T) => Bucket,
  countOf: (card: T) => number,
  within?: (a: T, b: T) => number,
): Array<CardGroup<T>> {
  const buckets = new Map<string, { label: string; rank: number; cards: T[] }>();

  for (const card of cards) {
    const bucket = bucketOf(card);
    const existing = buckets.get(bucket.key)
      ?? { label: bucket.label, rank: bucket.rank, cards: [] };
    existing.cards.push(card);
    buckets.set(bucket.key, existing);
  }

  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      count: bucket.cards.reduce((total, card) => total + countOf(card), 0),
      cards: within ? bucket.cards.sort(within) : bucket.cards,
    }))
    .sort((a, b) => {
      const rankA = buckets.get(a.key)!.rank;
      const rankB = buckets.get(b.key)!.rank;
      return rankA - rankB || a.label.localeCompare(b.label);
    });
}

/**
 * Groups any card-shaped list by one of the universal groupings.
 *
 * Order *within* a group is left exactly as it arrived: Browse, the collection
 * and the picker all sort server-side, and re-sorting here would quietly
 * override the sort the user picked in the same panel.
 */
export function groupByField<T extends GroupableCard>(
  cards: T[],
  by: GroupBy,
  countOf: (card: T) => number = copiesOf,
): Array<CardGroup<T>> {
  return assemble(cards, (card) => bucketFor(card, by), countOf);
}

// -------------------------------------------------------- decklist grouping

/** Which universal grouping a decklist sort reduces to, where one exists. */
const SORT_GROUPING: Partial<Record<DeckSort, GroupBy>> = {
  type: 'type',
  'type-alpha': 'type',
  mana: 'mana',
  color: 'colorIdentity',
  rarity: 'rarity',
  name: 'none',
  price: 'none',
};

/** Groups a deck's cards for display. Returns groups in their display order. */
export function groupCards(cards: DeckCard[], sort: DeckSort): CardGroup[] {
  const deckBucket = (card: DeckCard): Bucket => {
    switch (sort) {
      case 'category': {
        // Uncategorised cards collect at the end rather than under a blank
        // heading, so the grouping stays readable while a deck is part-tagged.
        const category = card.category?.trim();
        return category
          ? { key: category, label: category, rank: 0 }
          : { key: '~uncategorised', label: 'Uncategorised', rank: 1 };
      }
      case 'template': {
        // Presentation grouping only — a card can match several template
        // categories at once (see the stats panel's Template section, which
        // counts every match), but a decklist heading needs exactly one
        // bucket per card. Priority: a manual category always wins; failing
        // that, the alphabetically-first tag category; failing that, the
        // land/creature split; failing that, Uncategorised.
        const manual = card.category?.trim();
        if (manual) return { key: manual.toLowerCase(), label: manual, rank: 0 };
        const tagCategory = [...card.categories].sort()[0];
        if (tagCategory) {
          return { key: tagCategory, label: TAG_CATEGORY_LABEL[tagCategory] ?? tagCategory, rank: 1 };
        }
        const type = card.typeLine.toLowerCase();
        if (type.includes('land')) return { key: 'lands', label: 'Lands', rank: 2 };
        if (type.includes('creature')) return { key: 'creatures', label: 'Creatures', rank: 3 };
        return { key: 'zzz-uncategorised', label: 'Uncategorised', rank: 4 };
      }
      default:
        return bucketFor(card, SORT_GROUPING[sort] ?? 'none');
    }
  };

  const withinGroup = (a: DeckCard, b: DeckCard): number => {
    switch (sort) {
      case 'price': {
        // Unpriced cards sort last rather than as free.
        const left = a.priceUsd ?? -1;
        const right = b.priceUsd ?? -1;
        return right - left || byName(a, b);
      }
      // Within type and colour groups, cheaper cards first is what a
      // curve-ordered decklist looks like — except under type-alpha, which
      // exists precisely to read the same groups alphabetically instead.
      case 'type':
      case 'color':
      case 'rarity':
      case 'category':
      case 'template':
        return a.cmc - b.cmc || byName(a, b);
      default:
        return byName(a, b);
    }
  };

  return assemble(cards, deckBucket, copiesOf, withinGroup);
}
// -- persisted view preference ------------------------------------------------

const VIEW_KEY = 'mtg.deckView';
const SORT_KEY = 'mtg.deckSort';

/**
 * View preferences live in the browser rather than the database on purpose:
 * card view suits a desktop and list view suits a phone, so this is genuinely
 * per-device rather than per-user.
 */
export function loadViewPreference(): { view: DeckViewMode; sort: DeckSort } {
  const fallback = { view: 'list' as DeckViewMode, sort: 'type' as DeckSort };
  try {
    const view = localStorage.getItem(VIEW_KEY);
    const sort = localStorage.getItem(SORT_KEY);
    return {
      view: view === 'cards' || view === 'list' ? view : fallback.view,
      sort: DECK_SORTS.some((s) => s.value === sort) ? (sort as DeckSort) : fallback.sort,
    };
  } catch {
    // Private browsing, or storage disabled — the defaults are fine.
    return fallback;
  }
}

export function saveViewPreference(view: DeckViewMode, sort: DeckSort): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
    localStorage.setItem(SORT_KEY, sort);
  } catch {
    // Not being able to remember the preference is not worth surfacing.
  }
}

// -------------------------------------------------------- pane widths

/**
 * Widths of the deck builder's two right-hand panes, in pixels.
 *
 * Per device rather than per deck — this is a property of the screen you are
 * sitting at, so it lives in localStorage next to the view preference and
 * never goes to the server. Mobile has no equivalent: below 860px the picker
 * is an overlay, not a column.
 */
export const PANE_MIN = 220;
export const PANE_MAX = 640;
export const DEFAULT_PANE_WIDTHS = { picker: 300, stats: 300 };

const PANE_KEY: Record<keyof typeof DEFAULT_PANE_WIDTHS, string> = {
  picker: 'mtg.deck.pickerWidth',
  stats: 'mtg.deck.statsWidth',
};

export type PaneWidths = typeof DEFAULT_PANE_WIDTHS;

function readWidth(pane: keyof PaneWidths): number {
  const stored = Number(localStorage.getItem(PANE_KEY[pane]));
  if (!Number.isFinite(stored) || stored <= 0) return DEFAULT_PANE_WIDTHS[pane];
  return Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(stored)));
}

export function loadPaneWidths(): PaneWidths {
  try {
    return { picker: readWidth('picker'), stats: readWidth('stats') };
  } catch {
    return { ...DEFAULT_PANE_WIDTHS };
  }
}

export function savePaneWidth(pane: keyof PaneWidths, width: number): void {
  try {
    localStorage.setItem(PANE_KEY[pane], String(Math.round(width)));
  } catch {
    // Same as the view preference: not worth surfacing.
  }
}

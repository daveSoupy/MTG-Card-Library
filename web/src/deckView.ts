import type { DeckCard } from './api.ts';

/**
 * Ordering and grouping for a decklist.
 *
 * This is presentation rather than a rule — a phone might reasonably group
 * differently from a desktop — so it lives in the client. It is kept as a pure
 * module with no React in it so the ordering, which is easy to get subtly
 * wrong, can be tested directly.
 */

export type DeckSort = 'type' | 'mana' | 'color' | 'name' | 'price' | 'rarity' | 'category' | 'template';
export type DeckViewMode = 'list' | 'cards';

export const DECK_SORTS: Array<{ value: DeckSort; label: string }> = [
  { value: 'type', label: 'Card type' },
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

export interface CardGroup {
  key: string;
  label: string;
  /** Total copies, not distinct cards — what a decklist header shows. */
  count: number;
  cards: DeckCard[];
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

const COLOR_LABEL: Record<string, string> = {
  W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green',
};
const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];

/** Mana values above this share a bucket; nobody sorts 9-drops apart from 8s. */
const MAX_MANA_BUCKET = 7;

function typeOf(card: DeckCard): string {
  // First match wins so an Artifact Creature files under Creature, which is
  // how a decklist is normally read.
  return TYPE_ORDER.find((type) => card.typeLine.includes(type)) ?? 'Other';
}

const byName = (a: DeckCard, b: DeckCard) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Groups a deck's cards for display. Returns groups in their display order. */
export function groupCards(cards: DeckCard[], sort: DeckSort): CardGroup[] {
  const buckets = new Map<string, { label: string; rank: number; cards: DeckCard[] }>();

  const put = (key: string, label: string, rank: number, card: DeckCard) => {
    const bucket = buckets.get(key) ?? { label, rank, cards: [] };
    bucket.cards.push(card);
    buckets.set(key, bucket);
  };

  for (const card of cards) {
    switch (sort) {
      case 'type': {
        const type = typeOf(card);
        const rank = TYPE_ORDER.indexOf(type as (typeof TYPE_ORDER)[number]);
        put(type, type, rank === -1 ? TYPE_ORDER.length : rank, card);
        break;
      }
      case 'mana': {
        const bucket = Math.min(Math.floor(card.cmc), MAX_MANA_BUCKET);
        const label = bucket === MAX_MANA_BUCKET ? `${MAX_MANA_BUCKET}+ mana` : `${bucket} mana`;
        put(String(bucket), label, bucket, card);
        break;
      }
      case 'color': {
        const identity = card.colorIdentity ?? '';
        if (identity.length === 0) {
          put('C', 'Colourless', COLOR_ORDER.length + 1, card);
        } else if (identity.length > 1) {
          // Every gold card together, after the mono-colour groups — splitting
          // them per pair would scatter a two-colour deck across six headings.
          put('M', 'Multicolour', COLOR_ORDER.length, card);
        } else {
          put(identity, COLOR_LABEL[identity] ?? identity, COLOR_ORDER.indexOf(identity), card);
        }
        break;
      }
      case 'category': {
        // Uncategorised cards collect at the end rather than under a blank
        // heading, so the grouping stays readable while a deck is part-tagged.
        const category = card.category?.trim();
        put(category || '\u0000uncategorised', category || 'Uncategorised',
            category ? 0 : 1, card);
        break;
      }
      case 'rarity': {
        const rarity = card.rarity ?? 'common';
        const rank = RARITY_ORDER.indexOf(rarity as (typeof RARITY_ORDER)[number]);
        put(rarity, RARITY_LABEL[rarity] ?? rarity, rank === -1 ? RARITY_ORDER.length : rank, card);
        break;
      }
      case 'template': {
        // Presentation grouping only — a card can match several template
        // categories at once (see the stats panel's Template section, which
        // counts every match), but a decklist heading needs exactly one
        // bucket per card. Priority: a manual category always wins; failing
        // that, the alphabetically-first tag category; failing that, the
        // land/creature split; failing that, Uncategorised.
        const manual = card.category?.trim();
        if (manual) {
          put(manual.toLowerCase(), manual, 0, card);
          break;
        }
        const tagCategory = [...card.categories].sort()[0];
        if (tagCategory) {
          put(tagCategory, TAG_CATEGORY_LABEL[tagCategory] ?? tagCategory, 1, card);
          break;
        }
        const type = card.typeLine.toLowerCase();
        if (type.includes('land')) { put('lands', 'Lands', 2, card); break; }
        if (type.includes('creature')) { put('creatures', 'Creatures', 3, card); break; }
        put('zzz-uncategorised', 'Uncategorised', 4, card);
        break;
      }
      // Name and price read as one continuous run; splitting them into headings
      // would hide exactly the ordering the sort exists to show.
      case 'name':
      case 'price':
      default:
        put('all', 'All cards', 0, card);
        break;
    }
  }

  const withinGroup = (a: DeckCard, b: DeckCard): number => {
    switch (sort) {
      case 'mana':
      case 'name':
      case 'type':
      case 'color':
      case 'rarity':
      case 'category':
        return byName(a, b);
      case 'price': {
        // Unpriced cards sort last rather than as free.
        const left = a.priceUsd ?? -1;
        const right = b.priceUsd ?? -1;
        return right - left || byName(a, b);
      }
      default:
        return byName(a, b);
    }
  };

  // Within type and colour groups, cheaper cards first is what a curve-ordered
  // decklist looks like.
  const curveThenName = (a: DeckCard, b: DeckCard) => a.cmc - b.cmc || byName(a, b);

  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      count: bucket.cards.reduce((total, card) => total + card.quantity, 0),
      cards: bucket.cards.sort(
        sort === 'type' || sort === 'color' || sort === 'rarity' || sort === 'category' || sort === 'template'
          ? curveThenName : withinGroup,
      ),
    }))
    .sort((a, b) => {
      const rankA = buckets.get(a.key)!.rank;
      const rankB = buckets.get(b.key)!.rank;
      return rankA - rankB || a.label.localeCompare(b.label);
    });
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

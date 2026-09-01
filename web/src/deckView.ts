import type { DeckCard } from './api.ts';

/**
 * Ordering and grouping for a decklist.
 *
 * This is presentation rather than a rule — a phone might reasonably group
 * differently from a desktop — so it lives in the client. It is kept as a pure
 * module with no React in it so the ordering, which is easy to get subtly
 * wrong, can be tested directly.
 */

export type DeckSort = 'type' | 'mana' | 'color' | 'name' | 'price' | 'rarity';
export type DeckViewMode = 'list' | 'cards';

export const DECK_SORTS: Array<{ value: DeckSort; label: string }> = [
  { value: 'type', label: 'Card type' },
  { value: 'mana', label: 'Mana value' },
  { value: 'color', label: 'Colour' },
  { value: 'name', label: 'Name' },
  { value: 'price', label: 'Price' },
  { value: 'rarity', label: 'Rarity' },
];

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
      case 'rarity': {
        const rarity = card.rarity ?? 'common';
        const rank = RARITY_ORDER.indexOf(rarity as (typeof RARITY_ORDER)[number]);
        put(rarity, RARITY_LABEL[rarity] ?? rarity, rank === -1 ? RARITY_ORDER.length : rank, card);
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
        sort === 'type' || sort === 'color' || sort === 'rarity' ? curveThenName : withinGroup,
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

/**
 * Shared JSON-schema fragments for route validation.
 *
 * Fastify compiles a route's `schema.body` / `schema.params` with ajv and
 * rejects a mismatch as a 400 before the handler runs, so a store method never
 * sees a string where it expects a number. The global error handler turns that
 * rejection into `{ error: 'body/quantity must be integer' }`.
 *
 * Ajv runs with Fastify's default `coerceTypes: true`, which is what makes
 * `:id` — always a string on the wire — validate and arrive as a number. The
 * same leniency applies to bodies, so `"4"` is accepted as 4; `"four"` is not.
 *
 * Bodies deliberately do not set `additionalProperties: false`. Rejecting a
 * field a client sent in good faith is a worse failure than ignoring it.
 */

/** A database id: positive, integral, never zero. */
export const ID = { type: 'integer', minimum: 1 } as const;

/** An id that may also be cleared: a destination not yet chosen, say. */
export const ID_OR_NULL = { type: ['integer', 'null'], minimum: 1 } as const;

/**
 * A quantity of cards in a deck slot, a claim, a template ideal. Zero is
 * meaningful — it usually means "remove". The ceiling is well above any
 * format's deck size, so it only ever catches a typo or a hostile client; a
 * billion-copy slot is accepted by SQLite without complaint and then reported
 * as the deck's card count.
 */
export const COUNT = { type: 'integer', minimum: 0, maximum: 999 } as const;

/**
 * A quantity of cards in a collection lot. Higher than COUNT because a lot is
 * a purchase, not a slot: two thousand basics from a bulk buy is one row.
 */
export const LOT_COUNT = { type: 'integer', minimum: 0, maximum: 9999 } as const;

/** Dollars. Never negative; null where "unknown" differs from "nothing". */
export const MONEY = { type: 'number', minimum: 0 } as const;
export const MONEY_OR_NULL = { type: ['number', 'null'], minimum: 0 } as const;

/**
 * A name, tag or label the user typed. Blank is not a name, and neither is a
 * paragraph. Also carries Scryfall ids (36-character UUIDs), which fit easily.
 */
export const NAME = { type: 'string', minLength: 1, maxLength: 200 } as const;

export const TEXT = { type: 'string' } as const;
export const TEXT_OR_NULL = { type: ['string', 'null'] } as const;

/**
 * A deck slot's manual category list, comma-separated. The outer bound only —
 * the per-entry and per-count caps live in decks/categories.ts, which ajv
 * cannot express, and which normalise rather than reject.
 */
export const CATEGORY_LIST = { type: ['string', 'null'], maxLength: 200 } as const;
export const FLAG = { type: 'boolean' } as const;

/** 'YYYY-MM-DD', the form every date column in the schema stores. */
export const DATE_OR_NULL = {
  type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$',
} as const;

/** One value from a CHECK list, or null. */
export const enumOrNull = (values: readonly string[]) =>
  ({ type: ['string', 'null'], enum: [...values, null] }) as const;

/** `{ id }`, `{ id, cardId }` — the usual all-integer path parameters. */
export const idParams = (...names: string[]) => ({
  type: 'object',
  required: names,
  properties: Object.fromEntries(names.map((name) => [name, ID])),
  additionalProperties: false,
});

/** An object body. Anything not named in `required` is optional. */
export const body = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
});

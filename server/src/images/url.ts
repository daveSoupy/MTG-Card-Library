/**
 * Card image URLs, built rather than stored.
 *
 * `card_printings` and `card_faces` used to keep five Scryfall URLs each — 54MB
 * of this database, every byte derivable from the printing id and one
 * timestamp. They now keep `image_ts`, and this is the single place that knows
 * the shape Scryfall serves:
 *
 *   https://cards.scryfall.io/{size}/{side}/{id[0]}/{id[1]}/{id}.{jpg|png}?{ts}
 *
 * Verified against every row of the live library before the columns went: all
 * 113,490 printings and 8,164 faces that carry art match it, all five sizes of
 * a row share one timestamp, and a face carries art only when its printing does
 * not. `side` is `front` for a printing and for face 0, `back` for face 1.
 *
 * That URL shape is Scryfall's to change, which is what `image_url_override` is
 * for: a JSON object of size -> URL, written by the importer only for a row the
 * template does not fit, and preferred here when it is present. A changed shape
 * therefore costs the space back for the affected rows instead of serving
 * broken images.
 *
 * Two forms, one template. `imageUrl` is for code holding a row; `imageUrlSql`
 * is for the dozen queries that ship a URL straight to a client and would
 * otherwise each need their own copy of the string concatenation.
 */

import type { ImageSize } from './fetch.ts';

/** Scryfall serves png at .png and everything else at .jpg. */
const EXTENSION: Record<ImageSize, string> = {
  small: 'jpg',
  normal: 'jpg',
  large: 'jpg',
  art_crop: 'jpg',
  png: 'png',
};

export type ImageSide = 'front' | 'back';

/** The side a face's art is published under. Printings are always the front. */
export function sideForFace(faceIndex: number): ImageSide {
  return faceIndex === 0 ? 'front' : 'back';
}

/**
 * The URL for one image, or null when the row carries no art.
 *
 * `override` is the raw `image_url_override` column: JSON, or null.
 */
export function imageUrl(
  printingId: string,
  size: ImageSize,
  side: ImageSide,
  ts: number | null,
  override?: string | null,
): string | null {
  if (override) {
    try {
      const url = (JSON.parse(override) as Record<string, string | undefined>)[size];
      if (typeof url === 'string' && url.length > 0) return url;
    } catch {
      // A malformed override must not cost the caller its image; the derived
      // URL below is right for every row this codebase has ever seen.
    }
  }
  if (ts == null) return null;
  return `https://cards.scryfall.io/${size}/${side}/${printingId[0]}/${printingId[1]}/${printingId}.${EXTENSION[size]}?${ts}`;
}

/**
 * The same URL as a SQL expression, for a query that selects one.
 *
 * Every argument is an *expression*, not a value, so a caller can pass a
 * COALESCE across a printing and its face — which is what most of them do,
 * because a double-faced card's art hangs off the face rather than the card.
 * `side` defaults to the front, which is correct for a printing and for face 0.
 */
export function imageUrlSql(opts: {
  id: string;
  ts: string;
  override?: string;
  size: ImageSize;
  side?: string;
}): string {
  const { id, ts, override, size, side = `'front'` } = opts;
  const derived =
    `'https://cards.scryfall.io/${size}/' || ${side} || '/' || substr(${id},1,1) || '/' `
    + `|| substr(${id},2,1) || '/' || ${id} || '.${EXTENSION[size]}?' || ${ts}`;
  const withOverride = override
    ? `COALESCE(json_extract(${override}, '$.${size}'), ${derived})`
    : derived;
  return `CASE WHEN ${ts} IS NULL THEN NULL ELSE ${withOverride} END`;
}

/**
 * The shape almost every query needs: a printing's art, falling back to its
 * face-0 art, as one SQL expression.
 *
 * Double-faced cards carry no card-level art — the two are mutually exclusive
 * in every row — so this COALESCE is the whole rule. Face 0 is the front, which
 * is why no side expression is needed. `printing` and `face` are table aliases;
 * the face may be joined or, where a query has no room for another join, a
 * correlated subquery passed through `faceExpr`.
 */
export function artUrlSql(printing: string, face: string, size: ImageSize): string {
  return imageUrlSql({
    id: `${printing}.id`,
    ts: `COALESCE(${printing}.image_ts, ${face}.image_ts)`,
    override: `COALESCE(${printing}.image_url_override, ${face}.image_url_override)`,
    size,
  });
}

import type Database from 'better-sqlite3';
import type { SetRecord } from './scryfall.ts';
import { canonicalColors, colorMask, normalizeName, splitCollectorNumber } from '../model/mtg.ts';

/** better-sqlite3 binds only numbers, strings, bigints, buffers and null. */
const bit = (value: unknown): number => (value ? 1 : 0);
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Scryfall sends prices as decimal strings, or null. */
function price(prices: Record<string, unknown> | undefined, key: string): number | null {
  const raw = prices?.[key];
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return typeof raw === 'number' ? raw : null;
}

function jsonArray(value: unknown): string | null {
  return Array.isArray(value) && value.length > 0 ? JSON.stringify(value) : null;
}

function jsonObject(value: unknown): string | null {
  return value && typeof value === 'object' && Object.keys(value).length > 0
    ? JSON.stringify(value)
    : null;
}

/**
 * Scryfall puts `oracle_id` on the card for most layouts, but reversible cards
 * carry it on the individual faces instead.
 */
function oracleIdOf(card: any): string | null {
  if (typeof card.oracle_id === 'string') return card.oracle_id;
  for (const face of card.card_faces ?? []) {
    if (typeof face?.oracle_id === 'string') return face.oracle_id;
  }
  return null;
}

/**
 * Writes Scryfall card records into the local database.
 *
 * Statements are prepared once and reused for every record; with hundreds of
 * thousands of rows, re-preparing per card dominates the runtime. Callers wrap
 * batches in a transaction.
 */
export class CardImporter {
  private readonly insertOracle;
  private readonly insertPrinting;
  private readonly insertFace;
  private readonly insertLegality;
  private readonly insertVariant;
  private readonly insertSet;
  private readonly linkParentSet;

  /**
   * Oracle rows are identical across every printing, so with `default_cards`
   * the same row would otherwise be rewritten dozens of times.
   */
  private readonly seenOracleIds = new Set<string>();

  oracleCount = 0;
  printingCount = 0;
  skippedCount = 0;

  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertOracle = db.prepare(`
      INSERT INTO oracle_cards
        (oracle_id, name, name_normalized, layout, mana_cost, cmc, type_line,
         oracle_text, oracle_text_all, power, toughness, loyalty, defense,
         colors_mask, color_identity_mask, colors, color_identity, color_identity_count,
         keywords, produced_mana, is_reserved, is_basic_land, is_legendary,
         can_be_commander, can_be_partner, can_be_background, edhrec_rank,
         game_changer, scryfall_updated_at, synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
              strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      ON CONFLICT(oracle_id) DO UPDATE SET
        name=excluded.name, name_normalized=excluded.name_normalized,
        layout=excluded.layout, mana_cost=excluded.mana_cost, cmc=excluded.cmc,
        type_line=excluded.type_line, oracle_text=excluded.oracle_text,
        oracle_text_all=excluded.oracle_text_all, power=excluded.power,
        toughness=excluded.toughness, loyalty=excluded.loyalty, defense=excluded.defense,
        colors_mask=excluded.colors_mask, color_identity_mask=excluded.color_identity_mask,
        colors=excluded.colors, color_identity=excluded.color_identity,
        color_identity_count=excluded.color_identity_count, keywords=excluded.keywords,
        produced_mana=excluded.produced_mana, is_reserved=excluded.is_reserved,
        is_basic_land=excluded.is_basic_land, is_legendary=excluded.is_legendary,
        can_be_commander=excluded.can_be_commander, can_be_partner=excluded.can_be_partner,
        can_be_background=excluded.can_be_background, edhrec_rank=excluded.edhrec_rank,
        game_changer=excluded.game_changer, scryfall_updated_at=excluded.scryfall_updated_at,
        synced_at=excluded.synced_at`);

    this.insertPrinting = db.prepare(`
      INSERT INTO card_printings
        (id, oracle_id, set_code, collector_number, collector_number_num,
         collector_number_suffix, lang, rarity, released_at, artist, flavor_text,
         finishes, frame, frame_effects, border_color, promo_types,
         is_full_art, is_textless, is_promo, is_reprint, is_variation, is_digital,
         is_oversized, in_booster, image_small, image_normal, image_large, image_png,
         image_art_crop, image_status, price_usd, price_usd_foil, price_usd_etched,
         price_eur, price_eur_foil, price_tix, prices_updated_at,
         tcgplayer_id, tcgplayer_etched_id, cardmarket_id, purchase_uris,
         scryfall_uri, scryfall_updated_at, synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
              strftime('%Y-%m-%dT%H:%M:%SZ','now'),?,?,?,?,?,?,
              strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      ON CONFLICT(id) DO UPDATE SET
        oracle_id=excluded.oracle_id, set_code=excluded.set_code,
        collector_number=excluded.collector_number,
        collector_number_num=excluded.collector_number_num,
        collector_number_suffix=excluded.collector_number_suffix,
        rarity=excluded.rarity, released_at=excluded.released_at, artist=excluded.artist,
        flavor_text=excluded.flavor_text, finishes=excluded.finishes, frame=excluded.frame,
        frame_effects=excluded.frame_effects, border_color=excluded.border_color,
        promo_types=excluded.promo_types, is_full_art=excluded.is_full_art,
        is_textless=excluded.is_textless, is_promo=excluded.is_promo,
        is_reprint=excluded.is_reprint, is_variation=excluded.is_variation,
        is_digital=excluded.is_digital, is_oversized=excluded.is_oversized,
        in_booster=excluded.in_booster, image_small=excluded.image_small,
        image_normal=excluded.image_normal, image_large=excluded.image_large,
        image_png=excluded.image_png, image_art_crop=excluded.image_art_crop,
        image_status=excluded.image_status, price_usd=excluded.price_usd,
        price_usd_foil=excluded.price_usd_foil, price_usd_etched=excluded.price_usd_etched,
        price_eur=excluded.price_eur, price_eur_foil=excluded.price_eur_foil,
        price_tix=excluded.price_tix, prices_updated_at=excluded.prices_updated_at,
        tcgplayer_id=excluded.tcgplayer_id, tcgplayer_etched_id=excluded.tcgplayer_etched_id,
        cardmarket_id=excluded.cardmarket_id, purchase_uris=excluded.purchase_uris,
        scryfall_uri=excluded.scryfall_uri, scryfall_updated_at=excluded.scryfall_updated_at,
        synced_at=excluded.synced_at`);

    this.insertFace = db.prepare(`
      INSERT INTO card_faces
        (printing_id, face_index, name, mana_cost, type_line, oracle_text, colors_mask,
         power, toughness, loyalty, defense, artist, flavor_text,
         image_small, image_normal, image_large, image_png, image_art_crop)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(printing_id, face_index) DO UPDATE SET
        name=excluded.name, mana_cost=excluded.mana_cost, type_line=excluded.type_line,
        oracle_text=excluded.oracle_text, colors_mask=excluded.colors_mask,
        power=excluded.power, toughness=excluded.toughness, loyalty=excluded.loyalty,
        defense=excluded.defense, artist=excluded.artist, flavor_text=excluded.flavor_text,
        image_small=excluded.image_small, image_normal=excluded.image_normal,
        image_large=excluded.image_large, image_png=excluded.image_png,
        image_art_crop=excluded.image_art_crop`);

    this.insertLegality = db.prepare(`
      INSERT INTO card_legalities (oracle_id, format_code, legality) VALUES (?,?,?)
      ON CONFLICT(oracle_id, format_code) DO UPDATE SET legality=excluded.legality`);

    this.insertVariant = db.prepare(`
      INSERT INTO card_name_variants (oracle_id, variant_name, variant_normalized, kind)
      VALUES (?,?,?,?)
      ON CONFLICT(oracle_id, variant_normalized, kind) DO NOTHING`);

    this.insertSet = db.prepare(`
      INSERT INTO sets
        (code, scryfall_id, name, set_type, released_at, card_count, parent_set_code,
         block_code, block_name, digital, nonfoil_only, foil_only, icon_svg_uri,
         scryfall_uri, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      ON CONFLICT(code) DO UPDATE SET
        scryfall_id=excluded.scryfall_id, name=excluded.name, set_type=excluded.set_type,
        released_at=excluded.released_at, card_count=excluded.card_count,
        parent_set_code=excluded.parent_set_code, block_code=excluded.block_code,
        block_name=excluded.block_name, digital=excluded.digital,
        nonfoil_only=excluded.nonfoil_only, foil_only=excluded.foil_only,
        icon_svg_uri=excluded.icon_svg_uri, scryfall_uri=excluded.scryfall_uri,
        updated_at=excluded.updated_at`);

    this.linkParentSet = db.prepare(
      `UPDATE sets SET parent_set_code = ? WHERE code = ? AND EXISTS (SELECT 1 FROM sets WHERE code = ?)`,
    );
  }

  /** Sets must land before cards: card_printings.set_code is a RESTRICT FK. */
  importSets(records: SetRecord[]): void {
    // Parent references point at other sets, so clear them on the first pass
    // and fill them in once every row exists.
    for (const set of records) {
      this.insertSet.run(
        set.code, set.scryfallId, set.name, set.setType, set.releasedAt, set.cardCount,
        null, set.blockCode, set.blockName,
        bit(set.digital), bit(set.nonfoilOnly), bit(set.foilOnly),
        set.iconSvgUri, set.scryfallUri,
      );
    }
    for (const set of records) {
      if (set.parentSetCode) this.linkParentSet.run(set.parentSetCode, set.code, set.parentSetCode);
    }
  }

  /** Returns false when a record is unusable (no id, or an unknown set). */
  importCard(card: any): boolean {
    const printingId = text(card.id);
    const oracleId = oracleIdOf(card);
    const setCode = text(card.set)?.toLowerCase();
    if (!printingId || !oracleId || !setCode) {
      this.skippedCount += 1;
      return false;
    }

    if (!this.seenOracleIds.has(oracleId)) {
      this.importOracle(oracleId, card);
      this.seenOracleIds.add(oracleId);
      this.oracleCount += 1;
    }
    this.importPrinting(printingId, oracleId, setCode, card);
    this.printingCount += 1;
    return true;
  }

  private importOracle(oracleId: string, card: any): void {
    const faces: any[] = card.card_faces ?? [];
    const name: string = card.name ?? '';
    const typeLine: string = card.type_line ?? faces[0]?.type_line ?? '';

    // Search must reach text on the back of a double-faced card, so every
    // face's rules text is indexed together.
    const allText = [card.oracle_text, ...faces.map((f) => f?.oracle_text)]
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .join('\n—\n');

    const colors: string[] = card.colors ?? faces[0]?.colors ?? [];
    const identity: string[] = card.color_identity ?? [];

    const lowerType = typeLine.toLowerCase();
    const combinedText = (
      allText + ' ' + faces.map((f) => f?.type_line ?? '').join(' ')
    ).toLowerCase();

    const isLegendary = lowerType.includes('legendary');
    // Commanders are not only legendary creatures: legendary Vehicles
    // (Shorikai) and Spacecraft qualify too, and Scryfall does not restate that
    // in the rules text, so the type line has to carry it.
    const isCommanderType =
      lowerType.includes('creature') ||
      lowerType.includes('vehicle') ||
      lowerType.includes('spacecraft');

    this.insertOracle.run(
      oracleId,
      name,
      normalizeName(name),
      text(card.layout),
      text(card.mana_cost) ?? text(faces[0]?.mana_cost),
      num(card.cmc) ?? 0,
      typeLine,
      text(card.oracle_text) ?? text(faces[0]?.oracle_text),
      allText,
      text(card.power) ?? text(faces[0]?.power),
      text(card.toughness) ?? text(faces[0]?.toughness),
      text(card.loyalty) ?? text(faces[0]?.loyalty),
      text(card.defense) ?? text(faces[0]?.defense),
      colorMask(colors),
      colorMask(identity),
      canonicalColors(colors),
      canonicalColors(identity),
      identity.length,
      jsonArray(card.keywords),
      jsonArray(card.produced_mana),
      bit(card.reserved),
      bit(lowerType.includes('basic') && lowerType.includes('land')),
      bit(isLegendary),
      // Type eligibility only — deliberately says nothing about legality, since
      // banned commanders must still be shown and flagged (Phase 2). Phase 3
      // should combine this with card_legalities and handle the remaining
      // corner cases, such as Grist.
      bit((isLegendary && isCommanderType) || combinedText.includes('can be your commander')),
      bit(combinedText.includes('partner') || combinedText.includes('friends forever')),
      bit(lowerType.includes('background') || combinedText.includes('choose a background')),
      num(card.edhrec_rank),
      bit(card.game_changer),
      text(card.released_at),
    );

    for (const [format, legality] of Object.entries(card.legalities ?? {})) {
      if (typeof legality === 'string') this.insertLegality.run(oracleId, format, legality);
    }

    this.insertVariant.run(oracleId, name, normalizeName(name), 'primary');
    for (const face of faces) {
      const faceName = text(face?.name);
      if (faceName && faceName !== name) {
        this.insertVariant.run(oracleId, faceName, normalizeName(faceName), 'face');
      }
    }
    // "Fire // Ice" should also be findable by either half alone.
    if (name.includes(' // ')) {
      for (const half of name.split(' // ')) {
        if (half) this.insertVariant.run(oracleId, half, normalizeName(half), 'face');
      }
    }
  }

  private importPrinting(printingId: string, oracleId: string, setCode: string, card: any): void {
    const collectorNumber: string = card.collector_number ?? '';
    const split = splitCollectorNumber(collectorNumber);
    const prices = card.prices ?? {};
    const images = card.image_uris ?? {};

    this.insertPrinting.run(
      printingId, oracleId, setCode, collectorNumber, split.number, split.suffix,
      text(card.lang) ?? 'en',
      text(card.rarity),
      text(card.released_at),
      text(card.artist),
      text(card.flavor_text),
      jsonArray(card.finishes),
      text(card.frame),
      jsonArray(card.frame_effects),
      text(card.border_color),
      jsonArray(card.promo_types),
      bit(card.full_art), bit(card.textless), bit(card.promo), bit(card.reprint),
      bit(card.variation), bit(card.digital), bit(card.oversized),
      bit(card.booster ?? true),
      text(images.small), text(images.normal), text(images.large),
      text(images.png), text(images.art_crop), text(card.image_status),
      price(prices, 'usd'), price(prices, 'usd_foil'), price(prices, 'usd_etched'),
      price(prices, 'eur'), price(prices, 'eur_foil'), price(prices, 'tix'),
      num(card.tcgplayer_id), num(card.tcgplayer_etched_id), num(card.cardmarket_id),
      jsonObject(card.purchase_uris),
      text(card.scryfall_uri),
      text(card.released_at),
    );

    const faces: any[] = card.card_faces ?? [];
    for (let index = 0; index < faces.length; index += 1) {
      const face = faces[index];
      const faceImages = face?.image_uris ?? {};
      this.insertFace.run(
        printingId, index,
        face?.name ?? '',
        text(face?.mana_cost), text(face?.type_line), text(face?.oracle_text),
        colorMask(face?.colors ?? []),
        text(face?.power), text(face?.toughness), text(face?.loyalty), text(face?.defense),
        text(face?.artist), text(face?.flavor_text),
        text(faceImages.small), text(faceImages.normal), text(faceImages.large),
        text(faceImages.png), text(faceImages.art_crop),
      );
    }
  }

  /**
   * Chooses the printing each card shows by default: the newest paper,
   * non-promo, non-digital one, falling back to whatever exists.
   */
  assignDefaultPrintings(): void {
    this.db.exec(`
      UPDATE oracle_cards SET default_printing_id = (
          SELECT p.id FROM card_printings p
           WHERE p.oracle_id = oracle_cards.oracle_id
           ORDER BY p.is_digital ASC, p.is_promo ASC, p.is_oversized ASC,
                    (p.image_normal IS NULL) ASC,
                    COALESCE(p.released_at,'0000-00-00') DESC
           LIMIT 1
      )`);
  }
}

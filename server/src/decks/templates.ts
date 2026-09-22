import type Database from 'better-sqlite3';
import { CATEGORY_LABELS } from '../sync/categories.ts';
import { categoryListMatches, parseCategoryList } from './categories.ts';
import type { DeckCard } from './types.ts';
import { prepared } from '../db/index.ts';

/** Setting key: when '1', the "Follow a template" control appears on decks. */
export const SHOW_DECK_TEMPLATES = 'show_deck_templates';

export class TemplateNotFoundError extends Error {
  constructor(id: number) {
    super(`No deck template with id ${id}.`);
    this.name = 'TemplateNotFoundError';
  }
}

export interface TemplateTargetRow {
  category: string;
  label: string;
  ideal: number;
  minCount: number | null;
  maxCount: number | null;
  note: string | null;
  sortOrder: number;
}

export interface DeckTemplate {
  id: number;
  name: string;
  formatCode: string | null;
  archetype: string | null;
  description: string | null;
  isBuiltin: boolean;
  sortOrder: number;
  targets: TemplateTargetRow[];
}

export interface TemplateProgressRow extends TemplateTargetRow {
  current: number;
  isShort: boolean;
  isOver: boolean;
}

export interface TemplateProgress {
  templateId: number;
  templateName: string;
  rows: TemplateProgressRow[];
  /** Cards in the counted boards that match none of this template's categories. */
  uncategorisedCount: number;
  /** Sum of every counted card's quantity — never claimed to equal any row total, since categories overlap. */
  countedTotal: number;
  /**
   * Whether Scryfall's tag categories have ever been resolved.
   *
   * False makes every tag-derived row read zero, which is indistinguishable
   * from a deck that genuinely has no removal — so the panel has to be able
   * to say which it is looking at.
   */
  tagDataAvailable: boolean;
}

/** A category label, from the shared list or capitalised as a fallback. */
function labelFor(category: string): string {
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  if (category === 'lands') return 'Lands';
  if (category === 'creatures') return 'Creatures';
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function toTarget(row: any): TemplateTargetRow {
  return {
    category: row.category,
    label: labelFor(row.category),
    ideal: row.ideal,
    minCount: row.min_count,
    maxCount: row.max_count,
    note: row.note,
    sortOrder: row.sort_order,
  };
}

function toTemplate(row: any, targets: TemplateTargetRow[]): DeckTemplate {
  return {
    id: row.id,
    name: row.name,
    formatCode: row.format_code,
    archetype: row.archetype,
    description: row.description,
    isBuiltin: Boolean(row.is_builtin),
    sortOrder: row.sort_order,
    targets,
  };
}

/** Loads one template with its targets, or null. Shared by the store and DeckStore. */
export function loadTemplate(db: Database.Database, id: number): DeckTemplate | null {
  const row = db.prepare('SELECT * FROM deck_templates WHERE id = ?').get(id) as any;
  if (!row) return null;
  const targets = (db.prepare(
    'SELECT * FROM deck_template_targets WHERE template_id = ? ORDER BY sort_order',
  ).all(id) as any[]).map(toTarget);
  return toTemplate(row, targets);
}

/**
 * How far a deck stands from a template's targets.
 *
 * Pure and DB-free: a card's manual category (deck_cards.category) always
 * wins over Scryfall's tag-derived ones — the phase's priority order — so a
 * card with a manual override counts toward the categories that override
 * names and no others. That override may name several, so a card doing two
 * jobs need not pick one row to satisfy. A card with no override counts
 * toward every tag category it matches, which is why the rows deliberately do
 * not sum to the deck size.
 */
export function computeTemplateProgress(
  cards: DeckCard[],
  template: DeckTemplate,
  tagDataAvailable = true,
): TemplateProgress {
  // Sideboard is outside the built list and the maybeboard is a scratch pad;
  // template targets describe the deck itself.
  const counted = cards.filter((c) => c.board === 'main' || c.board === 'command');
  const targetCategories = new Set(template.targets.map((t) => t.category));

  // A manual override may name several categories, and then counts toward
  // each of them — a card that really is both ramp and card draw should not
  // have to pick one row to satisfy.
  const manualMatch = (card: DeckCard, category: string): boolean =>
    categoryListMatches(parseCategoryList(card.category), category, labelFor);

  const cardMatches = (card: DeckCard, category: string): boolean => {
    if (parseCategoryList(card.category).length > 0) return manualMatch(card, category);
    if (category === 'lands') return card.typeLine.toLowerCase().includes('land');
    if (category === 'creatures') return card.typeLine.toLowerCase().includes('creature');
    return card.categories.includes(category);
  };

  const rows: TemplateProgressRow[] = template.targets.map((target) => {
    let current = 0;
    for (const card of counted) {
      if (cardMatches(card, target.category)) current += card.quantity;
    }
    return {
      ...target,
      current,
      isShort: current < (target.minCount ?? target.ideal),
      isOver: target.maxCount != null && current > target.maxCount,
    };
  });

  let uncategorisedCount = 0;
  for (const card of counted) {
    const matchesAny = [...targetCategories].some((category) => cardMatches(card, category));
    if (!matchesAny) uncategorisedCount += card.quantity;
  }

  return {
    templateId: template.id,
    templateName: template.name,
    rows,
    uncategorisedCount,
    countedTotal: counted.reduce((total, c) => total + c.quantity, 0),
    tagDataAvailable,
  };
}

export interface TemplateTargetInput {
  category: string;
  ideal: number;
  minCount?: number | null;
  maxCount?: number | null;
  note?: string | null;
}

export class TemplateStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Every template with its targets, in two queries rather than one per row.
   *
   * The targets came back through a per-template SELECT inside the map, which
   * is the shape that quietly turns a template list into N+1 round trips. One
   * ordered sweep of the child table grouped in JS gives the same answer: the
   * ORDER BY carries template_id first so each group is already contiguous and
   * already in sort_order within itself.
   */
  list(): DeckTemplate[] {
    const rows = prepared(
      this.db,
      'SELECT * FROM deck_templates ORDER BY sort_order, name COLLATE NOCASE',
    ).all() as any[];
    if (rows.length === 0) return [];

    const byTemplate = new Map<number, TemplateTargetRow[]>();
    const targetRows = prepared(
      this.db,
      'SELECT * FROM deck_template_targets ORDER BY template_id, sort_order',
    ).all() as any[];
    for (const target of targetRows) {
      let group = byTemplate.get(target.template_id);
      if (!group) {
        group = [];
        byTemplate.set(target.template_id, group);
      }
      group.push(toTarget(target));
    }

    return rows.map((row) => toTemplate(row, byTemplate.get(row.id) ?? []));
  }

  get(id: number): DeckTemplate | null {
    return loadTemplate(this.db, id);
  }

  create(input: {
    name: string;
    formatCode?: string | null;
    archetype?: string | null;
    description?: string | null;
    targets?: TemplateTargetInput[];
  }): number {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO deck_templates (name, format_code, archetype, description, is_builtin)
        VALUES (?,?,?,?,0)`)
        .run(input.name.trim() || 'Untitled template', input.formatCode ?? null,
             input.archetype ?? null, input.description ?? null);
      const id = Number(result.lastInsertRowid);
      if (input.targets) this.replaceTargets(id, input.targets);
      return id;
    })();
  }

  /** Cloning a built-in gives an editable copy; the seeded original is untouched. */
  clone(id: number, name?: string): number {
    const source = loadTemplate(this.db, id);
    if (!source) throw new TemplateNotFoundError(id);
    return this.create({
      name: name?.trim() || `${source.name} copy`,
      formatCode: source.formatCode,
      archetype: source.archetype,
      description: source.description,
      targets: source.targets.map((t) => ({
        category: t.category, ideal: t.ideal, minCount: t.minCount, maxCount: t.maxCount, note: t.note,
      })),
    });
  }

  update(
    id: number,
    changes: {
      name?: string; formatCode?: string | null; archetype?: string | null;
      description?: string | null; targets?: TemplateTargetInput[];
    },
  ): void {
    const existing = this.db.prepare('SELECT id FROM deck_templates WHERE id = ?').get(id);
    if (!existing) throw new TemplateNotFoundError(id);

    this.db.transaction(() => {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (changes.name !== undefined) { sets.push('name = ?'); params.push(changes.name.trim() || 'Untitled template'); }
      if (changes.formatCode !== undefined) { sets.push('format_code = ?'); params.push(changes.formatCode); }
      if (changes.archetype !== undefined) { sets.push('archetype = ?'); params.push(changes.archetype); }
      if (changes.description !== undefined) { sets.push('description = ?'); params.push(changes.description); }
      if (sets.length > 0) {
        this.db.prepare(`UPDATE deck_templates SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      }
      if (changes.targets) this.replaceTargets(id, changes.targets);
    })();
  }

  private replaceTargets(templateId: number, targets: TemplateTargetInput[]): void {
    this.db.prepare('DELETE FROM deck_template_targets WHERE template_id = ?').run(templateId);
    const insert = this.db.prepare(`
      INSERT INTO deck_template_targets (template_id, category, ideal, min_count, max_count, note, sort_order)
      VALUES (?,?,?,?,?,?,?)`);
    targets.forEach((target, index) => {
      insert.run(
        templateId, target.category.trim(), Math.max(0, target.ideal),
        target.minCount ?? null, target.maxCount ?? null, target.note ?? null, index,
      );
    });
  }

  /** decks.template_id is ON DELETE SET NULL, so every deck using this releases it automatically. */
  delete(id: number): void {
    const result = this.db.prepare('DELETE FROM deck_templates WHERE id = ?').run(id);
    if (result.changes === 0) throw new TemplateNotFoundError(id);
  }
}

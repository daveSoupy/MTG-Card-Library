import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../db/index.ts';
import { AUTO_MAINTAIN_LANDS } from '../decks/store.ts';
import { SHOW_DECK_TEMPLATES } from '../decks/templates.ts';
import { SHOW_GAME_LOG } from '../events/store.ts';
import { COST_METHODS } from '../collection/store.ts';
import {
  ALLOCATION_DEFAULTS, ALLOCATION_IGNORES_BASICS, BREWS_RESERVE_COPIES,
  TRADELIST_REDUCES_AVAILABLE,
} from '../decks/allocation.ts';
import { ASSEMBLY_MOVES_LOTS, ASSEMBLY_MOVES_LOTS_DEFAULT } from '../decks/assembly.ts';
import { FLAG, MONEY } from './schema.ts';

/**
 * App-level settings.
 *
 * app_settings is a key/value bag, but the API exposes a fixed, typed surface
 * rather than arbitrary key writes: the client sends camelCase values, the
 * server maps them to/from the stored strings. Adding a setting is one entry in
 * the matching map below (boolean, enum, or number).
 */

interface BooleanSetting { key: string; default: boolean; }
interface EnumSetting { key: string; default: string; allowed: readonly string[]; }
interface NumberSetting { key: string; default: number; }

const BOOLEAN_SETTINGS: Record<string, BooleanSetting> = {
  autoMaintainLands: { key: AUTO_MAINTAIN_LANDS, default: false },
  showDeckTemplates: { key: SHOW_DECK_TEMPLATES, default: false },
  showGameLog: { key: SHOW_GAME_LOG, default: false },
  // Phase 22. The defaults live beside the rule they change, in allocation.ts,
  // so a reader of that module never has to come here to find out what is on.
  allocationIgnoresBasics: {
    key: ALLOCATION_IGNORES_BASICS, default: ALLOCATION_DEFAULTS.ignoreBasics,
  },
  brewsReserveCopies: {
    key: BREWS_RESERVE_COPIES, default: ALLOCATION_DEFAULTS.brewsReserve,
  },
  tradelistReducesAvailable: {
    key: TRADELIST_REDUCES_AVAILABLE, default: ALLOCATION_DEFAULTS.tradeListReduces,
  },
  // Phase 25. Off, an assembly run is a checklist and touches no data; on,
  // completing one physically relocates lots into the deck's home location.
  // The safe version is useful on its own, so the destructive one is a
  // decision rather than a default.
  assemblyMovesLots: { key: ASSEMBLY_MOVES_LOTS, default: ASSEMBLY_MOVES_LOTS_DEFAULT },
};

/**
 * Phase 23. The scope the deck builder's search pane opens in — the whole
 * catalog, or only what you own / can still claim. Browse always opens on
 * 'all'; narrowing the whole card database by default is a different decision
 * and not one this setting makes.
 */
export const DECKBUILDER_DEFAULT_SCOPE = 'deckbuilder_default_scope';
export const DECKBUILDER_SCOPES = ['all', 'owned', 'available'] as const;

export const DEFAULT_COST_METHOD = 'default_cost_method';
export const DEFAULT_COST_FIXED_USD = 'default_cost_fixed_usd';
export const DRAFT_BOOSTER_PRICE_USD = 'draft_booster_price_usd';

// 'box' is a per-session choice, not an app default — the default is one of the
// methods that resolves a cost on its own.
const ENUM_SETTINGS: Record<string, EnumSetting> = {
  defaultCostMethod: {
    key: DEFAULT_COST_METHOD,
    default: 'unknown',
    allowed: COST_METHODS.filter((m) => m !== 'box'),
  },
  deckbuilderDefaultScope: {
    key: DECKBUILDER_DEFAULT_SCOPE,
    default: 'all',
    allowed: DECKBUILDER_SCOPES,
  },
};

const NUMBER_SETTINGS: Record<string, NumberSetting> = {
  defaultCostFixedUsd: { key: DEFAULT_COST_FIXED_USD, default: 0 },
  // Price of one booster pack; the Draft cost method defaults to 3× this.
  draftBoosterPriceUsd: { key: DRAFT_BOOSTER_PRICE_USD, default: 4 },
};

/**
 * The PUT body schema, built from the three allowlists above so a new setting
 * stays one entry in one map. `additionalProperties` is left open on purpose:
 * an unknown key still reaches the handler, which names it in the error.
 */
const SETTINGS_BODY = {
  type: 'object',
  properties: {
    ...Object.fromEntries(Object.keys(BOOLEAN_SETTINGS).map((name) => [name, FLAG])),
    ...Object.fromEntries(Object.entries(ENUM_SETTINGS).map(
      ([name, setting]) => [name, { type: 'string', enum: [...setting.allowed] }])),
    ...Object.fromEntries(Object.keys(NUMBER_SETTINGS).map((name) => [name, MONEY])),
  },
};

type SettingsShape = Record<string, boolean | string | number>;

function readSettings(db: Database.Database): SettingsShape {
  const result: SettingsShape = {};
  for (const [name, setting] of Object.entries(BOOLEAN_SETTINGS)) {
    const stored = getSetting(db, setting.key);
    result[name] = stored === null ? setting.default : stored === '1';
  }
  for (const [name, setting] of Object.entries(ENUM_SETTINGS)) {
    const stored = getSetting(db, setting.key);
    result[name] = stored != null && setting.allowed.includes(stored) ? stored : setting.default;
  }
  for (const [name, setting] of Object.entries(NUMBER_SETTINGS)) {
    const stored = getSetting(db, setting.key);
    const parsed = stored == null ? NaN : Number(stored);
    result[name] = Number.isFinite(parsed) && parsed >= 0 ? parsed : setting.default;
  }
  return result;
}

export function registerSettingsRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/v1/settings', async () => ({ settings: readSettings(db) }));

  // The schema has already checked every known key's type; what is left for the
  // handler is the one thing a schema built this way cannot say — that a key it
  // does not know about is a mistake worth naming.
  app.put<{ Body: Record<string, boolean | string | number> }>(
    '/api/v1/settings',
    { schema: { body: SETTINGS_BODY } },
    async (request, reply) => {
      for (const [name, value] of Object.entries(request.body ?? {})) {
        if (BOOLEAN_SETTINGS[name]) {
          setSetting(db, BOOLEAN_SETTINGS[name].key, value ? '1' : '0');
        } else if (ENUM_SETTINGS[name]) {
          setSetting(db, ENUM_SETTINGS[name].key, String(value));
        } else if (NUMBER_SETTINGS[name]) {
          setSetting(db, NUMBER_SETTINGS[name].key, String(value));
        } else {
          return reply.status(400).send({ error: `Unknown setting "${name}".` });
        }
      }

      return { settings: readSettings(db) };
    },
  );
}

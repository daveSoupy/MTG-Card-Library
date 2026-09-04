import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../db/index.ts';
import { AUTO_MAINTAIN_LANDS } from '../decks/store.ts';
import { COST_METHODS } from '../collection/store.ts';

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
};

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
};

const NUMBER_SETTINGS: Record<string, NumberSetting> = {
  defaultCostFixedUsd: { key: DEFAULT_COST_FIXED_USD, default: 0 },
  // Price of one booster pack; the Draft cost method defaults to 3× this.
  draftBoosterPriceUsd: { key: DRAFT_BOOSTER_PRICE_USD, default: 4 },
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

  app.put('/api/v1/settings', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    for (const [name, value] of Object.entries(body)) {
      if (BOOLEAN_SETTINGS[name]) {
        if (typeof value !== 'boolean') {
          return reply.status(400).send({ error: `Setting "${name}" must be a boolean.` });
        }
        setSetting(db, BOOLEAN_SETTINGS[name].key, value ? '1' : '0');
      } else if (ENUM_SETTINGS[name]) {
        const setting = ENUM_SETTINGS[name];
        if (typeof value !== 'string' || !setting.allowed.includes(value)) {
          return reply.status(400).send({ error: `Setting "${name}" must be one of: ${setting.allowed.join(', ')}.` });
        }
        setSetting(db, setting.key, value);
      } else if (NUMBER_SETTINGS[name]) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
          return reply.status(400).send({ error: `Setting "${name}" must be a number ≥ 0.` });
        }
        setSetting(db, NUMBER_SETTINGS[name].key, String(parsed));
      } else {
        return reply.status(400).send({ error: `Unknown setting "${name}".` });
      }
    }

    return { settings: readSettings(db) };
  });
}

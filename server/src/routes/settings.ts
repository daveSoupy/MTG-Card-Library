import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../db/index.ts';
import { AUTO_MAINTAIN_LANDS } from '../decks/store.ts';

/**
 * App-level settings.
 *
 * app_settings is a key/value bag, but the API exposes a fixed, typed surface
 * rather than arbitrary key writes: the client sends camelCase booleans, the
 * server maps them to the stored '1'/'0' strings. Adding a setting is one entry
 * in the map below.
 */

interface BooleanSetting {
  key: string;
  /** Value when nothing has been stored yet. */
  default: boolean;
}

const BOOLEAN_SETTINGS: Record<string, BooleanSetting> = {
  autoMaintainLands: { key: AUTO_MAINTAIN_LANDS, default: false },
};

function readSettings(db: Database.Database): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const [name, setting] of Object.entries(BOOLEAN_SETTINGS)) {
    const stored = getSetting(db, setting.key);
    result[name] = stored === null ? setting.default : stored === '1';
  }
  return result;
}

export function registerSettingsRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/v1/settings', async () => ({ settings: readSettings(db) }));

  app.put('/api/v1/settings', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    for (const [name, value] of Object.entries(body)) {
      const setting = BOOLEAN_SETTINGS[name];
      if (!setting) return reply.status(400).send({ error: `Unknown setting "${name}".` });
      if (typeof value !== 'boolean') {
        return reply.status(400).send({ error: `Setting "${name}" must be a boolean.` });
      }
      setSetting(db, setting.key, value ? '1' : '0');
    }

    return { settings: readSettings(db) };
  });
}

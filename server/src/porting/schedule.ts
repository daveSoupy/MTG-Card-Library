import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { backupTo, pruneBackups } from './backup.ts';

/**
 * Unattended local backups.
 *
 * The server runs on a box at home under systemd; the failure this guards
 * against is a bad import or a mistaken bulk edit, not a disk dying — for that,
 * the downloaded file is the real backup. So these are kept on the same
 * machine, and kept few.
 */

const INTERVAL_MS = 24 * 60 * 60 * 1000;
const KEEP = 7;

export interface BackupSchedule {
  directory: string;
  stop: () => void;
  runNow: () => { path: string; bytes: number };
  list: () => Array<{ name: string; bytes: number; takenAt: string }>;
}

export function startBackupSchedule(db: Database.Database, dataDir: string): BackupSchedule {
  const directory = join(dataDir, 'backups');
  mkdirSync(directory, { recursive: true });

  const runNow = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const result = backupTo(db, join(directory, `library-${stamp}.sqlite`));
    pruneBackups(directory, KEEP);
    return result;
  };

  const list = () =>
    readdirSync(directory)
      .filter((name) => name.endsWith('.sqlite'))
      .map((name) => {
        const stats = statSync(join(directory, name));
        return { name, bytes: stats.size, takenAt: new Date(stats.mtimeMs).toISOString() };
      })
      .sort((a, b) => b.takenAt.localeCompare(a.takenAt));

  // Only back up if the newest one is already a day old, so restarting the
  // server repeatedly does not spend the whole retention window in one morning.
  const dueNow = () => {
    const newest = list()[0];
    return !newest || Date.now() - Date.parse(newest.takenAt) >= INTERVAL_MS;
  };

  if (dueNow()) runNow();
  const timer = setInterval(() => { if (dueNow()) runNow(); }, 60 * 60 * 1000);
  // An open timer would keep the process alive on shutdown.
  timer.unref();

  return { directory, stop: () => clearInterval(timer), runNow, list };
}

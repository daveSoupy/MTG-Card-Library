/**
 * Auto-update (Phase 34): electron-updater against the GitHub Releases of
 * `daveSoupy/MTG-Card-Library`, where the release workflow puts the
 * installers and the `latest-mac.yml` / `latest.yml` beside them.
 *
 * The rules, all of them about not interrupting anyone:
 *
 * - Check on launch and once a day. Download in the background. The tray
 *   gains a *Restart to update* item when one is ready; nothing else changes
 *   until the user quits, when the update applies on its own. **Never a
 *   dialog the user did not ask for** — a prompt over the deck builder is the
 *   wrong thing at any moment. The one dialog is the answer to *Check for
 *   updates…*, which the user clicked.
 * - The shell does no migration. A new build over an old data directory is
 *   the server's `migrations.ts` running on the next open, as under systemd
 *   and Docker.
 * - The updater only works on a packaged, signed app. macOS's Squirrel
 *   refuses an unsigned bundle outright; in development electron-updater
 *   declines to check at all. `start()` is therefore a no-op unless packaged,
 *   and a manual check in development says so instead of pretending.
 *
 * How "applied on quit" actually happens, because it differs per platform:
 * on macOS the downloaded zip is handed to Squirrel.Mac, whose ShipIt helper
 * swaps the bundle after the process exits; on Windows electron-updater
 * listens for Electron's `quit` event and runs the NSIS installer silently.
 * Both need the shell to leave through `app.quit()` — `app.exit()` skips the
 * `quit` event, which is why `main.ts`'s shutdown ends the way it does.
 */

import { EventEmitter } from 'node:events';

import { app } from 'electron';
import updater from 'electron-updater';

import type { RotatingLog } from './logging.ts';
import { CHECK_INTERVAL_MS, type UpdateState } from './updateState.ts';

// electron-updater is CommonJS; its named exports are defined with getters
// that Node's ESM interop does not always surface, so take the default and
// destructure at runtime.
const { autoUpdater } = updater;

export interface UpdateEvents {
  change: [UpdateState];
}

/** A one-line reason for the log, without the stack an updater error usually carries. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}

export class Updates extends EventEmitter<UpdateEvents> {
  state: UpdateState = { kind: 'idle' };
  private timer: NodeJS.Timeout | null = null;
  private wired = false;

  constructor(private readonly log: RotatingLog) {
    super();
  }

  /** True on a packaged app: the only place an update can be checked for or applied. */
  get active(): boolean {
    return app.isPackaged;
  }

  get ready(): boolean {
    return this.state.kind === 'ready';
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.emit('change', state);
  }

  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    // Everything the updater says goes to the same log as the server, so
    // "Show logs" is where an update that never arrived gets diagnosed.
    const note = (level: string) => (message: unknown) => this.log.note(`[updater ${level}] ${String(message)}`);
    autoUpdater.logger = { info: note('info'), warn: note('warn'), error: note('error'), debug: note('debug') };

    autoUpdater.on('checking-for-update', () => this.set({ kind: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ kind: 'up-to-date', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => this.set({ kind: 'downloading', version: info.version, percent: null }));
    autoUpdater.on('download-progress', (progress) => {
      if (this.state.kind === 'downloading') this.set({ ...this.state, percent: progress.percent });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.log.note(`update ${info.version} downloaded; applied on quit`);
      this.set({ kind: 'ready', version: info.version });
    });
    autoUpdater.on('error', (error) => {
      // A download that was under way is lost; a staged update is not.
      if (this.state.kind !== 'ready') this.set({ kind: 'error', message: describe(error) });
    });
  }

  /** Check now, then daily. A no-op in development. */
  start(): void {
    if (!this.active) {
      this.log.note('updater off: not a packaged app');
      return;
    }
    this.wire();
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    // A pending timer must not keep a quitting process alive.
    this.timer.unref();
  }

  /**
   * One check, resolving to the state it left the updater in. Never throws:
   * a failed check is `{ kind: 'error' }`, already logged. While a download
   * is in progress or an update is staged, it reports that rather than
   * starting over.
   */
  async check(): Promise<UpdateState> {
    if (!this.active) return { kind: 'error', message: 'Updates only work in the installed app, not when run from the working tree.' };
    if (this.state.kind === 'downloading' || this.state.kind === 'ready') return this.state;
    this.wire();
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // The 'error' listener has recorded it; this is only the rejection.
      if (this.state.kind !== 'error') this.set({ kind: 'error', message: describe(error) });
    }
    return this.state;
  }

  /**
   * *Restart to update*: quit through the ordinary path (the server is
   * stopped first, by `main.ts`'s before-quit handler) and come back on the
   * new version. Silent install on Windows; on macOS Squirrel relaunches.
   */
  restartToUpdate(): void {
    if (!this.ready) return;
    this.log.note('restart to update');
    autoUpdater.quitAndInstall(true, true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

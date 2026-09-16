/**
 * The server as a child process.
 *
 * `server/dist/index.js`, unmodified, on a bundled official Node binary —
 * never Electron's own Node (`ELECTRON_RUN_AS_NODE`), so `better-sqlite3`'s
 * prebuilt binary for stock Node works as installed and there is no ABI
 * rebuild to lose FTS5 in. The shell's whole contract with it is three
 * environment variables, a log file, and a way to ask it to stop.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { LineSplitter, type RotatingLog } from './logging.ts';

export interface ServerLaunch {
  /** Absolute path of the Node binary to run the server on. */
  node: string;
  /** Absolute path of `server/dist/index.js`. */
  entry: string;
  cwd: string;
  env: Record<string, string>;
  /** Where stdout and stderr go. */
  log: RotatingLog;
}

export interface ServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the shell asked it to stop; false is a crash. */
  expected: boolean;
}

export interface ServerEvents {
  /** One line of stdout or stderr, for the splash. */
  line: [string];
  exit: [ServerExit];
}

/** How long a graceful stop may take before the child is killed outright. The server's own ceiling on a stuck sync worker is 10s. */
export const STOP_GRACE_MS = 15_000;

export class ServerProcess extends EventEmitter<ServerEvents> {
  private child: ChildProcess | null = null;
  private stopping = false;

  get running(): boolean {
    return this.child !== null;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(launch: ServerLaunch): void {
    if (this.child) throw new Error('The server is already running');
    this.stopping = false;
    launch.log.note(`starting ${launch.node} ${launch.entry} (MTG_HOST=${launch.env.MTG_HOST} MTG_PORT=${launch.env.MTG_PORT} MTG_DATA_DIR=${launch.env.MTG_DATA_DIR})`);

    const child = spawn(launch.node, [launch.entry], {
      cwd: launch.cwd,
      env: launch.env,
      // stdin stays open on purpose: closing it is how the shell asks for
      // shutdown on Windows, and how the server notices a shell that died.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    const forward = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      const splitter = new LineSplitter();
      stream.on('data', (chunk: Buffer | string) => {
        launch.log.write(chunk);
        for (const line of splitter.push(chunk)) this.emit('line', line);
      });
      stream.on('end', () => {
        for (const line of splitter.flush()) this.emit('line', line);
      });
    };
    forward(child.stdout);
    forward(child.stderr);

    child.on('error', (error) => {
      // A missing or non-executable binary. `exit` follows with a null code.
      launch.log.note(`could not start the server: ${error.message}`);
      this.emit('line', `Could not start the server: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      const expected = this.stopping;
      launch.log.note(`server exited (code ${code}, signal ${signal})${expected ? '' : ' — unexpectedly'}`);
      this.child = null;
      this.emit('exit', { code, signal, expected });
    });
  }

  /**
   * Asks the server to stop and waits for it.
   *
   * POSIX: SIGTERM, which `index.ts` handles by stopping the sync worker,
   * closing Fastify and the database. Windows has no SIGTERM to send a
   * child — `kill()` there is TerminateProcess — so the shell closes the
   * child's stdin instead and the server, started with
   * `MTG_SHUTDOWN_ON_STDIN_CLOSE=1`, treats that as the same request. Only
   * after `graceMs` does SIGKILL happen; never first. The database is in WAL
   * mode, so an unclean exit is survivable, but there is no reason to have one.
   */
  stop({ graceMs = STOP_GRACE_MS }: { graceMs?: number } = {}): Promise<{ graceful: boolean }> {
    const child = this.child;
    if (!child) return Promise.resolve({ graceful: true });
    this.stopping = true;
    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve({ graceful: true });
      };
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit);
        child.once('exit', () => resolve({ graceful: false }));
        child.kill('SIGKILL');
      }, graceMs);
      child.once('exit', onExit);
      if (process.platform === 'win32') child.stdin?.end();
      else child.kill('SIGTERM');
    });
  }
}

/**
 * Resolves once `GET /api/v1/health` answers 200. The first cold start
 * includes any pending migrations and `warmCache()`, so this is seconds, not
 * milliseconds; polling continues as long as the process is alive and
 * rejects the moment it is not.
 */
export async function waitForHealth(
  url: string,
  { alive, intervalMs = 250 }: { alive: () => boolean; intervalMs?: number },
): Promise<void> {
  for (;;) {
    if (!alive()) throw new Error('The server stopped before it answered /api/v1/health');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

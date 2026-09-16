/**
 * Where the server's stdout and stderr go when there is no terminal.
 *
 * A size-rotated file under `<userData>/logs/`. Fastify at `info` writes a
 * line per request and the app runs for months, so rotation happens on
 * write, not only at launch. "Help → Show logs" opens the folder.
 */

import { closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RotatingLogOptions {
  /** Rotate once the file exceeds this many bytes. */
  maxBytes?: number;
  /** How many rotated files to keep (`.1` … `.keep`). */
  keep?: number;
}

export class RotatingLog {
  private fd: number | null = null;
  private size = 0;
  private readonly maxBytes: number;
  private readonly keep: number;
  readonly path: string;

  constructor(path: string, { maxBytes = 5 * 1024 * 1024, keep = 3 }: RotatingLogOptions = {}) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.keep = keep;
    mkdirSync(dirname(path), { recursive: true });
    this.open();
  }

  private open(): void {
    this.fd = openSync(this.path, 'a');
    try {
      this.size = statSync(this.path).size;
    } catch {
      this.size = 0;
    }
  }

  write(chunk: string | Uint8Array): void {
    if (this.fd === null) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (this.size + bytes.length > this.maxBytes && this.size > 0) this.rotate();
    try {
      writeSync(this.fd, bytes);
      this.size += bytes.length;
    } catch {
      // A log line lost is not worth stopping the app over.
    }
  }

  /** A line with a timestamp — the shell's own events, next to the server's. */
  note(message: string): void {
    this.write(`${new Date().toISOString()} [desktop] ${message}\n`);
  }

  private rotate(): void {
    this.close();
    for (let i = this.keep; i >= 1; i -= 1) {
      const from = i === 1 ? this.path : `${this.path}.${i - 1}`;
      const to = `${this.path}.${i}`;
      try {
        if (i === this.keep) unlinkSync(to);
      } catch {
        // Nothing to drop yet.
      }
      try {
        renameSync(from, to);
      } catch {
        // That generation does not exist yet.
      }
    }
    this.open();
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // Already closed.
    }
    this.fd = null;
  }
}

/**
 * The human part of one server log line, for the splash screen.
 *
 * Fastify's logger is pino, which writes one JSON object per line; the
 * splash shows its `msg`. Anything that is not pino JSON (a stack trace, a
 * `console.log` from the sync worker) is shown as is. Blank lines are null.
 */
export function bootMessage(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { msg?: unknown };
      if (typeof parsed.msg === 'string' && parsed.msg.length > 0) return parsed.msg;
    } catch {
      // Not JSON after all.
    }
  }
  return trimmed;
}

/**
 * Splits a stream's chunks into whole lines, holding a partial tail until
 * the next chunk completes it.
 */
export class LineSplitter {
  private tail = '';

  push(chunk: string | Uint8Array): string[] {
    this.tail += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const parts = this.tail.split(/\r?\n/);
    this.tail = parts.pop() ?? '';
    return parts;
  }

  /** Whatever is left when the stream ends. */
  flush(): string[] {
    const rest = this.tail;
    this.tail = '';
    return rest.length > 0 ? [rest] : [];
  }
}

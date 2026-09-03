/**
 * One fetch per image, a few at a time.
 *
 * A page of search results asks for 60 images at once. Without this each one is
 * its own unthrottled request to Scryfall — well past the ~10/sec CLAUDE.md
 * asks for — and two tiles showing the same printing both download it.
 */
export class FetchQueue {
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  private readonly limit: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  // Written out rather than as a parameter property: Node's type stripping
  // rejects those, and this runs under --experimental-strip-types.
  constructor(limit = 6) {
    this.limit = limit;
  }

  /**
   * Runs `work` for `key`, sharing the result with anyone else asking for the
   * same key while it is still running.
   */
  run(key: string, work: () => Promise<Buffer>): Promise<Buffer> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const started = this.acquire()
      .then(work)
      .finally(() => {
        this.inFlight.delete(key);
        this.release();
      });

    this.inFlight.set(key, started);
    return started;
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    // Hand the slot straight to the next waiter rather than decrementing and
    // letting it re-check, which would let a later arrival jump the queue.
    if (next) next();
    else this.active -= 1;
  }
}

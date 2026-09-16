/**
 * The updater's state and the words for it — the part of `updates.ts` with
 * no Electron in it, so it can be unit-tested with `node --test` like
 * `config.ts`. The tray line and the *Check for updates…* dialog text are
 * both here: the state machine decides what happened, this decides what it
 * is called.
 */

export type UpdateState =
  /** Nothing known yet: no check has finished since launch. */
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'downloading'; version: string; percent: number | null }
  /** Downloaded and staged. Applied on the next quit, or now via `restartToUpdate`. */
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

/** Once a day. The check itself is one small GET; the download only follows a new release. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * What the tray shows for the state, or null when there is nothing worth a
 * line (idle, or up to date — the absence of news is not news).
 */
export function updateStatusLine(state: UpdateState): string | null {
  switch (state.kind) {
    case 'idle':
    case 'up-to-date':
      return null;
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return state.percent === null
        ? `Downloading ${state.version}…`
        : `Downloading ${state.version}… ${Math.floor(state.percent)}%`;
    case 'ready':
      return `Update ready: ${state.version} — applied when you quit`;
    case 'error':
      return null; // logged; the tray is not the place for a stack trace
  }
}

/**
 * The sentence the *Check for updates…* dialog shows for the state the check
 * ended in. `current` is the running version.
 */
export function manualCheckMessage(state: UpdateState, current: string): { message: string; detail: string } {
  switch (state.kind) {
    case 'up-to-date':
    case 'idle':
      return { message: "You're up to date", detail: `MTG Library ${current} is the latest version.` };
    case 'checking':
      return { message: 'Checking for updates…', detail: 'The result will show in the menu.' };
    case 'downloading':
      return {
        message: `Downloading MTG Library ${state.version}`,
        detail: 'It downloads in the background and is applied when you next quit. The menu will offer Restart to update once it is ready.',
      };
    case 'ready':
      return {
        message: `MTG Library ${state.version} is ready`,
        detail: 'Choose Restart to update from the menu, or it is applied the next time you quit.',
      };
    case 'error':
      return { message: "Couldn't check for updates", detail: state.message };
  }
}

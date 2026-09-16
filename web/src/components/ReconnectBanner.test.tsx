import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ReconnectBanner } from './ReconnectBanner.tsx';
import { fetchStatus, probeHealth } from '../api.ts';
import { REACHABILITY_MESSAGE } from '../reachability.ts';

// The request path is the real one — a stubbed global fetch that throws is
// exactly what a browser does when nothing is listening — so the banner is
// raised the way it will be in the app, by api.ts, not by the test poking it.
vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  probeHealth: vi.fn(async () => false),
}));

const health = vi.mocked(probeHealth);

async function serverGoesAway() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
  try {
    await act(async () => { await fetchStatus().catch(() => undefined); });
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Lets the probe's promise chain settle under fake timers. */
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('ReconnectBanner', () => {
  beforeEach(() => { vi.useFakeTimers(); health.mockReset(); health.mockResolvedValue(false); });
  afterEach(() => { vi.useRealTimers(); });

  it('says nothing while the server answers', () => {
    render(<ReconnectBanner onReconnected={() => {}} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(health).not.toHaveBeenCalled();
  });

  it('is raised by a request that found nothing listening, worded for the way in, and clears on health', async () => {
    const onReconnected = vi.fn();
    render(<ReconnectBanner onReconnected={onReconnected} intervalMs={3000} />);

    await serverGoesAway();
    // jsdom's page lives at localhost — the desktop app's own window.
    expect(screen.getByRole('status')).toHaveTextContent(REACHABILITY_MESSAGE.local);
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');

    // Still down after one poll: the banner stays and nothing refetches.
    await act(async () => { vi.advanceTimersByTime(3000); });
    await flush();
    expect(health).toHaveBeenCalledTimes(1);
    expect(onReconnected).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeInTheDocument();

    // Back: one refetch, banner gone, polling stops.
    health.mockResolvedValue(true);
    await act(async () => { vi.advanceTimersByTime(3000); });
    await flush();
    expect(onReconnected).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(9000); });
    expect(health).toHaveBeenCalledTimes(2);
  });

  it('polls at once when the tab becomes visible or the browser says online', async () => {
    const onReconnected = vi.fn();
    render(<ReconnectBanner onReconnected={onReconnected} intervalMs={60_000} />);
    await serverGoesAway();
    expect(health).not.toHaveBeenCalled();

    // Switching back to the app, long before the interval would have fired.
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(health).toHaveBeenCalledTimes(1);

    health.mockResolvedValue(true);
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await flush();
    expect(health).toHaveBeenCalledTimes(2);
    expect(onReconnected).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a second failure while already down does not stack a second banner', async () => {
    render(<ReconnectBanner onReconnected={() => {}} />);
    await serverGoesAway();
    await serverGoesAway();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});

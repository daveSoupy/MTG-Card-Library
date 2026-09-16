import { useCallback, useEffect, useRef, useState } from 'react';
import { onServerUnreachable, probeHealth } from '../api.ts';
import { reconnectMessage } from '../reachability.ts';

/**
 * The one thing the app says when the server does not answer (Phase 31).
 *
 * Raised by any request that found the server unreachable — `api.ts` reports
 * every such failure here, so no page has to — and worded by how the page
 * was reached (`reachability.ts`): a phone on a Tailscale address is told to
 * turn Tailscale on, one on the home wifi to get back on it. While it is up
 * it polls `GET /api/v1/health` every few seconds, and at once on the
 * browser's `online` event and on the tab becoming visible — the moment
 * someone flips the VPN on and switches back to the app. `online` alone is
 * not a signal: a phone on cellular is "online" while the tailnet address is
 * unreachable, so polling is the mechanism and the events only bring the next
 * poll forward.
 *
 * When health answers, the banner clears and `onReconnected` fires so the
 * page refetches what it was showing. No reload, and nothing was cached or
 * queued meanwhile: a write that failed stays failed and said so where it
 * happened (`CONNECTIVITY_MESSAGE`). That is the no-offline rule, kept.
 */
export function ReconnectBanner({
  onReconnected,
  intervalMs = 3000,
}: {
  onReconnected: () => void;
  intervalMs?: number;
}) {
  const [down, setDown] = useState(false);
  // One probe in flight at a time: an early poll from `visibilitychange`
  // landing while the interval's is still out would otherwise fire
  // onReconnected twice for one recovery.
  const probing = useRef(false);
  const reconnected = useRef(onReconnected);
  reconnected.current = onReconnected;

  useEffect(() => onServerUnreachable(() => setDown(true)), []);

  const probe = useCallback(async () => {
    if (probing.current) return;
    probing.current = true;
    try {
      if (await probeHealth()) {
        setDown(false);
        reconnected.current();
      }
    } finally {
      probing.current = false;
    }
  }, []);

  useEffect(() => {
    if (!down) return;
    const timer = setInterval(probe, intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') void probe(); };
    window.addEventListener('online', probe);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', probe);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [down, intervalMs, probe]);

  if (!down) return null;

  return (
    <div className="reconnect-banner" role="status" aria-live="polite">
      <span className="reconnect-message">{reconnectMessage(window.location.hostname)}</span>
      <span className="reconnect-state">Reconnecting…</span>
    </div>
  );
}

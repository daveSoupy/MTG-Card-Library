import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acknowledgeAlert, acknowledgeAllAlerts, fetchAlerts, resolveAlert, resolveAllAlerts, type Alert,
} from '../api.ts';
import { alertKindLabel, alertRoute, groupByKind } from '../alerts.ts';
import type { Route } from '../router.ts';

/**
 * The in-app alert inbox in the topbar — price targets hit, wants fulfilled,
 * deck claims reduced, trade-list quantities clamped. Single-user, so there is
 * nowhere to push; this is where those events land.
 */
export function AlertsBell({
  refreshKey,
  onNavigate,
}: {
  refreshKey?: number;
  /** Takes the user to what an alert is about (a card in Browse, a want list…). */
  onNavigate?: (route: Route) => void;
}) {
  // Active = unread; recent = ones you've marked "Seen" and can still look back
  // at until you dismiss them for good.
  const [active, setActive] = useState<Alert[]>([]);
  const [recent, setRecent] = useState<Alert[]>([]);
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on a tap/click anywhere outside — works on touch, where the desktop
  // mouse-leave never fires (and the panel is a bottom sheet on a phone).
  useEffect(() => {
    if (!open) return;
    const onDown = (event: Event) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const load = useCallback(() => {
    fetchAlerts('active').then((r) => { setActive(r.alerts); setCount(r.activeCount); }).catch(() => {});
    fetchAlerts('acknowledged').then((r) => setRecent(r.alerts)).catch(() => {});
  }, []);

  useEffect(load, [load, refreshKey]);
  /**
   * A slow poll so a price-sync alert appears without a manual refresh —
   * paused while the tab is hidden.
   *
   * This component lives in the topbar, so it is mounted on every page for the
   * whole session, and it issues two requests each tick. Without the
   * visibility gate a backgrounded phone tab woke the radio every 60 seconds
   * for as long as the app stayed open, which is a battery cost paid for
   * nothing — nobody is looking at the bell.
   *
   * Reloading once on reveal is what makes pausing free: the poll exists so
   * the count is current when you glance at it, and a glance is a reveal.
   * ReconnectBanner.tsx uses the same shape.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) timer = setInterval(load, 60_000);
    };
    const stop = () => {
      if (timer !== null) { clearInterval(timer); timer = null; }
    };
    const onVisibility = () => {
      if (document.hidden) { stop(); return; }
      load();
      start();
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  // "Seen" keeps it: moves the alert from unread into the recent history.
  const markSeen = async (alert: Alert) => {
    const r = await acknowledgeAlert(alert.id);
    setActive((prev) => prev.filter((a) => a.id !== alert.id));
    setRecent((prev) => [{ ...alert, state: 'acknowledged' }, ...prev]);
    setCount(r.activeCount);
  };
  // "Dismiss" clears it for good, from wherever it sits.
  const dismiss = async (alert: Alert) => {
    const r = await resolveAlert(alert.id);
    setActive((prev) => prev.filter((a) => a.id !== alert.id));
    setRecent((prev) => prev.filter((a) => a.id !== alert.id));
    setCount(r.activeCount);
  };

  const markAllSeen = async (kind?: string) => {
    setBusy(true);
    try {
      await acknowledgeAllAlerts(kind);
      load();
    } finally {
      setBusy(false);
    }
  };
  const dismissAll = async (kind?: string) => {
    setBusy(true);
    try {
      await resolveAllAlerts(kind);
      load();
    } finally {
      setBusy(false);
    }
  };

  const go = (alert: Alert) => {
    const route = alertRoute(alert);
    if (!route || !onNavigate) return;
    onNavigate(route);
    setOpen(false);
  };

  const activeGroups = groupByKind(active);

  return (
    <div className="alerts-bell" ref={ref}>
      <button className="btn secondary" onClick={() => { setOpen((v) => !v); load(); }} title="Alerts" aria-label="Alerts">
        🔔{count > 0 && <span className="alert-count">{count}</span>}
      </button>
      {open && (
        <div className="alerts-drop">
          <div className="alerts-drop-head">
            <span>Alerts</span>
            <button className="btn secondary small" onClick={() => setOpen(false)}>Close</button>
          </div>
          {active.length === 0 && recent.length === 0 && <p className="empty">No alerts.</p>}

          {active.length > 0 && (
            <>
              <p className="alerts-legend">
                <strong>Seen</strong> keeps it below, in Recent, until you dismiss it.
                {' '}<strong>Dismiss</strong> clears it for good.
              </p>
              <div className="alert-actions bulk">
                <button className="btn secondary small" disabled={busy} onClick={() => markAllSeen()}>
                  Mark all seen
                </button>
                <button className="btn secondary small" disabled={busy} onClick={() => dismissAll()}>
                  Dismiss all
                </button>
              </div>
            </>
          )}

          {activeGroups.map(({ kind, alerts: group }) => (
            <div key={kind} className="alerts-group">
              <div className="alerts-group-head">
                <span>{alertKindLabel(kind)}</span>
                {group.length > 1 && (
                  <div className="alert-actions">
                    <button className="btn secondary small" disabled={busy} onClick={() => markAllSeen(kind)}>
                      Seen ({group.length})
                    </button>
                    <button className="btn secondary small" disabled={busy} onClick={() => dismissAll(kind)}>
                      Dismiss ({group.length})
                    </button>
                  </div>
                )}
              </div>
              {group.map((a) => {
                const route = alertRoute(a);
                return (
                  <div className="alert-item" key={a.id}>
                    <div className="alert-text">
                      {route && onNavigate ? (
                        <button type="button" className="linkish alert-title" onClick={() => go(a)}>
                          {a.title}
                        </button>
                      ) : (
                        <strong>{a.title}</strong>
                      )}
                      {a.message && <span>{a.message}</span>}
                    </div>
                    <div className="alert-actions">
                      <button className="btn secondary small" onClick={() => markSeen(a)}>Seen</button>
                      <button className="btn secondary small" onClick={() => dismiss(a)}>Dismiss</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {recent.length > 0 && (
            <>
              <div className="alerts-recent-label">Recent · seen</div>
              {recent.slice(0, 20).map((a) => {
                const route = alertRoute(a);
                return (
                  <div className="alert-item recent" key={a.id}>
                    <div className="alert-text">
                      {route && onNavigate ? (
                        <button type="button" className="linkish alert-title" onClick={() => go(a)}>
                          {a.title}
                        </button>
                      ) : (
                        <strong>{a.title}</strong>
                      )}
                      {a.message && <span>{a.message}</span>}
                    </div>
                    <div className="alert-actions">
                      <button className="btn secondary small" onClick={() => dismiss(a)}>Dismiss</button>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

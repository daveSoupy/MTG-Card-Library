import { useCallback, useEffect, useState } from 'react';
import { acknowledgeAlert, fetchAlerts, resolveAlert, type Alert } from '../api.ts';

/**
 * The in-app alert inbox in the topbar — price targets hit, wants fulfilled,
 * deck claims reduced, trade-list quantities clamped. Single-user, so there is
 * nowhere to push; this is where those events land.
 */
export function AlertsBell({ refreshKey }: { refreshKey?: number }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    fetchAlerts('active').then((r) => { setAlerts(r.alerts); setCount(r.activeCount); }).catch(() => {});
  }, []);

  useEffect(load, [load, refreshKey]);
  // A slow poll so a price-sync alert appears without a manual refresh.
  useEffect(() => {
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (id: number, fn: (id: number) => Promise<{ activeCount: number }>) => {
    const r = await fn(id);
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    setCount(r.activeCount);
  };

  return (
    <div className="alerts-bell">
      <button className="btn secondary" onClick={() => { setOpen((v) => !v); load(); }} title="Alerts" aria-label="Alerts">
        🔔{count > 0 && <span className="alert-count">{count}</span>}
      </button>
      {open && (
        <div className="alerts-drop" onMouseLeave={() => setOpen(false)}>
          {alerts.length === 0 && <p className="empty">No active alerts.</p>}
          {alerts.map((a) => (
            <div className="alert-item" key={a.id}>
              <div className="alert-text">
                <strong>{a.title}</strong>
                {a.message && <span>{a.message}</span>}
              </div>
              <div className="alert-actions">
                <button className="btn secondary small" onClick={() => act(a.id, acknowledgeAlert)}>Seen</button>
                <button className="btn secondary small" onClick={() => act(a.id, resolveAlert)}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

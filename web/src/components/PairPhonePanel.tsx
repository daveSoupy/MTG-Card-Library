import { useEffect, useMemo, useRef, useState } from 'react';
import { encode } from 'uqr';
import { fetchInstance, type InstanceInfo } from '../api.ts';
import { classifyHost } from '../reachability.ts';
import { pairingTarget, pairingUrl, type PageOrigin } from '../pairing.ts';

/**
 * Phase 33. One QR code that opens this library on a phone.
 *
 * The code is a plain `http://` link to the server's home-network address
 * (`pairing.ts` builds it), so the phone's camera opens it in the browser
 * with nothing installed, and *Add to Home Screen* follows (Phase 31). It
 * renders only while the server has an address other devices can reach —
 * `GET /api/v1/instance` returns none on a loopback bind — and otherwise
 * says which toggle turns that on. There is never a public address to show,
 * because there is none.
 *
 * `#pair` on the Data page's URL (the desktop app's tray item sends it)
 * scrolls this panel into view. That is the only fragment the web client
 * acts on; `#pair=<record>` from a scanned QR is ignored, as it should be.
 */

/** The id the tray's "Pair a phone…" item navigates to. */
export const PAIR_PANEL_ID = 'pair';

/** Quiet-zone modules around the code, per the QR spec's minimum of 4. */
const QUIET_ZONE = 4;

/**
 * The QR as inline SVG: one path of unit squares on a white field. Black on
 * white whatever the theme — inverted codes scan unreliably, and a phone
 * camera is not a place to be tasteful. `crispEdges` keeps the modules from
 * blurring at fractional scales.
 */
function QrCode({ text }: { text: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: QUIET_ZONE });
    let d = '';
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { size: qr.size, path: d };
  }, [text]);
  return (
    <svg
      className="pair-qr"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code that opens MTG Library on a phone"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

export function PairPhonePanel() {
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchInstance(controller.signal)
      .then(setInfo)
      .catch((cause: Error) => { if (cause.name !== 'AbortError') setError(cause.message); });
    return () => controller.abort();
  }, []);

  // Sent here by the tray. After the fetch, so the panel has its height; and
  // again on a hash change, for the tray item pressed while already on this page.
  useEffect(() => {
    const reveal = () => {
      if (window.location.hash === `#${PAIR_PANEL_ID}`) {
        section.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    };
    if (info) reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, [info]);

  // Where this page was reached: a home-network address here is the QR's
  // target ahead of anything the server lists (pairing.ts says why).
  const page: PageOrigin = { hostname: window.location.hostname, port: window.location.port };
  const url = info ? pairingUrl(info, page) : null;
  const target = info ? pairingTarget(info, page) : null;
  // The page itself is inside the desktop app's window when it was reached
  // on loopback; the toggle is then in this machine's menu bar or tray.
  const inDesktopWindow = classifyHost(page.hostname) === 'local';

  return (
    <section className="data-section" id={PAIR_PANEL_ID} ref={section}>
      <h3>Pair a phone</h3>
      {error && <div className="error">{error}</div>}
      {info && url === null && (
        <p className="hint">
          Sharing is off, so there is no address for a phone to open.
          {inDesktopWindow
            ? ' Turn on Allow other devices on this network in the MTG Library menu-bar or tray menu, then come back here.'
            : ' The server is bound to this machine only; start it with MTG_HOST set to its network address (the systemd unit and Docker Compose file both do) and reload this page.'}
        </p>
      )}
      {info && url !== null && target !== null && (
        <>
          <p className="hint">
            Point your phone's camera at this while it is on the same wifi. It opens the app in
            the phone's browser — nothing to install.
          </p>
          <div className="pair-layout">
            <QrCode text={url} />
            <div className="pair-details">
              <div className="pair-addresses">
                <span className="dim">Opens</span>
                <span className="mono">http://{target.host}:{target.port}/</span>
                {info.addresses.filter((a) => a !== target.host).map((address) => (
                  <span className="mono dim" key={address}>
                    http://{address.includes(':') ? `[${address}]` : address}:{info.port}/
                  </span>
                ))}
                <span className="mono dim">http://{info.mdnsName}:{info.port}/</span>
              </div>
              <p className="hint">
                Every address this computer answers on, for a phone that can use one the camera did
                not. The <span className="mono">.local</span> name works on an iPhone; Android
                browsers usually need an address.
              </p>
            </div>
          </div>
          <p className="hint pair-cta">
            On your phone, open this and choose <strong>Add to Home Screen</strong>. If the
            computer's address changes later, scan the code again.
          </p>
        </>
      )}
    </section>
  );
}

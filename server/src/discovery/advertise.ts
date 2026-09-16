import Bonjour from 'bonjour-service';
import { SERVICE_TYPE, isLoopbackHost, type InstanceInfo } from './instance.ts';

/**
 * Phase 33. The DNS-SD advertisement: `_mtglibrary._tcp` on the local link,
 * TXT `id=<instanceId>` and `v=<version>`, the port as bound, and the
 * hostname `mtg-library-<first 4 of id>.local` so a phone that browses for
 * the service and filters on `id` finds this library after the router hands
 * it a new address. Pure JS (`bonjour-service` over `multicast-dns`, plain
 * `dgram`): nothing native, nothing to rebuild, and the same code on macOS,
 * Windows and Linux.
 *
 * Whether to advertise is decided by `advertiseDecision`, kept separate and
 * pure so the gate has a test — the flag alone is not enough, because a
 * loopback bind has nothing to advertise. `index.ts` calls the two in order.
 */

export type AdvertiseDecision = 'advertise' | 'off' | 'loopback';

/**
 * `off` when `MTG_ADVERTISE` is not set; `loopback` when it is set but the
 * bind is one nobody else can reach (the desktop app with sharing off sets
 * neither, so this is the systemd-with-the-wrong-host case, and worth a log
 * line rather than silence); `advertise` otherwise.
 */
export function advertiseDecision(flag: boolean, host: string): AdvertiseDecision {
  if (!flag) return 'off';
  if (isLoopbackHost(host)) return 'loopback';
  return 'advertise';
}

export interface Advertisement {
  /** Sends the goodbye packets and closes the multicast socket. Idempotent. */
  stop(): Promise<void>;
}

export interface AdvertiseLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Starts advertising `info` and returns a handle to stop it. Errors from the
 * multicast socket (no network, a firewall that drops multicast, a container
 * without host networking) are logged and swallowed: the server's job is to
 * answer HTTP, and the QR's address list still works without discovery.
 */
export function startAdvertisement(info: InstanceInfo, log: AdvertiseLogger): Advertisement {
  const bonjour = new Bonjour({}, (error: Error) => {
    log.warn(`mDNS advertisement error: ${error.message}`);
  });
  const short = info.mdnsName.replace(/^mtg-library-|\.local$/g, '');
  bonjour.publish({
    // The instance name shown in a Bonjour browser. The id suffix keeps two
    // libraries on one machine (the desktop app beside a dev server, say)
    // from probing each other into a rename.
    name: `MTG Library on ${info.name} (${short})`,
    type: SERVICE_TYPE,
    port: info.port,
    host: info.mdnsName,
    txt: { id: info.instanceId, v: info.version },
  });
  log.info(`Advertising _${SERVICE_TYPE}._tcp as ${info.mdnsName} on port ${info.port}.`);

  let stopped: Promise<void> | null = null;
  return {
    stop() {
      if (stopped) return stopped;
      stopped = new Promise<void>((resolve) => {
        bonjour.unpublishAll(() => bonjour.destroy(() => resolve()));
      });
      return stopped;
    },
  };
}

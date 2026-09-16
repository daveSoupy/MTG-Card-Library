# Phase 33 — Pairing and LAN Discovery

> **Shipped 2026-09-16.** Built as written, with these decisions made at build time:
>
> - **The QR's host is the address the page was reached on, when that is a home-network IPv4** — ahead of the server's own list, which is what the doc's "first IPv4 entry in `addresses`" becomes when the panel is opened from a device on the wifi. Found by verification item 7: under Docker's default bridge network the server can only report the container's `172.17.0.2:8080`, so a QR built from the list alone opened an address no phone can reach, while the browser showing the panel had just proved `192.168.x.x:8080` works. The desktop app's own window (loopback), a Tailscale address, a `.local` name or an IPv6 page fall back to the list; the record's `addresses` puts the target first and its `port` is the one that answered. `web/src/pairing.ts` is both halves of the contract and is pure-tested. This means the compose file's advice for a Docker host is "open the Data page at the computer's network address, not `localhost`".
> - **`instance_id` is get-or-create, not create-once.** A restore replaces `app_settings` wholesale, so a backup taken before this phase would otherwise leave the endpoint with no id until the next restart. A backup taken after it carries the id, deliberately: a library moved to a new machine is still the library the phone paired with.
> - **`bonjour-service`, not `@homebridge/ciao`.** Both are pure JS; ciao registers `source-map-support` process-wide on import, a side effect the server should not pick up. `multicast-dns` underneath joins every IPv4 interface and sends on the default one, which is a home network. Two libraries on one machine (the desktop app beside a dev server) were seen advertising side by side without a rename.
> - **`GET /api/v1/instance`'s `name` is the OS hostname less the `.local` macOS appends**, and the Bonjour instance name is `MTG Library on <name> (<first 4 of id>)`.
> - **The address list is LAN-first**: RFC 1918 IPv4, then other IPv4 (Tailscale's CGNAT range), then routable IPv6; never link-local. A wildcard `0.0.0.0` bind lists IPv4 only, because that is what it binds.
> - **The tray's *Pair a phone…* loads `/data#pair`**; the panel scrolls itself into view on that fragment (and on `hashchange`, for the item pressed while already on the page). `#pair=<record>` from a scanned QR is ignored, as specified. The shell sets `MTG_ADVERTISE` exactly when its sharing toggle is on; `desktop/scripts/verify-lifecycle.mjs` now checks the advertisement follows the toggle with `dns-sd`.
> - Verification items 1–3 and 7 walked in-session (7 on Docker Desktop for the endpoint half; its multicast half needs a Linux host, as the compose comment now says). The phone-camera scan in item 3 is the user's to do. Items 4–6 are the parked companion app's.

A phone finds the server on the home network by scanning one QR code, once, and keeps finding it after the router hands out a new address, after the server moves to a new machine's port, and after months of nobody thinking about it. No accounts, no dynamic DNS, no VPN, nothing outside the house.

This is the link Phase 36's companion app (parked) would sync over, and it serves the plain web client today: a scanned QR opens the app in the phone's browser, ready for *Add to Home Screen* (Phase 31). Works for any server — the Phase 32 desktop app, the systemd install, or Docker with host networking.

## Why the home network is enough

Every way of reaching the server from *outside* the house puts something the user does not control into the path — the ISP's NAT type, a router's UPnP setting, a vendor's control plane, a certificate lifetime — and each of those is a thing that changes without warning and breaks the workflow months later. The home network has one dependency: the phone comes home. Phase 36 makes that sufficient by carrying a snapshot and a write queue for the hours it is away; this phase makes the daily reconnection automatic.

Live access from away stays what it is today: `deploy/README.md`'s "put it behind Tailscale yourself." Nothing in the app depends on it.

## Two halves

**The server advertises.** A stable identity and an mDNS/DNS-SD service record.

**The phone discovers.** Given the identity from a QR, it finds the current address by service discovery, falling back to the last address that worked.

Neither half is authentication — see *Trust model* below before assuming otherwise.

## Server: instance identity

`db/index.ts` writes an `instance_id` (UUID) into `app_settings` on first open if absent, via `setSetting` directly. It is not user-editable and does not go through the settings route's allowlists — those gate what the *route* accepts, and this key is never accepted there. Read it back with `getSetting`.

New endpoint:

```
GET /api/v1/instance
→ { instanceId, name, version, port, addresses: ["192.168.1.20", ...], mdnsName: "mtg-library-XXXX.local" }
```

`name` is the OS hostname; `addresses` are the non-loopback IPv4/IPv6 addresses the server is bound on (empty when `MTG_HOST` is `127.0.0.1`, which the UI reads as "sharing is off"); `version` is the server's package version, which the phone app uses for the skew contract in Phase 36. Nothing reads that version today: add `resolveServerVersion()` beside the other resolvers in `config.ts`, reading `server/package.json` through the same walk-up `db/index.ts` uses for `schema.sql`. Phase 35 shares that one function rather than reading the file again.

## Server: advertisement

A DNS-SD service `_mtglibrary._tcp` on the local link, TXT record `id=<instanceId>`, `v=<version>`, port as bound, hostname `mtg-library-<first 4 of instanceId>.local` so two libraries on one network never collide. Pure-JS implementation (`bonjour-service` or `@homebridge/ciao`); no native dependency, nothing to rebuild.

Enabled by `MTG_ADVERTISE=1` (`config.ts`), which the Phase 32 shell sets whenever *Allow other devices on this network* is on, and which `deploy/mtg-library.service` can set for a systemd install. Off by default, and always off when bound to loopback: advertising an address nobody can reach is noise. Docker needs `network_mode: host` for multicast to leave the container; `docker-compose.yml` gets a commented line, not a default.

## The QR code

Rendered client-side (a small QR library in `web/`) on a *Pair a phone* panel in `DataPage.tsx`, and reachable from the Phase 32 tray menu. Its content is a URL, so the phone's ordinary camera opens it with no app installed:

```
http://192.168.1.20:8080/#pair=<base64url JSON>
```

where the JSON is `{ "v": 1, "id": "<instanceId>", "mdns": "mtg-library-XXXX.local", "port": 8080, "addresses": [...] }`. The web client ignores the fragment (it is not a route in `router.ts`) and just loads — so a phone without the companion app lands in the web app, and *Add to Home Screen* follows. The companion app registers the same URL pattern and reads the fragment as its pairing record.

The URL's host is the first IPv4 entry in `addresses` — an address, never the `.local` name, because Android browsers often cannot resolve one and the QR has to work from a camera app with nothing installed. Beneath the QR the panel prints every address and the `.local` name as text, for the phone that can use one the camera did not.

The panel shows the QR only while sharing is on; otherwise it explains the toggle. It never shows a public address, because there isn't one.

Two lines this phase owes Phase 31, which shipped before there was a QR: the panel ends with *On your phone, open this and choose Add to Home Screen*, and the home-wifi reconnect message in `web/src/reachability.ts` gains its final clause, *scan the QR code on it again* (update its unit test).

## Phone: discovery order

Owned by the companion app (Phase 36), specified here so both halves agree:

1. **Last address that worked**, tried first because it is usually still right and needs no multicast.
2. **DNS-SD browse** for `_mtglibrary._tcp` filtered to `id=<paired instanceId>`. The only step that survives an address change. iOS resolves this natively; Android through `NsdManager`; both behind one small plugin.
3. **The `.local` name** from the pairing record, for the case where browsing is blocked but unicast `.local` resolution works.
4. **Every address in the pairing record**, in order.

Any hit is verified by `GET /api/v1/instance` and comparing `instanceId` — a different library on the same address (a reinstalled server, a roommate's) is *not paired*, and the phone says so rather than syncing into the wrong database. A successful hit rewrites step 1.

The whole sequence runs on app foreground and before each background sync, budgeted at a few seconds; "not found" means the phone is not at home, and Phase 36 switches to shop mode.

## Trust model — read before adding a token

Turning sharing on makes the app reachable by every device on the home wifi, with no login. That is the same trust model the app has always had — a private network is the perimeter — on a different private network. The pairing record is discovery, not a credential: it lets a phone *find* the server, it does not gate anything, and a token only the companion app sends while the browser walks in freely would be theatre.

If a real gate is ever wanted (a shared house, a guest network that is not isolated), it is the token header CLAUDE.md anticipates, applied to every route including the web client's, and it is its own phase. This one deliberately does not start down that road.

## Verification

Items 1–3 and 7 are this phase's. Items 4–6 exercise the companion app and are not run while it is parked; they stay here because they are the discovery contract's acceptance tests.

1. `GET /api/v1/instance` returns a stable `instanceId` across restarts and a fresh one on a new data directory.
2. With `MTG_ADVERTISE=1` and a LAN bind, `dns-sd -B _mtglibrary._tcp` (macOS) or `avahi-browse` (Linux) lists the service with the right TXT `id`; with loopback bind or the flag off, nothing is advertised.
3. The QR opens the web app in a phone browser with no companion app installed; the fragment breaks nothing (no route error, no console error).
4. Companion app paired, router reassigns the server's IP (or the server moves to a different port): the phone reconnects via step 2 without user action, and the pairing record's stored address updates.
5. Two servers on one network advertise distinct hostnames; the phone syncs only with the paired `instanceId` and refuses the other with a clear message.
6. Multicast blocked (simulate with the browse step disabled): steps 3–4 still find an unchanged address; a changed one fails cleanly into shop mode rather than hanging.
7. `docker-compose` with `network_mode: host` advertises; without it, the instance endpoint still works over a direct address, which the QR's address list covers.

## Out of scope

- Any reachability from outside the home network, automatic port mapping, relays, or embedded VPNs. Considered and rejected: each one moves a failure mode the user cannot fix into the default path.
- Authentication (see *Trust model*).
- A user-editable instance name. The hostname is enough to tell two apart; a string setting would need a fourth allowlist kind in `settings.ts` for a name nobody will change.

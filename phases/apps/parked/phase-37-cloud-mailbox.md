# Phase 37 — Cloud Mailbox (optional)

> **Parked with Phase 36.** A second transport for an app that is not being built.

A second transport for the companion app, for the household where the desktop and the phone are never home at the same time. A folder in the user's own cloud storage — iCloud Drive, Dropbox, Google Drive, OneDrive, Syncthing, whatever they already have — carries snapshots one way and the write queue the other. Each side talks to the folder on its own schedule.

**Optional, and never the only path.** Phase 36's LAN sync must work with this off, and a user who never sets it up loses nothing. Build it only once Phases 31, 32 and 36 are shipped and someone actually hits the gap it closes.

## What it is, and is not

It is a **mailbox, not a database**. The design stays single-writer: the desktop owns the rules and the data; the phone reads snapshots and appends queued inserts. The folder is a different pipe for the same two streams Phase 36 already defines, so it reopens nothing about conflict resolution.

It does not make the desktop run. A queue in the folder is applied when the server next starts, and not before. The thing this phase changes is *when the two devices must coincide* — never — not whether the desktop has to be on.

It is not encrypted in this version. The folder holds collection, deck and want-list data readable by whoever can read the folder, which includes the cloud provider. The enable screen says so in one sentence.

## The folder protocol

```
<chosen folder>/
  mailbox.json                      desktop writes once: { "v": 1, "instanceId": "…" }
  snapshots/<generatedAt>-<rand>.json.gz     desktop writes; phone reads the newest
  queue/<uuid>.json                 phone writes; desktop reads, applies, deletes
  results/<uuid>.json               desktop writes the outcome; phone reads, deletes
```

Three rules keep a file-sync service from ever producing a *"(conflicted copy)"*:

1. **Every file is written once and never modified.** New content is a new file with a new name.
2. **Each side writes only in its own directories** — desktop: `mailbox.json`, `snapshots/`, `results/`; phone: `queue/`. Nothing is ever co-edited.
3. **The consumer deletes.** The desktop deletes a queue file after applying it; the phone deletes a result after showing it; the desktop prunes its own snapshots to the newest three.

Anything not matching the naming pattern (a sync client's conflict sibling, a `.DS_Store`) is ignored and logged once, never processed.

`mailbox.json` binds the folder to one library. `instance_id` lives in `app_settings` (Phase 32), so it survives a backup restore onto a new machine and the folder keeps working; a *different* library pointed at the same folder refuses it with a clear message rather than draining someone else's queue. A phone checks the same id against its pairing record before touching anything.

## Desktop side: the server, not the shell

`server/src/mailbox/`, enabled by `MTG_MAILBOX_DIR` (`config.ts`). The Phase 31 shell exposes it as *Sync through a cloud folder…* with a folder picker; a systemd install sets the variable. Nothing here is Electron-specific.

- **`publisher.ts`** writes a snapshot when the data has changed. "Changed" is a write counter bumped by a Fastify `onResponse` hook for any successful non-GET under `/api/v1` — one central place, no per-store instrumentation. Debounced: at most one snapshot per ten minutes, plus one at boot. The document is the same `GET /api/v1/snapshot` body Phase 36 defines; this phase adds no second format.
- **`consumer.ts`** polls `queue/` every thirty seconds and at boot (`fs.watch` is not reliable across sync clients, which write files in stages). Queue files are applied in `(createdAt, seq)` order by **injecting the request into the server's own routes** (`app.inject`) with the file's `Idempotency-Key` — the consumer is a client of its own server, so Phase 36's idempotency `preHandler`, `conflictMode: 'alert'` and alert rows all apply unchanged, and routes still hold no rules. The response status and body are written to `results/<uuid>.json`; then, and only then, the queue file is deleted. A crash between the two leaves a queue file that replays to a stored response next time, which is what the idempotency table is for.
- **Unavailable folder** (drive unmounted, iCloud not signed in): log once, keep serving, retry on the next poll. Never a startup failure.

## Phone side

The companion app gains a folder in its sync sequence, tried **after** LAN discovery fails (LAN is faster and delivers the snapshot fresh from the source):

1. Phase 32 discovery. Found → LAN sync as today, and skip the rest.
2. Mailbox reachable → upload any queue items not yet uploaded, read and show any results, download the newest snapshot if newer than the one held.

Same triggers as Phase 36's LAN sync — foreground, wifi join, background task, *Sync now*. The phone does not watch the folder; it checks it.

Access is through the platform's file provider: on iOS a security-scoped bookmark from the document picker, on Android a Storage Access Framework tree URI. One small plugin. iCloud Drive in particular hands out *dataless* placeholders that must be explicitly downloaded (`startDownloadingUbiquitousItem`) before reading; the plugin does that for the newest snapshot only. The per-provider quirks live in that plugin and nowhere else.

A queue item may reach the desktop twice — uploaded to the folder at the shop, then replayed over LAN at home before the consumer ran. The second is a replayed-key hit and returns the stored response; the phone treats either path's result as final and deletes the folder copy if it is still there.

Several phones against one folder work without special handling: queue and result files are per-UUID, and the desktop does not care who wrote them.

## Settings and UI

- Desktop: the folder path (shell config, passed as `MTG_MAILBOX_DIR`), *Last snapshot written*, *Queue items applied / failed*, a *Disable* that stops both jobs and leaves the folder alone.
- Phone: *Cloud folder* under pairing, showing the folder name and the age of the newest snapshot it found there. Distinct from *Last synced*, which stays LAN-or-mailbox whichever was later.
- Nothing new in `app_settings`; the folder path is per machine and lives with the process that uses it.

## Verification

1. With `MTG_MAILBOX_DIR` set and no phone, the server writes `mailbox.json` and a first snapshot at boot, another after a collection edit (within the debounce), and keeps only the newest three.
2. A queue file dropped into `queue/` by hand is applied, produces a `results/` file with the route's status and body, and is deleted — and produces the same `collection_disposals` and allocation result as the LAN replay in Phase 36's check 1.
3. The same queue file dropped twice (second copy under a new name, same `Idempotency-Key`) applies once; the second result carries the stored response.
4. Killing the server between writing a result and deleting the queue file leaves a file that, on restart, resolves to the stored response and is then deleted.
5. A folder whose `mailbox.json` carries a different `instanceId` is refused by the server (logged, nothing read or written) and by the phone (message, no upload).
6. A `(conflicted copy)` sibling and a stray file in `queue/` are ignored and logged once, not applied, not deleted.
7. Phone away from home, desktop on: a want added on the phone reaches the desktop through the folder without the phone ever joining the home network; the phone shows the result on its next check.
8. Desktop edits made while the phone is away appear on the phone from the folder snapshot; on returning home, the LAN sync supersedes it and the *Last synced* age drops accordingly.
9. Folder unmounted mid-run: the server keeps serving, logs once, resumes on remount without restart.
10. With the folder disabled on both sides, every Phase 36 check still passes unchanged.

## Out of scope

- CloudKit or any push-based provider. Real background wake on iOS is only available there, and it is Apple-only with a native module in the desktop app; it can be a later provider behind the same folder contract if the polling version proves too slow in practice.
- Encryption at rest in the folder.
- Making the folder the primary or only transport. LAN stays first for speed and freshness, and the folder must be removable without loss.
- Anything applied on the phone. The consumer runs on the desktop only; the phone never interprets a queue file, its own included.

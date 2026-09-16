# Phase 39 — Off-Site Backup

Push the scheduled backup somewhere that is not the machine running the server, on the same schedule, without anyone remembering to click. Two kinds of destination: a **folder a sync client already carries to the cloud** (iCloud Drive, Dropbox, Google Drive, OneDrive, Syncthing), and an **S3-compatible bucket** (S3, Backblaze B2, Cloudflare R2, Wasabi, MinIO). Both are off by default. Unsequenced; needs nothing after Phase 5.

## Why, and what it is not

Phase 5's scheduled backup guards against a bad import — the copies sit beside the database they copy, so a dead drive or a stolen laptop takes both. The downloaded file is the real backup, and it depends on a person. This phase makes the off-machine copy automatic, and gives a user two independent ways to have one.

It is **not** a sync layer. One server, one database; a backup file is written once, never read back by the server except for a restore the user asks for. Nothing about "one server, many clients" changes.

It is the **first feature that sends user data to a third party** in the default install path if turned on — the bucket target especially. So: off until configured, the enable screen says in one sentence that the provider can read what is uploaded, and encryption is offered (below).

## Already built — confirm, don't rebuild

- **The artifact.** `porting/backup.ts`'s `backupTo` — user tables only, a consistent WAL snapshot, a few hundred KB. This phase uploads *that file*, gzipped. No second format, no `VACUUM INTO`, no JSON export.
- **The clock.** `porting/schedule.ts` already decides when a backup is due and takes one. A cloud push is a step *after* a successful local backup, inside the same `runNow`, not a second timer with its own idea of "due". One backup a day is produced; every enabled target receives it.
- **Restore.** `restoreFrom` takes a path. Restoring from a target is: fetch to a temp file, gunzip, `restoreFrom`, same `RestoreReport` and the same confirm-and-reload flow on the Data page.
- **Alerts.** `alerts/store.ts` with `dedupeKey`. A failing target raises one alert and re-raises the same row, never a pile.
- **Settings allowlists.** `routes/settings.ts`'s `NUMBER_SETTINGS` / `BOOLEAN_SETTINGS` for the knobs that are not secrets.
- **The Data page.** `DataPage.tsx`'s Backup section — the new UI is a card below the existing scheduled list, not a new page.

## Where configuration lives, and why not in `app_settings`

A bucket target holds an access key and a secret. `app_settings` is in `USER_TABLES`, so anything written there ends up **inside the backup file, in the bucket it unlocks**. That is not acceptable.

Target configuration lives in **`MTG_DATA_DIR/backup-targets.json`**, mode `0600`, owned by the server, read at boot and rewritten whole on every change. It is deliberately outside the database and outside every backup: a restore onto a new machine does not carry another machine's credentials, and a backup file in a bucket never contains the key to that bucket. `porting/backup.ts`'s header comment gains one line saying so.

```jsonc
{
  "v": 1,
  "targets": [
    {
      "id": "b3f1…",                  // uuid, stable across edits
      "kind": "folder",
      "name": "iCloud Drive",           // user-facing label
      "enabled": true,
      "keep": 30,                       // per target; local stays at 7
      "path": "/Users/dave/Library/Mobile Documents/com~apple~CloudDocs/MTG Library",
      "state": { "lastSuccessAt": "…", "lastFailureAt": null, "lastError": null, "lastBytes": 412000 }
    },
    {
      "id": "…",
      "kind": "s3",
      "name": "Backblaze",
      "enabled": true,
      "keep": 30,
      "endpoint": "https://s3.us-west-004.backblazeb2.com",
      "region": "us-west-004",
      "bucket": "dave-mtg-backups",
      "prefix": "library/",
      "accessKeyId": "…",
      "secretAccessKey": "…",          // never returned by the API — see below
      "forcePathStyle": true,
      "state": { … }
    }
  ],
  "encryption": { "enabled": false }
}
```

The API returns the file with `secretAccessKey` and any passphrase **redacted to `"•••"`**; a `PUT` that sends `"•••"` back keeps the stored value. That is the whole secret-handling rule, and it is tested.

`MTG_BACKUP_TARGETS` (a path) overrides the file's location, for a Docker install that wants the file on a separate mount. Nothing else is configured by environment: the systemd host has a browser too.

## The target interface

`server/src/porting/targets/types.ts`:

```ts
interface BackupTarget {
  readonly id: string;
  readonly kind: 'folder' | 's3';
  /** Write `bytes` under `name`, atomically. Rejects if the name already exists. */
  put(name: string, bytes: Buffer): Promise<void>;
  /** Names matching the backup pattern, newest first, with sizes. */
  list(): Promise<Array<{ name: string; bytes: number; takenAt: string }>>;
  get(name: string): Promise<Buffer>;
  delete(name: string): Promise<void>;
  /** Writes and deletes a probe object; the enable screen's Test button. */
  probe(): Promise<void>;
}
```

Four operations and a probe. Everything the orchestrator does — push, prune, list, restore — is written once against this interface; a target is one file that implements it. A WebDAV target (Nextcloud) is a natural third and is **out of scope** here, but nothing above should make it more than one file when wanted.

File names are `library-<ISO stamp>.sqlite.gz`, the same stamp `schedule.ts` already produces, so the local and remote lists line up by eye. The name pattern is the *only* thing `list()` returns; a sync client's `.DS_Store` or `(conflicted copy)` sibling is ignored, logged once, never pruned, never offered for restore.

### `folder.ts`

`node:fs` against `path`, with `~` expanded. Phase 37's three rules, verbatim, because a sync client is watching:

1. **Written once, never modified.** Write to `.<name>.partial`, `fsync`, `rename` to `<name>`. Sync clients upload on close; a rename is one event, a partial file is never uploaded under its final name.
2. **Only this app writes here.** The folder is the target's own; nothing else of the user's is expected in it, and nothing outside the name pattern is touched.
3. **The producer prunes its own files** to `keep`, oldest first, after a successful put.

`probe()` checks the directory exists, is writable, and — on macOS — is not a dataless iCloud placeholder for the whole folder. It does **not** check that a sync client is running: the server cannot know, and a folder that is merely local is still a valid target (a second internal drive, a NAS mount). The enable screen says what a folder target does and does not guarantee.

**Detected folders.** `GET /api/v1/backup/targets/suggested-folders` probes a short constant list of well-known paths on the host — `~/Library/Mobile Documents/com~apple~CloudDocs`, `~/Dropbox`, `~/Google Drive`, `~/Library/CloudStorage/*`, `~/OneDrive`, `~/Sync` — and returns the ones that exist. A browser cannot show a folder picker for the server's disk; this is the substitute, and the desktop shell needs no picker of its own (desktop/CLAUDE.md: no Electron branches, no renderer code). The user can always paste a path.

### `s3.ts`

`PutObject`, `ListObjectsV2` (prefix, paginated), `GetObject`, `DeleteObject`, plus `HeadBucket` for the probe. **Signature Version 4, hand-signed with `node:crypto`** — it is ~150 lines against a published algorithm, and it keeps `server/package.json` free of an SDK that would triple the install for four verbs. Test the signer against AWS's published SigV4 test vectors (`get-vanilla`, `post-x-www-form-urlencoded`, and one with a query string), not against a live bucket. If the signer genuinely runs past ~250 lines with query-string canonicalisation, `@aws-sdk/client-s3` is the fallback — but say why in the commit.

- `forcePathStyle` default **true**: B2, R2 and MinIO all want it, and AWS accepts it.
- `put` sends `Content-MD5` and checks the returned `ETag` against the MD5 for a single-part upload; a mismatch is a failure, not a success with a warning. Files are small enough that multipart never applies — assert `bytes.length < 5 GiB` and throw if not, rather than implementing it.
- Timeouts: 60s per request, `AbortSignal.timeout`. No retries inside the target; the orchestrator's next scheduled run *is* the retry, and the alert is the signal in between.
- `fetch`, as everywhere else in the server. A descriptive `User-Agent`, as with Scryfall.

## The orchestrator

`server/src/porting/targets/cloud.ts`, `CloudBackup`:

- `pushLatest()` — gzip the newest local backup (`zlib.gzipSync`; SQLite compresses roughly 4:1), and for each **enabled** target in turn: `put`, then prune to `keep`, then record `state.lastSuccessAt` / `lastBytes` and **resolve** the target's alert if one is active. A failure records `lastFailureAt` / `lastError`, raises the alert, and **continues to the next target** — one bad bucket must not stop the iCloud copy.
- Encryption, when on, is applied to the gzipped bytes before any target sees them (below).
- `schedule.ts`'s `runNow` calls `pushLatest()` after `pruneBackups`. The push is `async` and the local backup is not; `runNow` stays synchronous for its callers and the push is fired with its own error handling (`void cloud.pushLatest().catch(log)`), so a hung endpoint never blocks the local backup or a request.
- `pushNow(targetId)` — the Data page's per-target button; same path, one target.
- `listRemote(targetId)`, `restoreFromRemote(targetId, name)` — fetch, decrypt if needed, gunzip, verify it is a SQLite file (`restoreFrom` already does this and throws `InvalidBackupError`), then `restoreFrom`.

A boot with an enabled target and no successful push in the last 24h pushes once, the same way `schedule.ts` takes a local backup on boot only if one is due — a server restarted ten times in a morning must not upload ten times.

## Encryption (in scope, last)

Optional, off by default: a passphrase in `backup-targets.json` (redacted like a secret), `scrypt` → 32-byte key, **AES-256-GCM**, one random 12-byte nonce per file, the salt and nonce in a small header, the auth tag at the end. File name gains `.enc`. `node:crypto` only.

The enable screen says the one thing that matters, in the user's direction: *lose this passphrase and every encrypted backup is unreadable, including by you*. There is no recovery. Restore of an `.enc` file prompts for the passphrase if the stored one fails or is absent (a new machine).

Build this after everything else works unencrypted. If the phase is running long, ship without it and leave the `.enc` naming and the header format specified here so it slots in.

## Schema

Next unused `user_version` at build time. One change:

- `alerts.kind` gains `'backup_failed'`. The column has a `CHECK`, so this is a rebuild of `alerts` in `migrations.ts` — the first migration to touch that table. Recreate its indexes identically; `migrations.test.ts` enforces it. `AlertKind` in `alerts/store.ts` gains the member.

Nothing else. Target state lives in the JSON file; there is no `backup_runs` table — the per-target `state` block and the server log are enough for a feature whose whole history is "did the last one work".

## Routes (`routes/porting.ts`, beside the existing backup routes)

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/v1/backup/targets` | The file, secrets redacted, `state` included. |
| `PUT` | `/api/v1/backup/targets` | Replace the whole file. Validates each target's shape by `kind` (route-level schema in `routes/schema.ts` style); `"•••"` keeps a stored secret. Rewrites the file atomically, reloads the orchestrator. |
| `POST` | `/api/v1/backup/targets/:id/test` | `probe()`. 200 or a 4xx with the provider's message verbatim — a wrong region or a bucket policy error is only fixable if the user can read it. |
| `POST` | `/api/v1/backup/targets/:id/push` | `pushNow`. Returns the target's new `state`. |
| `GET` | `/api/v1/backup/targets/:id/remote` | `listRemote`. |
| `POST` | `/api/v1/backup/targets/:id/restore` | `{ name, passphrase? }` → `RestoreReport`, same as `/backup/restore`. |
| `GET` | `/api/v1/backup/targets/suggested-folders` | Existing well-known sync folders on the host. |

Settings (`NUMBER_SETTINGS`): none new — `keep` is per target and lives with it. No new boolean either; "enabled" is per target.

## UI (`DataPage.tsx`, Backup section)

Below the scheduled-backups list, one card: **Off-site copies**.

- Empty state: one sentence on what it does, two buttons — *Add a synced folder*, *Add a bucket*.
- Per target, one row: name, kind, last success (relative, green) or last failure (relative, the error message, red), size, and three actions — *Back up now*, *Browse* (the remote list, each row restorable through the existing restore confirm), *Edit*.
- The add/edit form is a dialog. Folder: a path field with the suggested folders as one-click chips beneath it. Bucket: endpoint, region, bucket, prefix, key id, secret, path-style toggle. Both: name, enabled, keep. A **Test** button that calls probe and shows the result inline before Save is enabled for a new target.
- The provider-can-read-this sentence sits under the form, and the encryption toggle with its lose-the-passphrase sentence under that.
- A `backup_failed` alert in the inbox links to this card.
- Mobile: the same card, rows stack. Nothing here needs the phone layout's one-handed treatment; it is a settings screen.

Add a `?` topic to `helpTopics.tsx` (Phase 17's shell): what each target kind guarantees, that the local schedule still runs, that credentials are not in the backup.

## Docker and systemd

- `docker-compose.yml` gains a commented-out second volume for a folder target (`- /path/on/host/MTG Backups:/backups`) with a one-line note; the folder target then has `path: /backups`. `MTG_BACKUP_TARGETS` is documented in `deploy/README.md`'s variable table.
- The systemd unit needs nothing: the file is under `MTG_DATA_DIR`, which `mtg` already owns. `deploy/README.md`'s backup section gets a paragraph pointing at the Data page.
- The desktop app needs nothing. `MTG_DATA_DIR` is `<userData>/library`, the file lands there, the web client does the rest.

## Verification

Tests where testable; walk the rest.

1. **Secrets never leave.** `GET /backup/targets` on a file with a bucket target returns `secretAccessKey: "•••"`; a `PUT` echoing that value leaves the stored secret unchanged; a `PUT` with a new value replaces it. `backupTo`'s output contains no row from `backup-targets.json` (it is not a table — the test asserts the file is not under `USER_TABLES` and that the backup's `app_settings` holds no key containing `secret` or `passphrase`).
2. **Folder target, atomic.** `put` into a temp dir: at no observable point does `<name>` exist with a partial length; `.partial` is gone after; a second `put` with the same name rejects. `list` ignores a planted `library-x.sqlite.gz (conflicted copy)` and a `.DS_Store`. Prune to `keep=2` leaves the two newest.
3. **S3 signer.** AWS SigV4 test vectors pass. Against a mock `fetch`: `put` sends `Content-MD5` and rejects on an ETag mismatch; `list` follows `IsTruncated`/`NextContinuationToken`; a 403 surfaces the response body's `<Message>` verbatim.
4. **Orchestrator.** Two targets, the first throws: the second still receives the file, `state` is right on both, exactly one `backup_failed` alert exists with `dedupe_key = 'backup_failed:<id>'`; a following success resolves it. `pushLatest` with no enabled targets is a no-op and touches no file.
5. **Boot behaviour.** Starting the server with an enabled target whose `lastSuccessAt` is one hour old does not push; 25 hours old does.
6. **Restore round-trip.** Push to a folder target, restore from it via `/backup/targets/:id/restore`, `RestoreReport.totalRows` equals the source's; with encryption on, the `.enc` file restores with the right passphrase and fails with `InvalidBackupError` on the wrong one, with no partial restore.
7. **Schema.** `migrations.test.ts` passes with the `alerts` rebuild; `PRAGMA user_version` is the next unused number.
8. **Manual.** On the Mac: add the real iCloud Drive folder from a suggested-folder chip, Test, Save, Back up now; watch the file appear in Finder with the cloud icon. Turn wifi off, Back up now, see the alert; wifi on, Back up now, see it resolve. Add a real B2 or R2 bucket with a scoped key, same drill. Restore from the bucket onto a fresh `MTG_DATA_DIR` and confirm the collection is there after a sync.
9. **Docker.** Compose with the `/backups` mount; a folder target at `/backups` pushes; the file is on the host.

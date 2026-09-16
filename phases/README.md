# Phases

One design doc per feature. The folder you are in is the to-do list; the
subfolders are the record.

| Where | What |
|---|---|
| `phases/` (this level) | **Not yet built.** 12–16, 21, 38 and 39. Phase 18 (shareable decklists) is planned but has no doc yet. |
| `phases/shipped/` | **Built and in `main`.** 0–11, 17 and 22–27. Kept as written, with build-time annotations where the code diverged from the spec (25, 26 especially). |
| `phases/apps/` | The install/distribution track (31–34, plus parked 35–37). Has its own [README](apps/README.md) and [BUILD-BRIEF](apps/BUILD-BRIEF.md). |

## Not yet built

| Phase | Doc | Notes |
|---|---|---|
| 12 | [Price history & live pricing](phase-12-price-history-live-pricing.md) | |
| 13 | [Sales & event costs](phase-13-sales-event-costs.md) | |
| 14 | [Shopping cart export](phase-14-shopping-cart-export.md) | |
| 15 | [Theming](phase-15-theming.md) | |
| 16 | [OCR-assisted entry](phase-16-ocr-assisted-entry.md) | Optional — only if explicitly requested. |
| 18 | — | Shareable decklists. Not spec'd. Must be an exported artifact, never a public URL (the server is never exposed). |
| 21 | [Known players](phase-21-known-players.md) | Capstone — after everything else. |
| 38 | [Precon import](phase-38-precon-import.md) | Whole preconstructed products into the collection, from MTGJSON (Scryfall has no decklists). Unsequenced. |
| 39 | [Off-site backup](phase-39-cloud-backup.md) | The scheduled backup pushed to a synced cloud folder and/or an S3-compatible bucket, off by default; credentials outside the database so they are never inside the backup they unlock. Unsequenced. |

Phases 12–21 were written before Phase 22 made the allocation claim derived.
Anything in them that computes availability or assumes every deck reserves
its copies must call `server/src/decks/allocation.ts` instead — CLAUDE.md's
rules win over the phase text.

## Shipped

0 prep · 1 core DB & search · 2 deck building & format rules · 3 commander
rules · 4 collection & pricing · 5 import/export/backup · 6 trades, want &
trade lists · 7 deck templates · 8 quick fixes · 9 mobile overhaul · 10
display density · 11 game/draft log · 17 onboarding · 22 allocation honesty · 23 owned-aware
search · 24 deck buildability · 25 assembly & pull sheets · 26 allocation
contention · 27 owned substitutes.

Each is in [`shipped/`](shipped/) under its original filename.

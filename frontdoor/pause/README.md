# Pause and data safety (W2-7)

Cards P2-05, P1-08, P1-09. PRD C3 req 5 and 6, C1 req 6, D15, D16, D25, X3. Three folders:

| Folder | What |
|---|---|
| `pause/` | The cost count, alert and autopause, the Owner's pause and unpause, the access state, the meter wrapper, the pause and plan-ended screens, the gateway hook, and `data-safety.ts`, which puts W2-7 together for the wiring. Student-facing text: `copy.ts` (Erick reviews it before launch). |
| `retention/` | `startRetention` and `endRetention` (for W2-8), the export zip, the day-91 delete, the hourly job timer. |
| `backups/` | Nightly tenant copies, the restore of one tenant folder, and its script. Runbook: `docs/decisions/2026-11-08-backups.md`. |

## Alert and autopause

After every metered model call the meter stores the row, then the cost watch checks the tenant in the background (`pause/meter.ts`, `pause/limits.ts`):

- It reads the thresholds from `owner_settings` (w2-dashboard edits them) on every check.
- The count is the tenant's model cost in the last 30 days, **but never from before the tenant's latest unpause**. Unpriced calls add nothing. Search fees are not part of it (D15 says model cost).
- At or above the alert threshold: one open `cost_alert` row.
- At or above the autopause threshold: a `pauses` row (reason `autopause`) and an `autopause` alert. The meter refuses the tenant's next call: it reads `pauses` on every call.
- Each newly opened alert goes to `onAlert` once (`DataSafetyOptions.onAlert`). Nothing is wired to it yet. PRD D15 says alerts show on the dashboard only.

## The unpause hold

An unpause starts a fresh count. For the next 30 days, alert and autopause count only model cost after the unpause. So a student Erick unpauses is not paused again by their very next call, but a fresh autopause amount after the unpause pauses them again. The dashboard can show both numbers with `costTowardLimits(db, tenantId)`: `rollingUsd` (the whole 30 days) and `countedUsd` (what the thresholds compare).

An unpause also clears the open autopause alert, by the same person. A cost alert stays open until the Owner clears it.

## For w2-dashboard

```ts
const controls = frontDoor.dataSafety!.controls;          // or createPauseControls({ db })
await controls.pauseTenant(tenantId, "owner", ownerAccountId);
await controls.unpauseTenant(tenantId, ownerAccountId);
const { rollingUsd, countedUsd, countedSince } = await costTowardLimits(db, tenantId);
```

Use the front door's own `dataSafety.controls` where you can: they also refresh the screens at once (otherwise within 5 seconds).

## For W2-8 (Stripe)

```ts
const retention = frontDoor.dataSafety!.retention();
await retention.startRetention(tenantId, endedAt);   // the plan ended (customer.subscription.deleted)
await retention.endRetention(tenantId);              // the student subscribed again
```

Both are safe to repeat. The trial record (`trial_claims`) is written when the trial starts; the day-91 delete leaves it alone.

## What the student sees

| State | Tutor pages | `/api` | Model calls (meter) | `/account/export`, `/account/record` |
|---|---|---|---|---|
| open | the tutor | pass | pass | yes |
| paused | pause screen | pass (reads work in an open tab) | refused, with the pause message | yes |
| retention | plan-ended screen with the deletion date | 403 | refused | yes |
| retention, 90 days over | "being deleted" screen | 403 | refused | 410 |
| gone (deleted) | signed out | 401 | refused | signed out |

The screens are plain HTML from the front door: no Clerk script, nothing loaded from outside. If the access state cannot be read (database down, nothing remembered), requests pass through; the meter's own pause check fails closed.

## The export

`GET /account/export` gives a zip: `README.txt`, `sessions/*.md` (upstream's markdown export), `study-record.html`, `knowledge-graph.json`, `imported-notes.json`. A part that fails is left out and named in `README.txt`. One export at a time per student. `?tz=<IANA zone>` sets the record's dates (the screens' links add the browser's zone); otherwise UTC.

The export and the record read the tenant's server through `supervisorFetch` in `data-safety.ts`. If W2-6 adds a per-tenant secret header, add it there too.

## The jobs

One timer in the front door, a tick every hour (the first a minute after start):

- **day-91 delete:** every tenant whose 90 days are over. Folder, key file and nightly copies first, then the database rows (so a failure is finished by the next run). Logs ids and counts only.
- **nightly copies:** once a night after 10:00 UTC, kept 7 nights.

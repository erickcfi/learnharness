# Pause and data safety (W2-7)

Cards P2-05, P1-08, P1-09. PRD C3 req 5 and 6, C1 req 6, D15, D16, D25, X3. Master decisions of 2026-11-08 are noted where they apply. Three folders:

| Folder | What |
|---|---|
| `pause/` | The cost count, alert and autopause, the Owner's pause and unpause, the access state, the meter wrapper, the reusable interstitial screen, the pause and plan-ended screens, the gateway hook, the student-name stand-in, and `data-safety.ts`, which puts W2-7 together for the wiring. Student-facing text: `copy.ts` (Erick reviews it before launch). |
| `retention/` | `startRetention` and `endRetention` (for W2-8), the export zip, the day-91 delete, the hourly job timer, and the trial email hash (`trial.ts`). |
| `backups/` | Nightly tenant copies, the restore of one tenant folder, and its script. Runbook: `docs/decisions/2026-11-08-backups.md`. |

## Alert and autopause

After every metered model call the meter stores the row, then the cost watch checks the tenant in the background (`pause/meter.ts`, `pause/limits.ts`):

- It reads the thresholds from `owner_settings` (w2-dashboard edits them) on every check.
- The count is the tenant's model cost in the last 30 days, **but never from before the tenant's latest unpause**. Unpriced calls add nothing. Search fees are not part of it (D15 says model cost).
- At or above the alert threshold: one open `cost_alert` row.
- At or above the autopause threshold: a `pauses` row (reason `autopause`) and an `autopause` alert. The meter refuses the tenant's next call: it reads `pauses` on every call.
- Alerts live in the `alerts` table only, for w2-dashboard to show (`listOpenAlerts`). PRD D15: alerts show on the dashboard only. There is no alert email.

## The unpause hold (master, Q1)

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
trialEmailHash(email);                               // retention/trial.ts: the trial_claims email hash
```

Both retention calls are safe to repeat. Write the trial claim when the trial starts; the day-91 delete leaves `trial_claims` alone. The "subscribe again" button goes in `RETENTION_EXTRA_ACTIONS` in `copy.ts`.

For "trial time used up: show the plans, chats still readable" (C2 req 3), reuse `pause/interstitial.ts`: add a state to `pause/access.ts`, give it a kind (for example `"trial-used-up"`), and in `pause/gate.ts` do what the paused branch does: `interstitialDecision(req, pathname, kind, secure)` for page loads, `interstitialPage({...})` for the screen, and `READ_PATH` with `readRedirect(kind, secure)` for its "Read your sessions" button.

## What the student sees

| State | Tutor pages | `/api` | Model calls (meter) | `/account/export`, `/account/record` |
|---|---|---|---|---|
| open | the tutor | pass | pass | yes |
| paused | pause screen; "Read your sessions" opens the tutor for reading | pass | refused, with the pause message | yes |
| retention | plan-ended screen with the deletion date | 403 | refused | yes |
| retention, 90 days over | "being deleted" screen | 403 | refused | 410 |
| gone (deleted) | signed out | 401 | refused | signed out |

The Owner's own account (the `owner` role, `isOwnerTenant` in `db/accounts.ts`) never reads as retention, so it never gets the plan-ended screen and the meter does not refuse it for that. A pause (autopause at $89, or the Owner's own) still applies to it, and its usage is metered and alerted like anyone's. Staff is not exempt.

The screens are plain HTML from the front door: no script, no Clerk, nothing loaded from outside. If the access state cannot be read (database down, nothing remembered), requests pass through; the meter's own pause check fails closed.

**Read your sessions (master, Q2):** the pause screen's first button is `GET /account/read-sessions`. It sets a cookie (`fd_read=paused`, 1 hour) and sends the student to `/`. Tutor pages then load for reading; new turns and jobs still fail at the meter with the approved message. The next full visit to `/` shows the screen again. The cookie grants nothing (a tutor that cannot take a turn), so it is not signed.

## The export and the record

`GET /account/export` gives a zip: `README.txt`, `sessions/*.md` (upstream's markdown export), `study-record.html`, `knowledge-graph.json`, `imported-notes.json`. A part that fails is left out and named in `README.txt`. One export at a time per student. `GET /account/record` is the printable record.

- Dates use the school's time zone, `SCHOOL_TIME_ZONE` = America/Los_Angeles (`copy.ts`; the same constant as w2-email's, joined at merge).
- The student's name comes from `studentName` (`student-name.ts`). Until the master points it at w2-dashboard's cached Clerk lookup, the stand-in gives "Student".
- Both read the tenant's server through `supervisorFetch` in `data-safety.ts`. If W2-6 adds a per-tenant secret header, add it there too.

## The jobs

One timer in the front door, a tick every hour (the first a minute after start):

- **day-91 delete (master, Q5):** every tenant whose 90 days are over, in this order: stop its server and delete its folder, key file and nightly copies; then its database rows; then its Clerk user. The Clerk user id goes on `<volume>/retention/pending-login-deletes.json` just before the rows go, so a Clerk outage is retried on the next run. Logs ids and counts only. The Owner's own tenant is never deleted or emptied: the job leaves it out and logs `day-91: tenant <id> belongs to the Owner; kept`.
- **nightly copies (master, Q7):** once a night after 10:00 UTC, kept 7 nights.

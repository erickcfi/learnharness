# frontdoor/db: the tutor's database

The Supabase schema and the typed data-access module for the North Aero Ground Tutor (card P1-03, PRD C1 req 7, PD5). The schema covers the whole project, so later cards add code, not tables.

## Decisions (Owner, 2026-11-08)

- Migrations live in `frontdoor/supabase/migrations/`. Code lives here, in `frontdoor/db/`.
- The server talks to Supabase over a **direct Postgres connection** through Supabase's session pooler, with the `postgres` npm package. It does not use the Data API (supabase-js), which can be turned off in the Supabase dashboard.
- **Row-level security is on for every table, with no allow rules.** Supabase's `anon` and `authenticated` roles get no table rights. Only the server reads and writes. Students see their data only through the tutor's pages.
- **Trial claims** keep a keyed hash of the email and Stripe's card fingerprint, with no tenant link, after the day-91 delete. This is flagged for the legal review (T5) and the privacy policy.

Record in `docs/decisions/2026-11-08-database.md`.

## Tables

| Table | What it holds | PRD |
|---|---|---|
| `accounts` | One row per login: Clerk user ID, 18+ checkbox date (required) | C1 req 5, D28 |
| `tenants` | One per student account: folder `tenants/<id>`, status (provisioning, ready, retention), retention end, Stripe customer | C1 req 2, 6 |
| `account_roles` | owner or staff. No row means student | C7 req 1, D27 |
| `consents` | session-text opt-in, tester written OK, with grant and revoke dates | C7 req 3, D19 |
| `model_usage` | One row per model call: tokens (cache writes with their 1-hour part), list-price dollars (null when the model has no list price), provider request ID | C3 req 4 |
| `search_usage` | One row per web search and its fee ($0.008 Tavily default) | C3 req 7 |
| `alerts` | Cost alert and autopause records. One open per tenant and kind | C3 req 5 |
| `pauses` | Pause history. An open row means paused | C3 req 6 |
| `subscriptions` | Stripe subscription and trial state | C2 |
| `stripe_events` | Webhook event IDs already processed | C2 req 9 |
| `invoices` | Amounts paid, for revenue and conversion | C7 req 2 |
| `trial_claims` | Email hashes and card fingerprints that had a trial | C2 req 2 |
| `study_time` | Active study stretches per tenant and chat | PD1 |
| `report_settings` | Session and weekly report switches (off by default), address, unsubscribe token | C6 req 3 |
| `report_sends` | Reports claimed and sent, so none goes out twice | C6 req 3 |
| `topic_labels` | Haiku's aviation flag per session topic | C7 req 4 |
| `owner_settings` | One row: alert $60, autopause $89 | C3 req 5 |
| `tenant_overview` (view) | Dashboard status: trial, active, paused, canceled, retention, none | C7 req 2 |

Deleting a tenant's account (`deleteTenantAndAccount`) removes every row of that tenant through the foreign keys. `trial_claims` and `stripe_events` have no tenant link and stay.

## Using the module

Every function takes a `Db` first.

```ts
import postgres from "postgres";
import { fromPostgresJs, recordModelUsage, rollingModelCost } from "../db/index.ts";

const db = fromPostgresJs(postgres(process.env.SUPABASE_DB_URL!));
await recordModelUsage(db, { tenantId, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, requestId });
const cost30 = await rollingModelCost(db, tenantId);
```

Use one `postgres` client per server process. `db.transaction(async (tx) => { ... })` runs several calls as one unit.

Main entry points by package:

- **Front door:** `createStudentAccount`, `getTenantByClerkUserId`, `markTenantReady`, `hasRole`, `getRoles`.
- **Metering:** `recordModelUsage`, `recordSearch`, `rollingModelCost`, `getOwnerSettings`, `openAlert`, `pauseTenant`, `isPaused`.
- **Stripe webhooks:** `processStripeEventOnce` (wraps the handler in one transaction with the event ID), `upsertSubscription`, `upsertInvoice`, `setStripeCustomerId`, `getTenantByStripeCustomerId`, `hashEmailForTrial`, `isTrialUsed`, `claimTrial`, `startRetention`, `endRetention`.
- **Dashboard:** `listTenantOverview`, `usageTotals`, `revenueTotals`, `studySummary`, `listOpenAlerts`, `clearAlert`, `unpauseTenant`, `updateOwnerSettings`, `canShowSessionText`, `grantConsent`, `revokeConsent`, `saveTopicLabel`.
- **Reports:** `getReportSettings`, `updateReportSettings`, `unsubscribeByToken`, `listWeeklyRecipients`, `claimReportSend`, `markReportSent`.
- **Day 91:** `listTenantsDueForDeletion`, `deleteTenantAndAccount` (the caller deletes the tenant folder).

Money comes back as numbers of dollars (`costUsd`, `feeUsd`) or whole cents (`amountPaidCents`). A model call with `costUsd: null` is unpriced: it is stored and counted (`unpricedCalls` in `usageTotals`), but adds nothing to the cost sums, so it never moves a tenant toward the alert or autopause. Times are `Date`s. Weekly report weeks are `YYYY-MM-DD` strings.

## Tests

`createTestDb()` from `testing.ts` gives a fresh in-process Postgres (PGlite) with Supabase's roles and every migration applied. Any package's tests can use it:

```ts
const t = await createTestDb();
// ... use t.db ...
await t.close();
```

The test roles are set up the way older Supabase projects grant them (full rights on new tables), so the tests prove the migrations take those rights away.

`tests/frontdoor-db-postgres.test.ts` runs the migrations and the module on a real Postgres server through postgres.js. It skips unless `LH_TEST_PG=1`; see the file for how to run it against a local throwaway server. Never point it at Supabase.

## Adding a table later

1. Add a new migration file named `<YYYYMMDDHHMMSS>_<name>.sql`. Never edit a migration that has already been applied to Supabase.
2. In the same file, after the table: `enable row level security`, `revoke all ... from anon, authenticated`, `grant select, insert, update, delete ... to service_role`, and the sequence lines if it has an identity column.
3. Add the table to `tests/helpers/frontdoor-db-tables.ts`. The migration and RLS tests then check it.

## Applying the migrations to Supabase

Needs the Owner's yes. From the repo root, with the session pooler connection string in `SUPABASE_DB_URL`:

```bash
npx supabase db push --workdir frontdoor --db-url "$SUPABASE_DB_URL" --dry-run
npx supabase db push --workdir frontdoor --db-url "$SUPABASE_DB_URL"
```

The CLI records each applied file in `supabase_migrations.schema_migrations` and skips it next time.

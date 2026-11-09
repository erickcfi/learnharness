# frontdoor/admin: the Owner's dashboard

W2-9, cards P3-01 to P3-05, the threshold settings from P3-06, and P5-01. PRD C7, C4 req 3, D19, D27, N7, PD1, PD6.

The dashboard lives at `/admin`. Only the Owner reaches it. It is phone first: plain pages, forms that work without JavaScript (except the upload), no outside scripts.

## How a request is checked

1. The gateway sends every `/admin` and `/admin/*` request to `handler.ts` (one `if` in `gateway/handler.ts`).
2. `handler.ts` checks the front door's login cookie (`fd_session`), re-checks the Clerk session every 5 minutes as the tutor does, and reads the account's roles from `account_roles` on every request (`access.ts`).
   - No login: a page redirects to sign-in, an API call gets 401.
   - A login with no permission (every student, and Staff until the Owner grants it some): 403.
   - The Owner: API calls run in `handler.ts`, each with its own permission (`roles.ts`). Pages go on to Next.js (`app/admin/`).
3. Each page checks the login and role again (`app/admin/_lib/guard.ts`, through the runtime in `registry.ts`). Without the front door's runtime, every page is "not found".
4. Every state change must come from the site itself (a matching `Origin`, or `Sec-Fetch-Site: same-origin`). The login cookie is also `SameSite=Lax`.
5. Every answer says `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store`. `/admin` is in neither the sitemap nor `robots.txt`.

## Roles (D27)

`roles.ts` maps each role to its permissions. The Owner has all of them. Staff has none at launch; to give Staff something later, add permissions to its list (and a test).

## Making the Owner: a one-time step

The Owner is never written into the code. After Erick has signed in to the site once (that makes his account, and a tenant he can study in):

1. Find his Clerk user id: Clerk dashboard, Users, his user, "User ID" (it starts with `user_`).
2. With the Supabase session pooler URL in `SUPABASE_DB_URL`, from the repo root:

```bash
SUPABASE_DB_URL='<session pooler URL>' npx tsx frontdoor/admin/grant-owner.ts user_XXXXXXXX
```

It prints `Owner role granted` (or `Already the Owner`). It refuses when no account has that id yet. To check: `npx tsx frontdoor/admin/grant-owner.ts --list`.

The same step in Supabase's SQL editor:

```sql
insert into account_roles (account_id, role)
select id, 'owner' from accounts where clerk_user_id = 'user_XXXXXXXX'
on conflict do nothing;
```

Taking the role away: `delete from account_roles where role = 'owner' and account_id = (select id from accounts where clerk_user_id = 'user_XXXXXXXX');`. It stops working at the next request.

## Pages

| Page | What |
|---|---|
| `/admin` | Totals, open alerts (pause, unpause, clear), one card per student with pause or unpause. Period: last 30 days, this month, all time. |
| `/admin/students/<tenant id>` | One student: numbers, sessions with study time, plan topics and the non-aviation flag, consent, history. |
| `/admin/students/<tenant id>/sessions/<chat id>` | Session text, only with consent (D19). |
| `/admin/settings` | Alert and autopause thresholds. |
| `/admin/library` | The source library: list, upload, remove with a confirm step. |

## Where each number comes from (C7 req 6)

| Number | Source |
|---|---|
| Plan, status, coupon, revenue, conversion | `subscriptions` and `invoices` (W2-8 fills them from Stripe). Until then: "After billing is connected". |
| Model cost, unpriced calls, searches and fees, alerts, pause | The meter's rows: `model_usage`, `search_usage`, `alerts`, `pauses`. |
| Study time, sessions | `study_time`, from the front door's heartbeat (`frontdoor/study-time`, PD1). |
| Session titles and plan topics | The tenant's own server, `GET /api/chats` and `GET /api/chats/:id` (`tenant-api.ts`). |
| Non-aviation flag | `topic_labels` (`flags.ts`, N7). |
| Session text | `GET /api/chats/:id/markdown`, consent only (`session-text.ts`). |

Conversion: of the students whose trial has ended, the share with a paid invoice above $0. A tester's $0 invoices do not count.

## Session text and consent (D19)

`session-text.ts` reads consent from the database on every view, just before asking the tenant's server, and never stores or caches the text. Without an active consent the tenant's server is not asked. Two consents open it: the student's own switch (`/account/sharing`, `frontdoor/sharing`) and a tester's written OK, which the Owner records on the student's page with a note. Both keep their dates.

## The non-aviation flag (N7)

`flags.ts`. A session has ended when its chat has had no study time for 30 minutes (`study-time/queries.ts`). Then `claude-haiku-5-5` labels it from the session title and plan topics only, never session text, with the front door's own Anthropic key (not metered to the student). Each chat is labeled once, and again only when its title or plan topics change (master, 2026-11-08). The label is stored in `topic_labels` and changes nothing in the tutor. The sweep runs every 5 minutes (`labelTopics: true` in `wiring/front-door.ts`).

## For the merge

- **W2-7 (pause):** pass its functions as `pause` to `createDashboard()` in `wiring/front-door.ts`. The shape is `PauseActions` in `pause.ts`: `pauseTenant(tenantId, "owner", ownerAccountId)` and `unpauseTenant(tenantId, ownerAccountId)`. Until then `databasePauseActions` writes the pause row directly, which the meter already obeys.
- **W2-6 (isolation):** when tenant servers need their own secret on every request, pass a `tenantFetch` that adds it (see `supervisorTenantFetch` in `tenant-api.ts`).
- **W2-8 (Stripe):** fill `subscriptions` and `invoices`. Nothing in this folder changes. `billingConnected` turns on by itself once a row exists (or pass it).
- **W2-10 (email):** wired. `wiring/front-door.ts` passes `sittings: endedSittingsSource(db)` (from `frontdoor/study-time`) to `startEmailReports`: ended sittings with per-chat seconds. `activeSecondsBySession(db, tenantId)` gives study time per chat.

# Front door

North Aero Ground Tutor's front door (PRD X1, X5, C1). One Node process that every request reaches first. It:

1. Serves its own pages under `/account` (sign in, sign up with the 18+ checkbox, confirm age, sign out). Next.js 16, with Clerk.
2. Checks the login on every other request. Without the front door's login cookie, `/api` gets 401 and a page redirects to `/account/sign-in`. The exceptions are the public pages (W2-11, `marketing/README.md`): the landing page at `/` for visitors with no login, and `/how-it-works`, `/help`, `/legal/*`, `/robots.txt`, `/sitemap.xml` for everyone.
3. Finds the student's tenant, and starts the tenant's own LearnHarness server if it is not running (one per tenant, on 127.0.0.1, no idle stop).
4. Passes the request through, streams included, without buffering.

Decision and spike: `docs/decisions/2026-11-08-x5-front-door-spike.md`.

## Layout

| Path | What |
|---|---|
| `server.ts` | The custom Node server. `tsx` runs it (the meter's price list imports upstream TypeScript that plain Node cannot strip). |
| `wiring/` | Start checks and secrets (`env.ts`), the database client (`database.ts`), and `startFrontDoor()` (`front-door.ts`), which connects every piece below. |
| `gateway/` | Request handling: routing, login cookie, 18+ form, first login, the route table (`route-policy.ts`, `route-guard.ts`, W2-6), pass-through, Clerk adapter, settings from env. No framework. |
| `isolation/` | Tenant walls and hosted mode (W2-6): the web tools' address guard (`safe-fetch.ts`) and the hosted switch for upstream's UI (`hosted.tsx`). See `docs/decisions/2026-11-08-route-blocks.md`. |
| `tenants/` | Accounts store (interface, Supabase store, in-memory store), tenant paths, provisioning, settings template, process supervisor. No framework. |
| `metering/` | The meter: pass keys, the proxy, prices, and its stores (Supabase with the DB-outage rules, in-memory). |
| `db/`, `supabase/` | The database module and its migrations. See `db/README.md`. |
| `production-safety/`, `log-hygiene/`, `settings-template/`, `source-link/` | Lockdown pieces. |
| `records/` | The printed study record. |
| `app/account/` | The front door's Next.js pages. Clerk is set up in `app/account/layout.tsx` only. |
| `app/(public)/`, `marketing/` | The public pages: landing, How it works, Help, legal placeholders (W2-11). Text in `marketing/copy.ts`. |
| `plans/` | Prices and trial terms, the one place they live. |
| `proxy.ts` | Clerk's middleware, for the `/account` pages only. |

Tests: `tests/frontdoor-*.test.ts` (run by the root `npm test`).

## Build and run

From the repo root:

```bash
npm ci
npm run build && node scripts/build-server.mjs   # upstream LearnHarness, the tenant server
npm run build -w frontdoor                       # the front door's pages
npm run start -w frontdoor                       # the front door
```

Environment variables: see "Deploy on Railway" below. Outside production the four secrets may be left out: without `SUPABASE_DB_URL`, accounts and usage stay in memory until the front door stops.

## How the pieces connect

`wiring/front-door.ts` (W1-6) does it, in this order:

1. **Start checks** (`wiring/env.ts`), before Next.js or any upstream code loads. In production the front door refuses to start, naming the variable, when `LH_PROVIDER_EVENTS`, `LH_BACKGROUND_CAPTURE` or `DEEPGRAM_API_KEY` is set, or when a required secret is missing. It never prints a value.
2. **Log filter** (`log-hygiene/preload.ts`): imported first by `server.ts`, and loaded into every tenant server with `node --import`.
3. **Database** (`db/`): accounts and tenants through `tenants/supabase-accounts.ts`, `markTenantReady` after each provisioning, and the meter's store.
4. **Meter** (`metering/`): on 127.0.0.1, on a free port only tenant servers use. The real Anthropic and Tavily keys stay in the front door. At shutdown it waits for every usage write.
5. **Tenant servers** (`tenants/supervisor.ts`): each one's `settings.json` gets the library-only File access section, and its environment gets `LH_LIBRARY_DIR` and its metering pass key.
6. **Tenant logs** (`wiring/tenant-logs.ts`): only what a tenant server prints to stderr reaches the front door's log, as `[tenant <id>] <line>`, through the front door's log filter too, cut to 300 characters, at most 100 lines a minute per tenant (then one "N lines suppressed" line). Stdout is dropped. Known gap: student text inside an error message that is not in quotes stays, as with the log filter itself.

Tenant servers get only `PATH`, `LANG`, `LC_ALL` and `TZ` from the front door's environment, plus their own folder settings (`TMPDIR` is `<tenant folder>/.tmp`), `LH_LIBRARY_DIR`, and the metering variables (pass key, meter address). No front door secret reaches them.

**Route table and tenant walls (W2-6).** Every logged-in request is checked against `gateway/route-policy.ts` before it passes through. Blocked API routes get 403 JSON, and an unlisted API route is refused too. Each tenant server runs with `LH_HOSTED=1` and its own random secret (`LH_DESKTOP_API_SECRET`, new at every start). It refuses any request, on any path, without that secret in `x-learnharness-desktop`, which only the front door adds. **Code that calls a tenant server directly (records, dashboard, email reports) must use `supervisor.endpoint(tenantId)` or `tenantFetch(tenantId, path)`** (from `startFrontDoor()`: `tenantEndpoint(tenantId)`). Before every tenant start, the supervisor writes the Owner's settings template again, so a drifted `settings.json` is put back. Details and the full table: `docs/decisions/2026-11-08-route-blocks.md`.

### When the database is down

The meter follows the master's rule (2026-11-08), in `metering/supabase-store.ts`:

- Each pause check reads the database (2-second limit). Each student's last status is remembered for 1 minute and used only when the database is down or slow.
- Nothing remembered and the database down: the call is refused with a 503, "Usage tracking is briefly unavailable. Try again in a minute."
- A usage row that fails to write is kept and retried (1 s, doubling to 30 s, and at once when the database answers again). It is never dropped.
- The queue holds 10,000 rows. When it is full, new calls are refused the same way until it drains. Rows from calls already under way are still kept.
- Rows still waiting at shutdown go to `<volume>/metering/pending-usage.jsonl`. The next start writes them and removes the file.
- A row the database refuses for good (a data or constraint error) is not retried. The log line gives its tenant id and error code only. The full row and the error code go to `<volume>/metering/rejected-usage.jsonl` (owner-only), so its cost can still be seen.
- A model row is stored once even when retried (unique request id). A search row retried after a write that landed but whose answer was lost could count twice, because `search_usage` has no unique id. This is rare, and needs no migration (master, 2026-11-08).

## Deploy on Railway

One service, one volume (PRD section 7, D22). Nothing here changes Railway by itself; the Owner sets it up.

**Before the first deploy:** apply the database migrations to Supabase (`db/README.md`, needs the Owner's yes).

**Node:** 26, as in CI.

**Build command** (from the repo root):

```bash
npm ci && npm run build && node scripts/build-server.mjs && npm run build -w frontdoor
```

The build needs the dev packages (TypeScript, the CSS tools). If the build runs with `NODE_ENV=production`, use `npm ci --include=dev`. `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` must be set at build time too.

**Start command:**

```bash
npm run start -w frontdoor
```

It sets `NODE_ENV=production` and runs `server.ts` with `tsx`.

**Volume:** mount it at `/data`, or set `FRONTDOOR_VOLUME` to the mount path. Layout:

| Path | What |
|---|---|
| `<volume>/tenants/<tenant id>/` | Each student's LearnHarness data (`LH_DATA_DIR`). Owner-only folder. |
| `<volume>/auth/<tenant id>.json` | Each tenant server's key file (`LH_AUTH_FILE`). It holds no key: the meter has the keys. |
| `<volume>/library/` | The shared source library (`LH_LIBRARY_DIR`), the only folder the tutors' file tools may read. Made at start if missing. |
| `<volume>/metering/` | `pending-usage.jsonl` and `rejected-usage.jsonl`, only after a database outage. |

**Variables:**

| Name | What it is for | Secret | Required in production |
|---|---|---|---|
| `FRONTDOOR_SESSION_SECRET` | Signs the front door's login cookies. 32+ random characters (for example `openssl rand -base64 48`). | Yes | Yes |
| `FRONTDOOR_PASS_KEY_SECRET` | Signs each tenant's metering pass key. 32+ random characters, different from the session secret. Changing it gives every tenant a new pass key at the next start. | Yes | Yes |
| `CLERK_SECRET_KEY` | The Clerk application's secret key (API keys page). | Yes | Yes |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | The Clerk application's publishable key (same page). Also used at build time. | No (public) | Yes |
| `ANTHROPIC_API_KEY` | The real Anthropic key. Only the meter uses it. | Yes | Yes |
| `TAVILY_API_KEY` | The real Tavily key. Only the meter uses it. | Yes | Yes |
| `SUPABASE_DB_URL` | The Supabase session pooler connection string (IPv4, port 5432), from Supabase's Connect panel. It holds the database password. TLS is required unless the string sets `sslmode`. | Yes | Yes |
| `FRONTDOOR_AUTHORIZED_PARTIES` | The site's origins, comma-separated, for example `https://ground.flynorthaero.com` and the staging address. Clerk logins are accepted only from these. | No | Recommended |
| `CLERK_JWT_KEY` | Clerk's PEM public key: checks logins without a call to Clerk. | No (public) | No |
| `FRONTDOOR_VOLUME` | The volume's mount path. Default `/data`. | No | Only if not `/data` |
| `FRONTDOOR_TENANT_SERVER` | Upstream's built server. Default `<repo>/.next/standalone/server.js`. | No | No |
| `FRONTDOOR_LISTEN_HOST` | Default `0.0.0.0`. | No | No |
| `PORT` | Railway sets it. | No | Railway sets it |
| `RAILWAY_GIT_COMMIT_SHA` | Railway sets it. The AGPL source link uses it. | No | Railway sets it |

**Never set in production:** `LH_PROVIDER_EVENTS`, `LH_BACKGROUND_CAPTURE`, `DEEPGRAM_API_KEY` (the front door refuses to start), and `FRONTDOOR_DEV`.

Tenant servers never see the front door's variables, so old upstream variables left on the service do nothing.

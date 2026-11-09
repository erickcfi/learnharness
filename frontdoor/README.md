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
| `server.ts` | The custom Node server. Node runs it directly (type stripping). |
| `gateway/` | Request handling: routing, login cookie, 18+ form, first login, pass-through, Clerk adapter, settings from env. No framework. |
| `tenants/` | Accounts store (interface + in-memory stand-in), tenant paths, provisioning, settings template, process supervisor. No framework. |
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

Environment variables: see the comment at the top of `gateway/config.ts`.

## Plug points for other packages

Every plug point is marked `WIRING POINT` in `server.ts`.

| Package | Where | What to plug in |
|---|---|---|
| w1-database | `tenants/accounts.ts` | A Supabase `AccountStore` (get, confirmAge, assignTenant), and `markTenantReady` after provisioning. |
| w1-lockdown | `tenants/settings-template.ts` | A `FileAccessProvider` (library-only restricted mode), passed to `provisionTenant`. |
| w1-lockdown | `gateway/startup-checks.ts` | The production safety check, added to `STARTUP_CHECKS`. |
| w1-lockdown | `tenants/supervisor.ts` | `nodeArgs: ["--import", <log filter>]`, `onOutput` (tenant logs are dropped now), and the library path in `tenantExtraEnv`. |
| w1-metering | `server.ts` | Start the meter on 127.0.0.1, spread `meteringEnvForTenant(...)` in `tenantExtraEnv`, and flush it on shutdown. |

Tenant servers get only `PATH`, `LANG`, `LC_ALL` and `TZ` from the front door's environment, plus their own settings and `tenantExtraEnv`. No front door secret reaches them unless a package adds it there on purpose.

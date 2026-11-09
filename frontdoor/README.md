# Front door

North Aero Ground Tutor's front door (PRD X1, X5, C1). One Node process that every request reaches first. It:

1. Serves its own pages under `/account` (sign in, sign up with the 18+ checkbox, confirm age, sign out). Next.js 16, with Clerk.
2. Checks the login on every other request. Without the front door's login cookie, `/api` gets 401 and a page redirects to `/account/sign-in`.
3. Finds the student's tenant, and starts the tenant's own LearnHarness server if it is not running (one per tenant, on 127.0.0.1, no idle stop).
4. Passes the request through, streams included, without buffering.

Decision and spike: `docs/decisions/2026-11-08-x5-front-door-spike.md`.

## Layout

| Path | What |
|---|---|
| `server.ts` | The custom Node server. Node runs it directly (type stripping). |
| `gateway/` | Request handling: routing, login cookie, 18+ form, first login, pass-through, Clerk adapter, settings from env. No framework. |
| `tenants/` | Accounts store (interface + in-memory stand-in), tenant paths, provisioning, settings template, process supervisor. No framework. |
| `app/account/` | The front door's Next.js pages. |
| `proxy.ts` | Clerk's middleware, for the front door's pages only. |

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

| Package | Where | What to plug in |
|---|---|---|
| w1-database | `tenants/accounts.ts` | A Supabase `AccountStore` (get, confirmAge, assignTenant). Wire it in `server.ts`. |
| w1-lockdown | `tenants/settings-template.ts` | A `FileAccessProvider` (library-only restricted mode). Wire it in `server.ts` (`provision`). |
| w1-lockdown | `tenants/supervisor.ts` | `onOutput`: what tenant server logs may reach the front door's logs (now: dropped). |
| w1-metering | `tenants/supervisor.ts` | `extraEnv`: variables each tenant server needs, such as the metering proxy's address. |

# Kanban

Columns: Owner tickets, Ready, In progress, Review, Done, Backlog. Move a card or package by moving its block. PRD IDs refer to `docs/PRD.md`.

The build runs in waves of work packages (`docs/plan.md`, D33). Each package is one agent session on its own branch, and groups several cards. The cards keep their IDs (P1-01 and so on), and their full text is in the card reference at the end.

## Owner tickets

These run alongside the build. Owner: Erick, unless stated.

- **T1. FAA documents** for the source library. Erick picks the documents. Claude downloads and files them. Feeds the library upload in W2-9.
- **T2. NTSB reports** for the source library. Claude finds and files them. Erick approves the set.
- **T3. Aircraft set and POH data,** plus a license check on the POH data.
- **T4. North Aero material** for the source library.
- **T5. Terms, privacy policy, and AI notice.** Claude drafts them. Erick approves them. No lawyer review (D32). Feeds gate G2. They cover:
  - the terms, with the fair-use limit, one person per account, and the 18+ rule
  - the privacy policy, with what North Aero can see
  - California auto-renewal rules, including the annual renewal notice
  - the AI notice
  - use of the LearnHarness name
- **T6. Move the old ground school modules.** Claude does most of the move. Erick approves. Feeds P7-04.
- **T7. Cost test.** Feeds gate G1 and the C3 model settings.
  - Run A: one full hour on "Teach me to decode a TAF," with high thinking.
  - Run B: one full hour on "Teach me to read a winds aloft forecast," with medium thinking.
  - For each run, report the start and end time, the dollar estimate, and the cache hit rate from Session stats.
  - Also report the Cheap slot model and the Strong slot Cache setting.
  - Run A can run on staging during P0-07.
- **T8. Minors.** Claude researches a path for students under 18. Erick and a lawyer decide.

## Ready

### P0-07. Measure memory during a live teaching turn

- **Owner:** Erick (steps 1 to 4), then Claude Code
- **Depends on:** P0-06. Does not block wave 1.
- **PRD:** K3
- **Erick's steps:**
  1. In the Claude Console, create an API key named `ground-tutor-staging`.
  2. Open staging, then enter that key in Settings, under Providers.
  3. Run one teaching session of at least 30 minutes. T7 Run A can be this session.
  4. When you finish, remove the key from staging Settings.
- **Claude Code's work:** read the service's memory from Railway's metrics during the session. Record the peak in `docs/decisions/` and update PRD K3.
- **Done when:** the peak memory during a live turn is recorded, and K3 is updated.
- **Note (2026-11-08):** the first real student session (2026-11-07, about 45 minutes, $2.75, Opus 5.5 with high thinking) ran outside staging, so it gives no memory reading.

## In progress

### P0-06. Staging on Railway, behind a password

- **Owner:** Erick (steps 1 to 4), then Claude Code
- **Depends on:** P0-05
- **PRD:** X6, D22, D31, section 7
- **Erick's steps** (Railway docs, checked 2026-11-07):
  1. In Railway, click **New Project**.
  2. Choose **GitHub repo**. If Railway asks, link your GitHub account.
  3. Search for `erickcfi/learnharness` and click it.
  4. Choose **Add variables**, not Deploy Now.
- **Claude Code's work:**
  1. Read Railway's current docs on build and start commands, Node version, volumes, and private networking. Read them before you change any setting.
  2. Add a volume mounted at `/data`.
  3. Set these variables:
     - `LH_DATA_DIR=/data/tenants/staging`
     - `LH_AUTH_FILE=/data/auth.json`
     - `NODE_ENV=production`
     - `NEXT_TELEMETRY_DISABLED=1`
     - Node 26, in the way Railway's builder docs describe
  4. Build command: `npm run build && node scripts/build-server.mjs`. Start command: `node .next/standalone/server.js`. Make the server listen on the address that Railway's private networking docs require.
  5. Give the LearnHarness service no public domain.
  6. Deploy our own password proxy (X6, D31) from `erickcfi/ground-tutor-staging-proxy`. Set `ORIGIN` to the LearnHarness service's private address. Erick sets `BASIC_AUTH` to `username:password` himself, in Railway.
  7. Test whether the proxy passes server-sent event streams as they happen.
- **Done when:**
  - The staging address asks for a password, and a wrong password gets 401.
  - With the password, the app loads.
  - A server-sent event stream arrives through the proxy without buffering.
- **Progress (2026-11-07):**
  - X6 was decided again: our own nginx proxy instead of Railway's Basic Auth Proxy template (D31). The template is unlicensed community code with a 60-second idle cutoff, and teaching-turn streams send no keep-alive pings.
  - Railway created the project and started a deploy as soon as the repo was picked, with no Add variables step. That first build was stopped.
  - Railway project `ground-tutor`, environment `staging`.
  - `learnharness` service: the variables above, plus `RAILPACK_NODE_VERSION=26` (Node 26.12.1), `HOSTNAME=::` (listens on IPv4 and IPv6), and `PORT=3000`. Volume `ground-tutor-data` at `/data`. No public domain. Deploys from `main` after CI passes (Wait for CI).
  - `staging-proxy` service: `ORIGIN=http://learnharness.railway.internal:3000`, `PORT=8080`. Public address `https://staging-proxy-production-0fd9.up.railway.app`.
  - Left: Erick sets `BASIC_AUTH` (password of 16 or more characters). Until then the proxy refuses to start, and the address serves nothing. Then the 401, sign-in, and stream tests.

### W1-6. Wire-up (started 2026-11-08)

- **Branch** `w1-wireup`, from `main` at `b974d60`.
- **Work:** connect lockdown, metering and the database into the front door at the `WIRING POINT` comments in `frontdoor/server.ts`. The front door starts with `tsx`. A Supabase-backed account store and metering store, with the DB-outage rule (pause status remembered for 1 minute, refuse with nothing remembered, usage writes retried). Deploy notes in `frontdoor/README.md`.
- **Done when:** an end-to-end test shows a first login provisioning a locked-down, metered tenant, a model call landing as a usage row, and a paused tenant refused. The front door builds and starts. The gate is green.

### W2-11. Landing page and walkthrough (started 2026-11-08)

- **Branch** `w2-landing`, from `main` at `b974d60`.
- **Why:** Erick, 2026-11-08: students need a landing page and a brief animated walkthrough of how the tutor works, leading to sign-up.
- **Work:** public pages in the front door: `/` (landing, for visitors not signed in), `/how-it-works` (animated tour of Measure, Plan, Teach, Practice and the study record), `/help` (getting started and FAQ), and placeholder legal pages. Prices come from one config value (D8, D34). CSS and SVG animations, reduced motion respected, mobile first, no trackers. Honest copy, kept in one file for Erick to review.
- **Done when:** the pages render with no login, every `/api` route still returns 401 without one, the front door builds, the gate is green, and screenshots are in `previews/landing/` for Erick. Erick approves the copy before launch.

## Review

(none)

## Done

### Wave 1 (merged 2026-11-08)

Each package ran in its own agent session, in `~/lh-wt/<branch>`. The master session checked each branch, reran the gate, and merged them in this order, fixing change-log conflicts by keeping both sides. `main` at `b974d60`: 3,791 tests, 3,786 pass, 0 fail, 5 skipped. The front door builds.

- **W1-1. Front door** (PR #7). Cards P1-01, P1-02, P1-04, P1-07. Custom Node server around Next.js (X5, approved). Clerk login gate, one tenant server per student on 127.0.0.1 with an environment allowlist, 18+ box before sign-up, pages under `/account`, `frontdoor/` as an npm workspace. Real Clerk login waits for Erick's Clerk app.
- **W1-2. Database** (PR #4). Card P1-03, widened: 17 tables and the `tenant_overview` view, row-level security with no allow rules, server-only access. Sign-in calls are safe to repeat. Supabase project `ground-tutor` created 2026-11-08 (empty until the tables are loaded).
- **W1-3. Lockdown** (PR #6). Cards P1-06, P5-02, P2-06, P1-10. File tools locked to the library, library read-only, production start check, log filter, AGPL source link, 20 MB per-file import limit.
- **W1-4. Metering** (PR #3). Cards P2-01, P2-02. Per-student pass keys, every Anthropic call and Tavily search metered per tenant, paused students refused.
- **W1-5. Reporting** (PR #5). Card P3-06 (contract tests), card P6-01 (record builder and print view), SES checklist for P6-02 in `docs/decisions/2026-11-08-ses-checklist.md`.
- **Docs** (PR #2). Waves plan, D31 to D34.

### P0-01. Fork the repository

- **Owner:** Erick
- **PRD:** D23
- **Steps** (GitHub docs, checked 2026-11-07):
  1. Sign in to GitHub as `erickcfi`.
  2. Open `https://github.com/amosblomqvist/learnharness`.
  3. Click **Fork** at the top right.
  4. Under **Owner**, choose `erickcfi`.
  5. Keep the repository name `learnharness`.
  6. Select **Copy the main branch only**.
  7. Click **Create fork**.
  8. Check that the new repository page shows **Public**.
- **Done when:** `https://github.com/erickcfi/learnharness` exists and is public.
- **Result (2026-11-07):** Forked with `gh repo fork --default-branch-only`, with the Owner's yes. Public, `main` only, at `713377f`.

### P0-02. Turn on GitHub Actions in the fork

- **Owner:** Erick
- **Depends on:** P0-01
- **Steps:**
  1. Open the **Actions** tab of `erickcfi/learnharness`.
  2. If GitHub shows a notice that workflows do not run on this fork, click **I understand my workflows, go ahead and enable them**.
- **Done when:** the Actions tab lists the **CI** workflow.
- **Result (2026-11-07):** The Owner clicked the button. Only **CI** is active. **Desktop release** and **Notify website** are turned off (Owner's choice), as a second guard on top of the push-branches-only rule.

### P0-03. Clone the fork in Orv

- **Owner:** Erick
- **Depends on:** P0-01
- **Steps** (Ubuntu terminal in WSL):
  1. `cd ~`
  2. `git clone https://github.com/erickcfi/learnharness.git`
  3. `cd learnharness`
  4. `git remote add upstream https://github.com/amosblomqvist/learnharness.git`
  5. `git fetch upstream --no-tags`
  6. `node --version`
  7. If the version is not v26, install Node 26 with your Node version manager. Upstream CI uses Node 26.
  8. `code .`
- **Done when:** VS Code opens the fork, and `git remote -v` lists both `origin` and `upstream`.
- **Result (2026-11-07):** Cloned to `~/learnharness` in WSL, with the `upstream` remote. Node 26 through nvm.

### P0-04. Add the fork documents

- **Owner:** Claude Code
- **Depends on:** P0-03
- **PRD:** N9, N10
- **Work:** Add the files Erick provides:
  - `CLAUDE.md`
  - `docs/PRD.md`
  - `docs/plan.md`
  - `docs/kanban.md`
  - `docs/upstream-changes.md`
  - `docs/decisions/2026-11-06-x1-x2-spikes.md`
  - `docs/decisions/2026-11-06-measure.sh`
- **Source:** the `repo-files/` folder in `C:\Users\vince\northaero_learnharness`.
- **Done when:** the files are on `main` through a pull request, and CI is green.
- **Result (2026-11-07):** Merged through pull request #1 as `fadc7ec`. CI is green on `main`.

### P0-05. Confirm the CI baseline

- **Owner:** Claude Code
- **Depends on:** P0-02, P0-04
- **Work:**
  1. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run lint` locally at upstream `713377f`.
  2. Record the test count and the run time in the pull request from P0-04.
- **Done when:** all four commands pass locally, and the CI workflow is green on `main`. The workflow includes the `quality` job and the 3-system `standalone` job.
- **Result (2026-11-07):** `npm ci` 47.7 s, typecheck 10.8 s, test 46.2 s, lint 4.6 s. 252 test files, 3,547 tests: 3,543 pass, 0 fail, 4 skipped. Lint: 0 errors, 1 warning (`tests/source-name-ui.test.tsx`). CI is green on `main` at `fadc7ec`.

## Backlog

Each package's done criterion is the PRD acceptance tests of its cards, plus the gate in `docs/plan.md`, step 6.

### Wave 2

Starts when W1-1 (front door) is merged. Packages that write to the database also wait for W1-2.

- **W2-6. Isolation and student limits.** Cards P1-05, P2-03, P2-04. PRD C1 acceptance tests, C3 requirements 1 to 3.
- **W2-7. Pause and data safety.** Cards P2-05, P1-08, P1-09. PRD C3 requirements 5 and 6, C1 requirement 6, X3.
- **W2-8. Stripe.** Cards P4-01 to P4-07. PRD C2, X4. Erick: set up Stripe test mode.
- **W2-9. Dashboard.** Cards P3-01 to P3-05, the threshold settings from P3-06, and P5-01. PRD C7, C4 requirement 3.
- **W2-10. Email reports.** Cards P6-03, P6-04, P6-05, and the sending setup from P6-02. PRD C6. Needs W1-5.

### Testers

- **P7-01. Tester onboarding.** Starts when W1-1, W1-2, W1-3, W1-4, and W2-6 are merged.

### Wave 3

- **P7-02. Gate review.**
- **P7-03. DNS cutover.**
- **P7-04. Retire the Netlify site,** after T6.

## Card reference

The cards below are grouped into the packages above.

### Accounts, isolation, file lockdown

- **P1-01. Front door technology spike (X5).** Pass a server-sent event stream from one tenant server through the front door without buffering. Write the result in `docs/decisions/`. The Owner approves.
- **P1-02. Front door skeleton** (C1 requirements 1, 3, 4). Clerk login in a new Clerk application, with Erick creating it from Clerk's current docs. Start a tenant server on first login. Pass requests and streams through.
- **P1-03. Supabase project** (PD5, C1 requirement 7). Erick creates the project. Build tables for accounts, tenants, roles, and consents, with row-level security on. W1-2 widens this to every table the project needs.
- **P1-04. Tenant provisioning** (C1 requirement 2, C3 settings sync). Create the tenant folder, and write the Owner's settings template into it.
- **P1-05. Isolation test suite** (C1 acceptance tests). Cover every route in `app/api`, plus streams, agent tools, and background jobs.
- **P1-06. File lockdown** (C5). Upstream restricted mode, with the library as the only folder, fixed by the Owner. Add the path-traversal tests.
- **P1-07. 18+ checkbox** (C1 requirement 5, D28).
- **P1-08. Retention and export** (C1 requirement 6, D25). Keep data 90 days, offer an export zip, then delete on day 91.
- **P1-09. Backups** (X3). Railway volume backups, plus a restore test of one tenant folder.
- **P1-10. Source link and log hygiene** (cross-cutting requirements 1 to 3).

### Key, models, metering, pause

- **P2-01. Metering proxy** (C3 requirement 4, X2). Edit `src/agent/models.ts`. Store usage rows in Supabase.
- **P2-02. Search counter** (C3 requirement 7). Edit `src/server/search.ts`. Show the search fee.
- **P2-03. Server-held key and route blocks** (C3 requirements 1 and 2). Block routes at the front door.
- **P2-04. Model lock and settings sync** (C3 requirement 3, N2). If blocked controls show errors, ask the Owner about hiding them.
- **P2-05. Alert, autopause, pause screen, unpause** (C3 requirements 5 and 6).
- **P2-06. Production safety** (C3 requirements 8 and 9). Dictation off. The server refuses to start if debug capture variables are set.

### Dashboard

- **P3-01. Roles and the `/admin` shell** (C7 requirement 1, D27).
- **P3-02. Study time and session counts** at the front door (C7 requirement 6, PD1).
- **P3-03. Tenant table** (C7 requirement 2). Plan, status, coupon, cost, revenue, and conversion. The Stripe columns fill in when W2-8 lands.
- **P3-04. Topics, consent, and session text** (C7 requirements 3 and 6, D19).
- **P3-05. Non-aviation flag** (C7 requirement 4, N7).
- **P3-06. Contract tests and threshold settings** (C7 requirements 5 and 7).

### Subscriptions (Stripe test mode)

- **P4-01. Products, prices, coupons, and promotion codes** (C2 plans, requirements 7 and 8).
- **P4-02. Checkout with trial,** card required, one trial per email and per card (C2 requirements 1, 2, 5, and 6).
- **P4-03. Trial study-time gate and plans screen** (C2 requirement 3, PD1, PD2).
- **P4-04. Buy now** (C2 requirement 4).
- **P4-05. Customer portal and cancellation,** which starts retention (C2 requirement 1, C1 requirement 6).
- **P4-06. Webhooks and revenue on the dashboard** (C2 requirement 9).
- **P4-07. Coupon flows.** The North Aero code, and the tester code that skips the trial gate (C2 requirements 7 and 8).

### Source library

- **P5-01. Library folder and Owner upload page** (C4 requirements 1 to 3, PD6).
- **P5-02. Library read tests across tenants** (C4 acceptance tests).

### Records

- **P6-01. Print view with the label** (C6 requirements 1 and 2, N8).
- **P6-02. SES identity and DNS records** (C6 requirements 4 and 5, N1). Erick adds the DNS records from SES's current docs.
- **P6-03. Session-end report** (C6 requirement 3).
- **P6-04. Weekly report** (C6 requirement 3).
- **P6-05. Report settings in setup, and unsubscribe** (C6 requirement 3, N12).

### Testers and launch

- **P7-01. Tester onboarding** (D14, D19). Get the 3 testers' written consents, and give them the tester code.
- **P7-02. Gate review.** Record evidence for G1 to G4 in `docs/decisions/launch-gates.md`.
- **P7-03. DNS cutover.** Point `ground.flynorthaero.com` to Railway, using the DNS host's current docs.
- **P7-04. Retire the Netlify site,** after T6.

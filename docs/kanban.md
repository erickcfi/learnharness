# Kanban

Columns: Owner tickets, Ready, In progress, Review, Done, Backlog. Move a card or package by moving its block. PRD IDs refer to `docs/PRD.md`.

The build runs in waves of work packages (`docs/plan.md`, D33). Each package is one agent session on its own branch, and groups several cards. The cards keep their IDs (P1-01 and so on), and their full text is in the card reference at the end.

**Where things stand (2026-11-11).** Waves 0, 1 and 2 are merged, with the wire-up (W1-6) and the landing page (W2-11). Fixes after the waves are merged up to PR #24 (`main` at `4ec1b5d`). Staging runs on Railway with email on and Railway backups on. Left before launch: P0-07, the testers (P7-01), the gate review (P7-02), the DNS cutover (P7-03, runbook in `docs/launch-runbook.md`), retiring Netlify (P7-04), and the Owner tickets below.

## Owner tickets

These run alongside the build. Owner: Erick, unless stated. Status as of 2026-11-11, from the master's decision log.

- **T1. FAA documents** for the source library. Erick picks the documents. Claude downloads and files them. Feeds the library upload in W2-9.
  - Status: the library package is built in Erick's project folder (not in the repo): 61 FAA files with 862 checked quotes and a 103-rule index (2026-11-09). Its upload to the site's library is not recorded yet. Nothing enters the library without Erick's last look.
- **T2. NTSB reports** for the source library. Claude finds and files them. Erick approves the set.
  - Status: 35 NTSB cases and 32 rebuilt PAVE trees (105 files in the package), with Erick's answers on the review items (2026-11-09 and 2026-11-10). Upload not recorded yet.
- **T3. Aircraft set and POH data,** plus a license check on the POH data.
  - Status: the aircraft is the Warrior (PA-28-151), N41459. Its 55 POH entries are on hold until Erick sends photos of N41459's own POH (the scan on file is another Warrior's). The license check is not recorded.
- **T4. North Aero material** for the source library.
  - Status: 5 files built, including the AV1ATES inspections list (2026-11-10). Upload not recorded yet.
- **T5. Terms, privacy policy, and AI notice.** Claude drafts them. Erick approves them. No lawyer review (D32). Feeds gate G2. They cover:
  - the terms, with the fair-use limit, one person per account, and the 18+ rule
  - the privacy policy, with what North Aero can see
  - California auto-renewal rules, including the annual renewal notice
  - the AI notice
  - use of the LearnHarness name
  - Status: drafted 2026-11-08, kept in Erick's project folder until approved. Waiting for Erick's decisions on the marked items. The site shows "Coming soon." (`docs/decisions/launch-gates.md`, G2).
- **T6. Move the old ground school modules.** Claude does most of the move. Erick approves. Feeds P7-04.
  - Status: no work recorded.
- **T7. Cost test.** Feeds gate G1 and the C3 model settings.
  - Run A: one full hour on "Teach me to decode a TAF," with high thinking.
  - Run B: one full hour on "Teach me to read a winds aloft forecast," with medium thinking.
  - For each run, report the start and end time, the dollar estimate, and the cache hit rate from Session stats.
  - Also report the Cheap slot model and the Strong slot Cache setting.
  - Run A can run on staging during P0-07.
  - Status: not run. The only data so far: probe and plan $0.61 in about 10 minutes (2026-11-06), and one 45-minute student session for $2.75 (2026-11-07), both Opus 5.5 with high thinking.
- **T8. Minors.** Claude researches a path for students under 18. Erick and a lawyer decide.
  - Status: no research recorded. Launch stays 18+ only (D28).

## Ready

### P0-07. Measure memory during a live teaching turn

- **Owner:** Erick (steps 1 to 4), then Claude Code
- **Depends on:** P0-06 (done). Does not block anything else.
- **PRD:** K3
- **Erick's steps:**
  1. In the Claude Console, create an API key named `ground-tutor-staging`.
  2. Open staging, then enter that key in Settings, under Providers.
  3. Run one teaching session of at least 30 minutes. T7 Run A can be this session.
  4. When you finish, remove the key from staging Settings.
- **Claude Code's work:** read the service's memory from Railway's metrics during the session. Record the peak in `docs/decisions/` and update PRD K3.
- **Done when:** the peak memory during a live turn is recorded, and K3 is updated.
- **Note (2026-11-08):** the first real student session (2026-11-07, about 45 minutes, $2.75, Opus 5.5 with high thinking) ran outside staging, so it gives no memory reading.
- **Note (2026-11-11):** since W1-6, staging's tutors use the front door's Anthropic key through the meter, and Settings no longer shows Providers to students. Steps 1, 2 and 4 may no longer apply: a session by any staging account now counts. Also, a Stripe live key named `ground-tutor-staging` was made by mistake (decision log, "Launch list"); this card's name may be where it came from. Erick expires it (`docs/launch-runbook.md`, step A4).

### P7-01. Tester onboarding

- **Owner:** Erick, Claude drafts the consent form
- **Depends on:** W1-1, W1-2, W1-3, W1-4 and W2-6, all merged.
- **PRD:** D14, D19
- **Work:** Erick picks 3 testers. Each gives a written OK before Erick can see their session text, and Erick records it on the student's page in `/admin`. Testers use the tester promotion code (on staging it is a Stripe sandbox code).
- **Done when:** 3 testers study on staging with their consents on file.
- **Status (2026-11-11):** not started. No testers recorded.

### P7-03. DNS cutover

- **Owner:** Erick at DreamHost, Claude checks
- **Depends on:** P7-02 (every gate passed)
- **Work:** follow `docs/launch-runbook.md`: production Railway environment, Supabase, Clerk Production instance, Stripe live mode, the SES checks, then the `ground` CNAME moves from Netlify to Railway.
- **Done when:** `ground.flynorthaero.com` serves the tutor from Railway with a valid certificate, and the runbook's launch checks pass.
- **Status (2026-11-11):** runbook written. The `ground` CNAME's TTL is already 60 seconds.

### P7-04. Retire the Netlify site

- **Owner:** Erick
- **Depends on:** T6 and P7-03. Netlify stays set up until then, as the rollback for the cutover.
- **Done when:** the old site is removed from Netlify (deletes need Erick's yes).

## In progress

### P7-02. Gate review

- **Owner:** Claude records evidence. Erick signs off each gate.
- **Work:** `docs/decisions/launch-gates.md`, started 2026-11-11.
- **Status:** G4 green on `main` at `4ec1b5d`. G1 waits for T7. G2 waits for Erick's decisions on the legal drafts. G3 waits for the launch settings after T7.

## Review

(none)

## Done

### After the waves (PRs #16 to #24, merged 2026-11-08 to 2026-11-10)

Each was merged by the master after the gate and every GitHub check passed, except #21 and #22, which merged without the macOS check on Erick's yes (GitHub had no macOS machine). `main` at `4ec1b5d`: 4,292 tests pass, 0 fail, 6 skipped.

- **#16** AGPL legal notices on every screen, and `/legal/license`.
- **#17** CI retries the Electron download.
- **#18** Copy and doc fixes (the landing page's weather source, the SES setup docs).
- **#19** Security updates for npm packages (production warnings 9 to 0).
- **#20** The library page uploads many files at once.
- **#21** Checkout turns off Stripe Managed Payments, so the terms text is allowed.
- **#22** Checkout takes cards only, so the one-trial-per-card check always runs.
- **#23** The non-aviation sweep stops asking for a chat the tutor no longer has. Its migration was applied to staging's Supabase with Erick's yes.
- **#24** The export shows the chosen answers, not "[object Object]".

### Wave 2 (merged 2026-11-08)

- **W2-6. Isolation and student limits** (PR #13). Cards P1-05, P2-03, P2-04. Route table with blocked and unlisted routes refused, a secret per tenant server, `LH_HOSTED=1`, private addresses blocked in web fetches. `docs/decisions/2026-11-08-route-blocks.md`.
- **W2-7. Pause and data safety** (PR #12). Cards P2-05, P1-08, P1-09. Alert and autopause, the pause and plan-ended screens, unpause, the export zip, the day-91 delete, nightly tenant copies and restore. `docs/decisions/2026-11-08-backups.md`.
- **W2-8. Stripe** (PR #15). Cards P4-01 to P4-07. Checkout with the trial, the 2-hour trial gate, Buy now, the customer portal, webhooks, coupons, billing emails. `frontdoor/billing/README.md`.
- **W2-9. Dashboard** (PR #14). Cards P3-01 to P3-05, the threshold settings from P3-06, and P5-01. `/admin` for the Owner, the library upload page. `frontdoor/admin/README.md`.
- **W2-10. Email reports** (PR #11). Cards P6-03, P6-04, P6-05, and the sending side of P6-02. `docs/decisions/2026-11-08-email-reports.md`.
- **W2-11. Landing page and walkthrough** (PR #10). Public pages `/`, `/how-it-works`, `/help` and placeholder legal pages. Erick approves the copy before launch.
- **W1-6. Wire-up** (PR #9). Lockdown, metering and the database connected into the front door, which starts with `tsx`.
- **Docs** (PR #8). Kanban and plan after Wave 1.

Staging work done alongside (decision log): the Supabase tables loaded (2026-11-09); Erick made Owner on staging (2026-11-10); the free trial seen working on staging (2026-11-10); Amazon SES set up in `us-east-2` and email on for staging (2026-11-10, out of the SES sandbox 2026-11-11, `docs/decisions/2026-11-08-ses-checklist.md`); Railway backups turned on for staging (2026-11-10).

Not recorded as done yet, from the Wave 2 done criterion and the PRD acceptance tests: a backup restore on staging, the Stripe sandbox checks that need staging, and the C6 email checks. They are listed in `docs/decisions/launch-gates.md`.

### Wave 1 (merged 2026-11-08)

Each package ran in its own agent session, in `~/lh-wt/<branch>`. The master session checked each branch, reran the gate, and merged them in this order, fixing change-log conflicts by keeping both sides. `main` at `b974d60`: 3,791 tests, 3,786 pass, 0 fail, 5 skipped. The front door builds.

- **W1-1. Front door** (PR #7). Cards P1-01, P1-02, P1-04, P1-07. Custom Node server around Next.js (X5, approved). Clerk login gate, one tenant server per student on 127.0.0.1 with an environment allowlist, 18+ box before sign-up, pages under `/account`, `frontdoor/` as an npm workspace.
- **W1-2. Database** (PR #4). Card P1-03, widened: 17 tables and the `tenant_overview` view, row-level security with no allow rules, server-only access. Sign-in calls are safe to repeat. Supabase project `ground-tutor` created 2026-11-08.
- **W1-3. Lockdown** (PR #6). Cards P1-06, P5-02, P2-06, P1-10. File tools locked to the library, library read-only, production start check, log filter, AGPL source link, 20 MB per-file import limit.
- **W1-4. Metering** (PR #3). Cards P2-01, P2-02. Per-student pass keys, every Anthropic call and Tavily search metered per tenant, paused students refused.
- **W1-5. Reporting** (PR #5). Card P3-06 (contract tests), card P6-01 (record builder and print view), SES checklist for P6-02 in `docs/decisions/2026-11-08-ses-checklist.md`.
- **Docs** (PR #2). Waves plan, D31 to D34.

### Wave 0 (2026-11-07 to 2026-11-10)

All Wave 0 cards are done except P0-07 (in Ready).

#### P0-06. Staging on Railway, behind a password

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
- **Result:** Erick set `BASIC_AUTH`, and staging has been in use behind the password since (Erick's trials, 2026-11-10). Since W1-6 the service runs the front door (build and start commands in `frontdoor/README.md`). The proxy lets exactly `POST /account/stripe/webhook` through without the password, for Stripe (2026-11-09, proxy repo PR #1). The 401 and stream test results are not recorded in the decision log.

#### P0-01. Fork the repository

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

#### P0-02. Turn on GitHub Actions in the fork

- **Owner:** Erick
- **Depends on:** P0-01
- **Steps:**
  1. Open the **Actions** tab of `erickcfi/learnharness`.
  2. If GitHub shows a notice that workflows do not run on this fork, click **I understand my workflows, go ahead and enable them**.
- **Done when:** the Actions tab lists the **CI** workflow.
- **Result (2026-11-07):** The Owner clicked the button. Only **CI** is active. **Desktop release** and **Notify website** are turned off (Owner's choice), as a second guard on top of the push-branches-only rule.

#### P0-03. Clone the fork in Orv

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

#### P0-04. Add the fork documents

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

#### P0-05. Confirm the CI baseline

- **Owner:** Claude Code
- **Depends on:** P0-02, P0-04
- **Work:**
  1. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run lint` locally at upstream `713377f`.
  2. Record the test count and the run time in the pull request from P0-04.
- **Done when:** all four commands pass locally, and the CI workflow is green on `main`. The workflow includes the `quality` job and the 3-system `standalone` job.
- **Result (2026-11-07):** `npm ci` 47.7 s, typecheck 10.8 s, test 46.2 s, lint 4.6 s. 252 test files, 3,547 tests: 3,543 pass, 0 fail, 4 skipped. Lint: 0 errors, 1 warning (`tests/source-name-ui.test.tsx`). CI is green on `main` at `fadc7ec`.

## Backlog

Follow-ups that are not cards yet (from the decision log). Each needs the master's or Erick's go-ahead.

- **Account home page.** One `/account` page for billing, reports, sharing, export and sign-out, plus the tutor's sidebar link. The master builds it (decision 2026-11-08). Not built: the sidebar "Account" link goes to `/account/plans` for now.
- **SES bounce follow-up.** Turn reports off and tell the student after a hard bounce or complaint (SNS topic and a signed endpoint). About a day of work. Should land before many students turn reports on (`docs/decisions/2026-11-08-email-reports.md`).
- **Log filter gaps.** Node's own crash printout, and error messages that are pure unquoted student text. Revisit before testers or launch.
- **Students' AI cost in dollars** is hidden behind one constant, waiting for Erick's yes (he owns pricing).
- **Open audit warnings:** 8 moderate, dev-only (minimatch in electron-builder and typescript-eslint), with no safe fix yet (PR #19).

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

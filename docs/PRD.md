# PRD: North Aero Ground Tutor

A paid, multi-user fork of LearnHarness that becomes the whole of ground.flynorthaero.com.

| Item | Value |
|---|---|
| Owner | Erick Teeters, North Aero, Inc. |
| Status | Decisions approved 2026-11-07. X1, X2, and X4 decided. X3, X5, and X6 open (section 5). |
| Upstream | `amosblomqvist/learnharness`, commit `713377f` (2026-11-04, v0.5.0 prep) |
| Fork | `erickcfi/learnharness`, public, AGPL-3.0 |
| Decision IDs | D, N: decided (Appendix A). X: open design decision. PD: proposed default. T: ticket. G: launch gate. K: known gap. |

## How to use this document

1. Before you start any phase, read sections 1 to 5.
2. Each phase in section 8 names its requirements and its done criterion.
3. A phase is done only when its criterion is met and every upstream test is still green.
4. When this PRD does not settle a design or implementation choice, ask the Owner. Upstream's `AGENTS.md` sets the same rule (N10).

## 1. Goal

A student who reaches ground.flynorthaero.com signs up, starts a trial, and studies with LearnHarness exactly as it works today. The tutor draws on North Aero's source library. North Aero owns and runs the service. Students pay by subscription.

## 2. Scope boundaries

The fork changes only what paid, public, multi-user hosting needs (D2). These things stay as upstream builds them:

- **How LearnHarness teaches.** The prompts, the method (Measure, Plan, Teach, Practice), the agents, and the knowledge graph stay upstream's.
- **The look of the student app,** except for the login, plan, pause, and record screens this PRD adds.

These are outside the scope of this PRD:

- The desktop (Electron) app. The fork ships as a web app only (N5).
- Students under 18 at launch (D28). T8 covers this.
- An hour cap (D15).
- The flynorth login and flight_training_harness (D17, D24).

## 3. Roles

| Role | Who | Can do |
|---|---|---|
| Student | Anyone 18 or older who signs up (D1, D28) | Study, and print, email, and export their own records |
| Tester | A student who used the tester code (D14) | Same as Student, with no trial limit |
| Owner | Erick | Everything on the dashboard, plus all settings the student cannot change |
| Staff | Future (D27) | Permissions the Owner grants later. Build the role model now and launch with the Owner only. |

Each student is a **tenant**. A tenant has one account, one tenant folder, and one usage record.

## 4. Upstream facts that shape the fork

These facts come from reading upstream at `713377f`. Check them again if you rebase onto a newer upstream.

1. **One data root per process.** `config.ts` builds `PATHS`, `LEDGER_FILES`, and `SETTINGS_FILE` once, at process start, from `LH_DATA_DIR`. Every store module resolves its files from that one root. Settings (models, file access, prompts) live in `<data>/settings.json`.
2. **No login.** API keys are in the file that `LH_AUTH_FILE` names. In browser mode, `proxy.ts` lets every `/api/*` request through. `desktopAPIAuthorized` returns true when the desktop variables are unset.
3. **File tools start at the server user's home folder.** See `resolveSourcePath` in `src/agent/tools/fs-shared.ts`. Upstream already has a restricted mode with a list of allowed folders. See `src/server/file-access.ts` and the File access settings.
4. **Usage is recorded in four places.** These are chat turns, jobs, extraction runs, and notes imports. Upstream works out the dollars when it reads them, from Pi's price catalog, and never stores them. See `src/server/pricing.ts` and `src/core/cost-summary.ts`.
5. **Debug captures are switched on by environment variables:** `LH_PROVIDER_EVENTS` and `LH_BACKGROUND_CAPTURE`. The captures hold private session text.
6. **Routes students must not reach.** These routes act on server-wide settings or outside services:
   - `/api/keys`
   - `/api/claude-code`
   - `/api/custom-provider`
   - `/api/subscriptions`, `/api/subscriptions/browser`
   - `/api/stt/token`
   - `/api/settings/prompts`
   - the `models`, `customProvider`, and `fileAccess` sections of `/api/settings`
   - the model and thinking fields of `/api/chats/[id]/settings`
7. **Next.js 16** handles request interception in `proxy.ts`. Clerk's `clerkMiddleware` goes in that file. Clerk's docs also say to check access in each route handler, close to the data.
8. **Web search** adapters are in `src/server/search.ts`. The Tavily adapter sends a basic search.
9. **Tests.** `npm test` runs 252 test files at `713377f`. CI also runs `npm run typecheck` and `npm run lint`.
10. **Each session keeps the model it was born with.** `POST /api/chats` stamps the Strong slot's model and thinking level into the new session's record. Later changes to the Strong slot reach only new sessions. Settings live in each data folder's `settings.json`, so with X1-A every tenant has its own copy.
11. **Reporting routes.** `GET /api/chats` lists each session with its title and phase. `GET /api/chats/[id]/markdown` exports one whole session as markdown.
12. **All models are built in one file:** `src/agent/models.ts`. pi-ai passes each model's own base URL (`https://api.anthropic.com` for Anthropic) to the Anthropic SDK, so the SDK's `ANTHROPIC_BASE_URL` variable has no effect alone. pi-ai also accepts a custom `fetch` per request.

## 5. Design decisions

Settle each open decision with a spike (a short, throwaway experiment) before the phase that needs it. Write the spike result in `docs/decisions/`. The Owner approves the choice.

### X1. Tenant isolation model: DECIDED, option A (Owner, 2026-11-06)

One LearnHarness server process per tenant, behind a front door that we write. Each process starts with `LH_DATA_DIR` set to its tenant folder, so it can see only that folder. Upstream code stays almost unchanged (N9).

The front door has four jobs at launch:

1. Check the Clerk login.
2. Find the tenant's folder and server.
3. If that server is not running, start it.
4. Pass each request through, including server-sent event streams.

A fifth job, stopping idle servers, is left out at launch (PD4). Each tenant's server starts on first login and keeps running.

Option B (one process, with the data folder chosen per request) was rejected. It needs changes in 17 upstream files that use the fixed data paths and 7 files that hold shared in-memory state. Those changes would have to be merged by hand with every upstream update.

Spike results: about 1.5 seconds to first page, about 207 MB per server, and about 2.0 GB for 10 servers. The spike ran in Claude's workspace, not on Railway, with no model call. See `docs/decisions/2026-11-06-x1-x2-spikes.md`.

### X2. Metering method: option A is feasible (spike done 2026-11-06)

A small metering proxy records every model call and its usage, then forwards the call to Anthropic. The proxy can refuse calls for a paused tenant.

To route calls through it, change one upstream file, `src/agent/models.ts`, so that Anthropic models use the proxy's base URL (section 4, fact 12). Route Tavily searches through the same counter with a small change in `src/server/search.ts`.

Option B (read upstream's four usage records) stays as a cross-check for the proxy's totals in tests.

### X3. Backups (needed for Phase 1)

Railway's docs say services with volumes support manual and automated backups (checked 2026-11-07). Use them unless the restore test fails. If it fails, use a nightly copy to private object storage. **Done when:** a restore of one tenant folder from backup works.

### X4. How study time is counted: DECIDED (PD1, PD2)

Study time is active time, as in PD1. A $10 model-cost backstop also ends trial use (PD2). The front door measures study time.

### X5. Front door technology (needed for Phase 1)

The front door serves login, plans, Buy now, the dashboard, and the pass-through to tenant servers, including server-sent event streams.

**Recommendation:** a Next.js 16 app in a new top-level folder, `frontdoor/`, with a custom Node server for the pass-through. It uses the same language and framework as upstream. Clerk and Stripe both support Next.js directly.

**Spike:** pass a server-sent event stream from one tenant server through the front door without buffering. The Owner approves the choice.

### X6. Staging protection (needed for Phase 0)

Upstream has no login, so staging must not be open to the public before C1 lands.

**Recommendation:** Railway's Basic Auth Proxy template (nginx). It sits in front of the LearnHarness service, and the LearnHarness service gets no public domain. Its page does not say whether it passes server-sent event streams, so test that first.

**Fallback:** a temporary HTTP basic-auth check in `proxy.ts`, switched on by an environment variable and removed when C1 lands.

## 6. Fork changes

### C1. Accounts and tenant isolation

Decisions: D17, D18, D25, D28, X1 (option A). Depends on X3.

**Requirements**

1. Login uses a new Clerk application, separate from flynorth.
2. Each account maps to one tenant folder on the Railway volume: `<volume>/tenants/<tenantId>/`.
3. The front door (X1) does the four jobs listed in X1. Each tenant's LearnHarness server listens on a private port, and only the front door can reach it.
4. Each request, stream, agent tool call, and background job reads and writes only its own tenant folder.
5. Signup requires a checkbox: "I am 18 or older." The terms say the same.
6. **When a subscription ends,** the tenant folder is kept for 90 days.
   - During those 90 days, the student can export a zip of their session markdown and graph data.
   - On day 91, the tenant folder and the tenant's database rows are deleted.
   - Stripe keeps its own payment records.
7. Accounts, plans, usage, alerts, roles, and consents live in a new Supabase project for the tutor (PD5). Each table has row-level security on, and the server uses the service role.

**Acceptance tests**

- An unauthenticated request to any `/api` route returns 401.
- For every route in `app/api`, a request from tenant A for tenant B's data fails, and returns nothing of B's.
- A background job that tenant A starts writes only inside A's folder.
- With the clock mocked: a canceled tenant's data exists and exports on day 89, and is gone on day 91.

### C2. Subscriptions: plans, trial, Buy now, coupons

Decisions: D8 to D14, D9, D11, D12. Stripe facts were checked against Stripe's docs on 2026-11-06.

**Plans** (Stripe prices, all renewing automatically)

| Plan | Amount | Stripe recurring settings |
|---|---|---|
| Monthly | $69 | `interval: month` |
| 3-month | $179 | `interval: month`, `interval_count: 3` |
| Annual | $588 | `interval: year` |

**Requirements**

1. Checkout and payment go through Stripe Checkout. Card changes and cancellation go through the Stripe customer portal.
2. **Trial**
   - The trial lasts 7 days, requires a card, and starts on the monthly price.
   - It allows 2 hours of study time (X4).
   - Each email and each card (by Stripe card fingerprint) gets one trial.
3. **When the trial's study time is used up,** the tutor stops taking new turns and shows the plans. The student can still read all of their chats and records.
4. **Buy now**
   - Buy now ends the trial with `trial_end=now` and charges at once.
   - If the student picks the 3-month or annual plan, the price changes in the same update.
   - The tenant does not change, so no data is lost.
5. At day 7 with no action, Stripe charges the monthly price (D11).
6. Stripe's trial reminder email is on. Stripe sends it 7 days before the trial ends, which for a 7-day trial is the day the trial starts.
7. **North Aero student code** (D13)
   - The coupon gives 20% off with `duration: forever`, and applies to all three prices.
   - Students enter it as a promotion code.
   - Leave "first-time order only" off. Stripe blocks that code for anyone who already started a trial.
8. **Tester code** (D14)
   - The coupon gives 100% off with `duration: forever` and `max_redemptions: 3`.
   - Testers enter it as a promotion code.
   - Testers skip the trial's study-time limit.
   - The Owner removes the discount when a tester's training ends.
9. Webhooks verify their signature and are idempotent: a repeated event changes nothing.

**Acceptance tests** (Stripe test mode)

- Signup without a card is refused.
- A second trial with the same email, or with the same card, is refused.
- When the trial's study time is used up, new turns are refused, and all chats are still readable.
- Buy now on day 3 charges at once, ends the trial, and keeps every chat.
- Buy now for the annual plan from the trial charges $588 and sets the annual price.
- With no action, the monthly charge happens at day 7.
- The North Aero code takes 20% off each plan. It also works for a student whose earlier trial was canceled.
- The tester code produces $0 invoices, and a 4th redemption is refused.
- After a cancel in the portal, access lasts until the period ends. The 90-day retention from C1 starts then.

### C3. Server-held key, fixed models, metering, alert, autopause

Decisions: D5, D6, D15, D16, D29, N2, N3, N6, N11, N13. Design: X2 option A.

**Requirements**

1. One Anthropic API key, held on the server only. No student request ever returns a key, including a masked one.
2. Students cannot reach the routes in section 4, fact 6.
3. **Models are fixed by the Owner** (N2).
   - Strong slot: `claude-opus-5-5`. Its thinking level comes from T7, and stays at high until then.
   - Cheap and vision slots: the Owner sets them after T7.
   - Students cannot change the model or the thinking level, globally or in one chat. This includes the Shift+Tab cycle.
   - **Settings sync.** The Owner's model settings are one template. The front door writes the template into each tenant's `settings.json` when it creates the tenant, and again whenever the Owner changes it.
   - New sessions take the model from the template (section 4, fact 10). When the Owner changes a model or a thinking level, the Owner chooses whether existing sessions change too.
4. **Every model call a tenant causes is metered to that tenant** (D29). That includes teaching turns, background research, extraction, imports, and compaction.
   - For each call, store: tenant, time, model, input tokens, output tokens, cache read and cache write tokens, and dollars at list price.
5. **Alert and autopause** (D15)
   - An alert fires when a tenant's model cost passes $60 in a rolling 30 days.
   - Autopause starts at $89 in a rolling 30 days.
   - Both values are settings the Owner changes on the dashboard. They will be reset after T7.
6. **What a pause does** (D16)
   - The tutor stops taking new turns and jobs.
   - The student can still read, print, and export records, and billing continues.
   - The student sees: "Your account is paused for a fair-use review. Contact North Aero."
   - The Owner unpauses from the dashboard.
7. Web research is on (D5), using Tavily (N11). Count each tenant's searches, and show the fee (searches × $0.008) on the dashboard.
8. Dictation is off (N13).
9. Debug captures are off (N6). In production, the server refuses to start if `LH_PROVIDER_EVENTS` or `LH_BACKGROUND_CAPTURE` is set.

**Acceptance tests**

- A student request to any route in section 4, fact 6, is refused.
- A request to change the model or the thinking level is refused, and the Owner's setting stays in effect.
- For a scripted session, metered dollars equal the provider's reported usage times list price, within one cent.
- A background research job's cost lands on the tenant that started it.
- Crossing $60 creates one alert. Crossing $89 pauses the tenant. A paused tenant's turn request is refused. Unpausing restores access.
- A production start with `LH_PROVIDER_EVENTS=1` fails.

### C4. Source library

Decisions: D4, D23. Contents: T1 to T4.

**Requirements**

1. **One library folder** sits on the volume at `<volume>/library/`. It is outside the repo and private.
   - Its layout: `faa/`, `ntsb/`, `poh/<aircraft>/`, `north-aero/`.
2. Every tenant reads the same library. Students cannot change it.
3. The Owner adds and replaces library files through an upload page on the dashboard (PD6).

**Acceptance tests**

- An agent in any tenant can read a file in each library subfolder.
- A student request to write, rename, or delete a library file is refused.

### C5. File access locked to the library

Decisions: D2, N4.

**Requirements**

1. Agent file tools run in upstream's restricted mode, with exactly one allowed folder: the library.
2. The File access setting is fixed by the Owner. Students cannot change it.
3. Students can import their own PDFs and notes through the upstream import route (N4).
   - Each file has a size limit (PD3).
   - The model cost of an import counts toward that tenant's usage.

**Acceptance tests.** Each of these attempts fails:

- `/etc/passwd`
- a path into another tenant's folder, including through `..`
- `~/.ssh`
- the file named by `LH_AUTH_FILE`
- any `.env` file
- a symlink that points out of the library

A read inside the library succeeds. Add a test that tries many path-traversal spellings.

### C6. Records: print and email

Decisions: D20, D26, N1, N8, N12. SES facts were checked against the Amazon SES docs on 2026-11-06.

**Requirements**

1. **Print view.** One record of the student's study:
   - each session's date, length, and topics
   - progress on their plans
   - a summary of what they learned, from the graph
2. **The label.** Every page and every email carries: "Self-study record. Not a logbook entry or instructor endorsement." (N8)
3. **Email reports.** There are two kinds: one after each session, and one each week.
   - In setup, the student turns each kind on or off, and sets the address. Any address is allowed (N12, D20).
   - Every email has an unsubscribe link.
4. **Sending identity** (N1)
   - SES domain identity: `ground.flynorthaero.com`, with Easy DKIM. That means three CNAME records at `<token>._domainkey.ground.flynorthaero.com`.
   - From: `reports@ground.flynorthaero.com`.
   - Custom MAIL FROM: a dedicated subdomain, for example `bounce.ground.flynorthaero.com`. It has exactly one MX record and one SPF TXT record, and is used for nothing else.
   - Reply-To: `info@flynorthaero.com` (PD7).
5. **DNS:**
   - None of the SES records sit on the name `ground.flynorthaero.com` itself, so the website record stays as it is.
   - `reports.flynorthaero.com` stays free for flynorth.
   - Use a separate SES configuration set from flynorth's list.

**Acceptance tests**

- The print view renders with the label on every page.
- A session-end report reaches the address set for it.
- The weekly report sends once a week.
- Turning a report off stops it.
- DKIM passes on a test message.

### C7. Admin dashboard

Decisions: D19, D21, D27, N7.

**Requirements**

1. The dashboard lives at `/admin`. Only the Owner can open it at launch.
   - Roles (owner, staff) are stored in the tutor's database.
   - Every admin route checks the role on the server.
2. **The dashboard shows:**
   - each tenant's plan, status (trial, active, paused, canceled, retention), and coupon
   - study hours, sessions, and topics
   - model cost and search fees against revenue, per tenant and in total
   - trial-to-paid conversion
   - alerts, with pause and unpause
   - non-aviation flags
3. **Session text** (D19)
   - The dashboard shows session text only for testers who gave written OK, and for students who opted in.
   - Opt-in is a student setting, off by default.
   - Store each consent with its date.
4. **Non-aviation flag** (N7)
   - After each session, `claude-haiku-5-5` labels the session topic as aviation or not aviation.
   - The label uses the topic and plan only, never session text the student has not consented to share.
   - The flag has no effect on the tutor.
5. The alert and autopause values (C3) can be edited here.
6. **Data sources.** Each dashboard number comes from one source:

   | Dashboard number | Source | Reads inside LearnHarness? |
   |---|---|---|
   | Plan, status, coupon, revenue, conversion | Stripe webhooks, stored in Supabase | No |
   | Model cost, search fees, alerts, pause state | The metering proxy (X2), stored in Supabase | No |
   | Study hours and session count | The front door, which sees every request and stream (PD1) | No |
   | Topics | `GET /api/chats` on the tenant's own server (section 4, fact 11) | Yes, read-only, through upstream's API |
   | Session text, consent only | `GET /api/chats/[id]/markdown` on the tenant's own server | Yes, read-only, through upstream's API |
   | Non-aviation flag | Haiku 5.5 labels the topics from the row above | Uses the topic list |

   Every tenant server runs all the time (X1, PD4), so the dashboard can query any tenant at any time.
7. **Contract tests** check the response shape of `GET /api/chats` and `GET /api/chats/[id]/markdown`. They run in CI and on every upstream merge, so an upstream change that would break reporting turns the build red.

**Acceptance tests**

- A student gets 403 on every `/admin` route.
- Study hours on the dashboard match the front door's records for a scripted session.
- Model cost on the dashboard matches the metering proxy, and the proxy matches upstream's own usage records within one cent.
- With consent off, no session text appears for that tenant.
- A seeded cooking session is flagged. A seeded METAR session is not.
- Pause and unpause work from the dashboard, end to end.

### Cross-cutting requirements

1. **AGPL.** The app footer links to the source of `erickcfi/learnharness`, at the deployed commit. The library, tenant data, and secrets stay out of the repo.
2. **Secrets** live only in Railway environment variables.
3. **Logs** carry no session text and no email addresses.

## 7. Infrastructure

| Part | Choice |
|---|---|
| Hosting | Railway Pro: one service and one volume holding `tenants/` and `library/` (D22). Staging runs on a Railway-generated address. |
| Database | A new Supabase project for the tutor (PD5) |
| Login | A new Clerk application (D17) |
| Payments | Stripe, built and tested in test mode first |
| Email | Amazon SES, as in C6 |
| Search | Tavily |
| DNS | At cutover, `ground.flynorthaero.com` points to Railway. The Netlify site stays live until then (D3). |

## 8. Phases

Every phase is done only when all of these are true:

- `npm test`, `npm run typecheck`, and `npm run lint` are green.
- The phase's own acceptance tests are green.
- The Owner has seen the result.

| Phase | Work | Done when |
|---|---|---|
| 0 | Fork. Set up CI. Deploy upstream unchanged to staging, protected as in X6. Measure memory during a live model turn on Railway. (The X1 and X2 spikes are done.) | The fork is public and CI is green at `713377f`. Staging runs. Live-turn memory is recorded in `docs/decisions/`. |
| 1 | X5 first, then C1 and C5, plus X3. Security comes first. | The C1 and C5 tests are green, and a backup restore works. |
| 2 | C3 | The C3 tests are green. |
| 3 | C7 | The C7 tests are green. |
| 4 | C2, with study time as in X4 | The C2 tests are green in Stripe test mode. |
| 5 | C4. Start with sample files until T1 is ready. | The C4 tests are green. |
| 6 | C6 | The C6 tests are green. |
| 7 | 3 testers use staging, with consents on file. Clear the launch gates. Switch DNS. | Every gate in section 9 passes. |

## 9. Launch gates

- **G1. Cost.** The measured average cost per study hour supports $69.
  - At 20 study hours a month, the 2x rule (D7) needs $1.73 an hour or less.
  - The current data point: probe and plan cost $0.61 in about 10 minutes (Opus 5.5, high thinking). That is $3.66 an hour for that phase only.
  - T7 measures full study hours.
- **G2. Legal.** The legal review (T5) is done. It covers:
  - the terms, including the fair-use limit and one person per account
  - the privacy policy, including what North Aero can see (D19)
  - California auto-renewal rules, including the notice before an annual renewal
  - the AI notice
  - the 18+ rule
- **G3. Model check case 1 passes** on the launch settings.
  - Prompt: "Teach me to decode a METAR."
  - To pass, the tutor must ask the right staging questions, write correctly formatted METARs, and build a complete, useful plan.
  - The Owner judges the result. Sonnet 5.5 failed this case on 2026-11-06.
- **G4. Tests.** Every test is green, including the isolation and file lockdown tests.

## 10. Tickets

| ID | Ticket | Owner |
|---|---|---|
| T1 | Source library: FAA documents | Erick |
| T2 | NTSB reports | Erick, with Claude's help |
| T3 | Aircraft set, POH data, and a license check on the POH data | Erick |
| T4 | North Aero material | Erick |
| T5 | Legal review | Erick and a lawyer |
| T6 | Move the old ground school modules | Erick |
| T7 | Cost test: Run A (high thinking, 1 hour) and Run B (medium thinking, 1 hour). Report each run's cost, length, and cache hit rate, plus the Cheap slot model and the Strong slot Cache setting. | Erick |
| T8 | Minors: research a path for students under 18, such as accounts owned by a parent or guardian | Claude researches. Erick and a lawyer decide. |

## 11. Defaults

| ID | Default | Why |
|---|---|---|
| PD1 | APPROVED 2026-11-07. Study time is active time: the tab is visible, and the student acted in the last 5 minutes. | A student understands time. Idle tabs do not use up the trial. |
| PD2 | APPROVED 2026-11-07. A $10 model-cost backstop also ends trial use, even before 2 hours. | Heavy background research could pass the trial's expected cost. $10 is above 2 hours at the $3.66 rate measured so far. |
| PD3 | APPROVED 2026-11-07. Imports are limited to 20 MB per file. | Limits cost and storage on the shared server. |
| PD4 | APPROVED 2026-11-06. No idle stop at launch. Each tenant server keeps running. Add idle stop when the memory cost justifies it. | About $2.07 a month per tenant at about 207 MB. Leaves out the hardest front-door job. |
| PD5 | APPROVED 2026-11-07. A new Supabase project for the tutor, separate from flynorth | Matches the separate login (D17). Keeps student data apart. |
| PD6 | APPROVED 2026-11-07. Library files are uploaded through an Owner page on the dashboard. | No server access needed. |
| PD7 | APPROVED 2026-11-07. Reply-To on reports: `info@flynorthaero.com` | Mail sent to `reports@` cannot be received at that address. |

## 12. Known gaps

- **K1.** The real cost per study hour. T7 closes it.
- **K2.** The average study hours per student. Tester data closes it.
- **K3.** Railway's monthly cost. Railway charges $10 per GB of memory per month. At about 207 MB per tenant server, that is about $21 a month for 10 tenants and about $207 for 100. Memory during a live model turn is not measured yet.
- **K4.** What a second Clerk application costs. Not checked.
- **K5.** Search cost. It is $0.008 per Tavily basic search. The number of searches per session is not measured.
- **K6.** The Cheap slot model and the Cache setting in the Owner's own LearnHarness. T7 closes it.

## Appendix A. Decision log

Each decision is stated here once. The requirements cite these IDs.

| ID | Decision |
|---|---|
| D1 | The tutor is the whole ground.flynorthaero.com site, behind a login. North Aero owns it. Anyone can sign up. |
| D2 | LearnHarness keeps teaching the way it does now. Fork changes are limited to what paid, public, multi-user hosting needs. |
| D3 | The old modules move elsewhere and are not a source. The Netlify site stays live until the app passes its tests. |
| D4 | Erick compiles the sources: FAA documents, NTSB reports, POH data for a chosen aircraft set, and North Aero material. |
| D5 | Web research is on at launch. |
| D6 | The model is Opus 5.5. A replacement must pass model check case 1. |
| D7 | The price rule is 2 times the measured average model cost. |
| D8 | Prices: $69 monthly, $179 every 3 months, $588 a year. All renew automatically. |
| D9 | Everyone pays. Payment is through Stripe Checkout. Card changes and cancellation are through the Stripe customer portal. |
| D10 | The trial is 7 days and 2 hours of use, with a card required. One trial per email and per card. |
| D11 | The trial converts to monthly at day 7. The 3-month and annual plans are bought with Buy now. |
| D12 | Buy now ends the trial and charges at once, with nothing lost. When the trial's study time runs out, the tutor stops and shows the plans. |
| D13 | North Aero students: a promotion code for 20% off, all plans, for as long as they subscribe. Not limited to first-time orders. |
| D14 | 3 testers, picked by Erick: 100% off while they train at North Aero. The code works 3 times only. Testers skip the trial limit. |
| D15 | No hour cap. Alert at $60 and autopause at $89 of model cost per 30 days. Alerts show on the dashboard only. |
| D16 | A pause stops the tutor only. Billing continues and records stay available. The terms state the fair-use limit. |
| D17 | Login: a new Clerk application, separate from flynorth. |
| D18 | Each student's LearnHarness data is in their own folder on the Railway disk. Accounts, plans, usage, and alerts are in Supabase. |
| D19 | The Owner sees usage numbers and topics for all students. Session text only for testers with written OK and students who opt in. The privacy policy says so. |
| D20 | Records belong to the student. They can be printed. Email reports are optional and can go to any address. |
| D21 | Admin dashboard contents, as in C7. |
| D22 | Hosting: Railway. |
| D23 | Public fork `erickcfi/learnharness`, with a source link in the app. The library and student data stay private. |
| D24 | flight_training_harness stays separate. |
| D25 | Data is kept 90 days after cancellation, with export, then deleted. |
| D26 | Email reports: one after each session, and one weekly. |
| D27 | The Owner only at launch. Roles allow staff access later. |
| D28 | No signups under 18 at launch. A checkbox confirms 18 or older. |
| D29 | Every model call a tenant causes counts toward that tenant's usage, including background research. |
| D30 | Tenant isolation: one LearnHarness server per tenant, behind our own front door (X1, option A). No idle stop at launch (PD4). |
| N1 | Email is sent from `reports@ground.flynorthaero.com` through Amazon SES. |
| N2 | Students cannot change the model or the thinking level. |
| N3 | Students cannot see or enter API keys. Provider settings are hidden. |
| N4 | Students can import their own PDFs and notes, with a size limit. The cost counts toward their usage. |
| N5 | Web app only. No desktop app. |
| N6 | Debug captures are off in production. |
| N7 | Haiku 5.5 labels each session topic as aviation or not aviation, for the dashboard flag. |
| N8 | Records carry the label "Self-study record. Not a logbook entry or instructor endorsement." |
| N9 | The fork stays close to upstream, with new code in separate files where possible. |
| N10 | Build sessions follow upstream's `AGENTS.md`: ask, never guess a design decision. |
| N11 | The search provider is Tavily. |
| N12 | The student turns each report type on or off in setup, and sets the address. |
| N13 | Dictation is off at launch. |

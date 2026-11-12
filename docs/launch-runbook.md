# Launch runbook: ground.flynorthaero.com

| Item | Value |
|---|---|
| Status | Draft for Erick's review, written 2026-11-11. Nothing in it has been done yet. |
| Cards | P7-03 (DNS cutover), with the launch list from the decision log. Gate evidence is in `docs/decisions/launch-gates.md` (P7-02). |
| Who | **Erick** does every step that costs money, opens or changes an outside account, enters a secret, or deletes something. **Claude** checks, runs commands Erick approves, and updates the docs. |
| Secrets | Never in this repo, in chat or in email. Erick types each one into the vendor page or into Railway himself. |
| Vendor docs | Each section cites the vendor page it was checked against on 2026-11-11, and lists what could not be confirmed. Dashboard labels change often: if a label here does not match, look for the page that does the same job. |

## Words used here

- **Environment** (Railway): a separate copy of the project's services, with its own variables, volumes and domains. `staging` exists today. This runbook adds `production`.
- **Service** (Railway): one running program. Staging has two: `learnharness` (the app: front door plus one tutor server per student) and `staging-proxy` (the nginx password gate in front).
- **Volume** (Railway): the service's disk. It holds every student's folder and the library, mounted at `/data`.
- **Variable** (Railway): a setting the app reads at start, such as a key. Secrets live only here.
- **Deploy**: build the code and start it. **Redeploy**: do it again with the same code, for example after a variable change.
- **Instance** (Clerk): Clerk's login service has a Development instance (staging uses it) and a Production instance (launch).
- **Live mode** and **sandbox** (Stripe): live mode moves real money. The sandbox (test mode) does not. Each has its own keys, products and settings.
- **Webhook**: a message Stripe sends to our site when something happens, such as a payment.
- **Restricted key**: a Stripe key that can do only the jobs you tick.
- **Coupon** and **promotion code** (Stripe): the coupon is the discount. The promotion code is the word a student types to get it.
- **Migration**: a file that creates or changes database tables. They run in order, once each.
- **DNS record**: one line in the domain's address book. **CNAME** says "this name is another name". **TXT** holds text, often a proof of ownership. **MX** says where mail for a name goes.
- **TTL** (time to live): how long other servers may remember a DNS answer before asking again.
- **Certificate**: what makes the padlock (HTTPS) work. Railway and Clerk get theirs from Let's Encrypt once DNS points at them.
- **Cutover**: the moment `ground.flynorthaero.com` stops pointing at Netlify (the old ground school site) and starts pointing at Railway.
- **Roll back**: put things back the way they were.

## The order at a glance

Phase A happens on the days before launch. Nothing a visitor sees changes in Phase A. Phase B is launch day.

| Step | What | Who | Public effect |
|---|---|---|---|
| A0 | Decisions before any setup | Erick | None |
| A1 | Supabase database for production | Erick, then Claude with Erick's yes | None |
| A2 | Railway `production` environment | Erick, Claude helps | None |
| A3 | Clerk Production instance and its DNS records | Erick | None (new names only) |
| A4 | Stripe live mode | Erick | None until students sign up |
| A5 | Amazon SES: nothing to change, checks only | Claude | None |
| A6 | DNS preparation: TTL and the Railway TXT record | Erick at DreamHost, Claude checks | None |
| A7 | First production deploy and smoke checks | Claude with Erick's yes | None |
| B1 | Go or no go | Erick | None |
| B2 | Cutover: the `ground` CNAME moves to Railway | Erick at DreamHost | The site changes |
| B3 | Launch checks, sign-up and trial | Claude and Erick | |
| B4 | Roll back, only if needed | Erick at DreamHost | The old site returns |
| C | The week after | Both | |

## A0. Decisions before any setup (Erick)

1. **The launch date and hour.** Pick a quiet hour, for example a weekday evening, Pacific time. The certificate can take up to an hour after the cutover (step B2).
2. **The gates.** G1 to G4 in `docs/decisions/launch-gates.md`. G2 matters early: Stripe's terms box needs the published terms page (step A4).
3. **Supabase: a new project or reuse staging's** (step A1). Recommended: new.
4. **How production deploys** (step A2, item 6). Recommended: not on every merge to `main`.
5. **Which Anthropic key production uses.** Recommended: a new Claude Console key just for production, so its cost shows apart from staging's.

## A1. Supabase database for production

**Who:** Erick creates the project (it costs money). Claude applies the migrations, only after Erick says yes (`frontdoor/db/README.md`).

**The choice.**

- **New project (recommended).** Production starts with clean data. Staging keeps its test accounts, its Stripe test-mode customer ids and Erick's staging Owner account, and stays usable for testing. Cost: about $10 a month more (the master's note when the staging project was made, 2026-11-08). Erick confirms the price on Supabase's billing page.
- **Reuse the staging project.** No new cost. But staging data and test-mode Stripe ids would sit next to live ones, and staging would then need a new project of its own. Not recommended.

**Steps (new project).**

1. In the Supabase dashboard, open the North Aero organization and create a new project. Suggested name: `ground-tutor-production`. Region: the same as staging (West US, North California). Save the database password in your password manager only.
2. Turn off the Data API (the web API the tutor does not use; decision 2026-11-08). Supabase's current docs put the switch under **Integrations > Data API**, **Enable Data API**. Older docs show it under the API settings. Either way, turn it off.
3. Open the **Connect** panel and copy the **Session pooler** connection string (IPv4, port 5432). It holds the password. It goes only into Railway's `SUPABASE_DB_URL` for production (step A2).
4. **Migrations.** Apply the 7 files in `frontdoor/supabase/migrations/`, oldest first, after Erick's yes:
   - `20261108000100_accounts_tenants.sql`
   - `20261108000200_usage_alerts_pauses.sql`
   - `20261108000300_billing.sql`
   - `20261108000400_study_reports_labels.sql`
   - `20261108000500_owner_settings_overview.sql`
   - `20261108001000_report_sends_sitting.sql`
   - `20261110000100_topic_labels_chat_not_found.sql`

   Two ways: the Supabase CLI commands in `frontdoor/db/README.md` (a `--dry-run` first), or the Supabase tool the master used for staging (2026-11-09 and 2026-11-10). Use one way for this project and keep to it, so the record of applied files stays in one place.

**Check after.**

- 17 tables and the `tenant_overview` view exist.
- The security advisor shows only the expected "RLS enabled, no policy" notices (INFO), as on staging.
- `owner_settings` has one row: alert $60, autopause $89.
- **Database > Backups** lists scheduled daily backups. Supabase says daily backups come with the Pro plan and are kept 7 days.

**Roll back.** Nothing uses the project until Railway points at it. To stop the cost, pause the project. Deleting it cannot be undone and needs Erick's yes.

**Sources:** [Supabase database backups](https://supabase.com/docs/guides/platform/backups), [Data API](https://supabase.com/docs/guides/database/data-api), [Hardening the Data API](https://supabase.com/docs/guides/api/hardening-data-api).

**Not confirmed:** the exact menu path of the Data API switch (Supabase's two pages disagree); the current price of a new project.

## A2. Railway `production` environment

**Who:** Erick creates the environment and enters every secret. Claude can copy non-secret settings, with Erick's yes for each change (`docs/plan.md`).

**What production has.** One service, the app (`learnharness`), with its own volume and backups. **No `staging-proxy`:** the front door's own login protects production (D31 says the proxy retires when C1 lands). The custom domain goes straight on the app service (step A6).

**Steps.**

1. Railway, project `ground-tutor`. Open the environment menu at the top and choose **+ New Environment** (or **Settings > Environments**). Name: `production`. Railway offers two kinds:
   - **Duplicate Environment** copies the services, variables and configuration of staging, and stages everything for review before any deploy.
   - **Empty Environment** starts with no services.

   Recommended: duplicate staging, because it keeps the build and start commands, the Node version and the CI wait. Then, **before you approve the staged changes**, do items 2 to 5. The copy also holds `staging-proxy` and staging's secret values. Every secret must be replaced (item 4), and `staging-proxy` must not run in production. Removing it from production is a delete, so it needs Erick's yes.
2. **Volume.** The app service needs its own volume mounted at `/data`. Check on the canvas that the production service shows a volume that is not staging's `ground-tutor-data`. If it has none, add one (right-click the canvas or the command palette, then pick the service) and set the mount path to `/data`.
3. **Backups.** Service > **Backups** tab: turn on **Daily** and **Weekly**, leave **Monthly** off, and make one backup by hand. This is the plan in `docs/decisions/2026-11-08-backups.md` (deleted student data leaves every backup within 27 days). Erick's yes, as on staging.
4. **Variables** for the production app service. Every secret is new or changes. Names and meanings are in `frontdoor/README.md`.

   | Variable | Production value | Same as staging? |
   |---|---|---|
   | `FRONTDOOR_SESSION_SECRET` | New random value (`openssl rand -base64 48`) | No |
   | `FRONTDOOR_PASS_KEY_SECRET` | New random value, different from the one above | No |
   | `LH_TRIAL_HASH_KEY` | New random value. Keep a copy in your password manager. **Never change it after launch.** | No |
   | `CLERK_SECRET_KEY` | Production instance key, `sk_live_...` (step A3) | No |
   | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Production instance key, `pk_live_...` (step A3). Read at build time, so a change needs a new build, not only a restart. | No |
   | `CLERK_JWT_KEY` | If staging sets it: the Production instance's key, or leave it unset | No |
   | `FRONTDOOR_AUTHORIZED_PARTIES` | `https://ground.flynorthaero.com` | No |
   | `ANTHROPIC_API_KEY` | A production Claude Console key (A0, item 5) | Erick's choice |
   | `TAVILY_API_KEY` | The Tavily key | Erick's choice |
   | `SUPABASE_DB_URL` | The production project's session pooler string (step A1) | No |
   | `STRIPE_SECRET_KEY` | The live restricted key, `rk_live_...` (step A4) | No |
   | `STRIPE_WEBHOOK_SECRET` | The live endpoint's signing secret, `whsec_...` (step A4) | No |
   | `SES_REGION` | `us-east-2` | Yes |
   | `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | The `ground-tutor-ses-sender` key. Optional: make that user's second access key for production, so staging's key can be changed alone. | Erick's choice |
   | `FRONTDOOR_PUBLIC_URL` | **Not set.** Unset means `https://ground.flynorthaero.com`. Remove it if the duplicate copied staging's address. | No |
   | `FRONTDOOR_BILLING` | **Not set.** The front door refuses `off` on the launch address. | |
   | `RAILPACK_NODE_VERSION`, `PORT` | As on staging (`26`, `3000`) | Yes |

   Never set in production: `LH_PROVIDER_EVENTS`, `LH_BACKGROUND_CAPTURE`, `DEEPGRAM_API_KEY` (the front door refuses to start) and `FRONTDOOR_DEV`. Old upstream variables from P0-06 (`LH_DATA_DIR`, `LH_AUTH_FILE`) do nothing: tenant servers never see the front door's variables.

   The promotion code words are **not** app variables. Only the Stripe setup script reads them (step A4).
5. **How production deploys.** Staging deploys `main` after GitHub's checks pass (Railway's **Wait for CI**). If production did the same, every merge would reach paying students at once. Choices for Erick:
   - (a) The same as staging: every merge to `main` goes live.
   - (b) A separate branch, for example `production`, moved forward by hand once staging looks good.
   - (c) Automatic deploys off. Each production deploy is started by hand.

   Recommended: (b) or (c). Railway's docs show an environment deploying from its own branch.
6. **No custom domain yet.** It is added in step A6.

**Two Railway habits seen on staging.**

- On 2026-11-10 a variable change made through Railway's API did not start a new deployment. After any variable change, check that a new deployment started. If not, redeploy by hand.
- With Wait for CI on, Railway skips a deploy when a GitHub check fails or is cancelled. GitHub's macOS machines were short several times (PRs #21 and #22). A skipped deploy needs a deploy by hand.

**Check after.** The production canvas shows one app service, its own volume at `/data`, the backup schedule, and no `staging-proxy`. Every variable in the table is set or unset as listed. Nothing is deployed yet unless step A7 has run.

**Roll back.** Nothing public points at production yet. Leave it idle, or remove the environment (a delete: Erick's yes).

**Sources:** [Railway environments](https://docs.railway.com/environments), [volumes](https://docs.railway.com/volumes), [volume backups](https://docs.railway.com/volumes/backups), [GitHub autodeploys and Wait for CI](https://docs.railway.com/guides/github-autodeploys). AWS: [Manage access keys for IAM users](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html) ("a maximum of two access keys per user").

**Not confirmed:** whether a duplicated environment gets a new empty volume or something else; whether domains are copied; how to keep one service out of one environment (Railway's environment page does not say). Check the staged changes on the canvas before approving them.

## A3. Clerk Production instance

**Who:** Erick (his Clerk account). Claude checks the DNS records from outside.

**Found on 2026-11-11:** flynorth's own Clerk login already uses the root-domain names: `clerk.flynorthaero.com`, `accounts.flynorthaero.com`, `clkmail.flynorthaero.com` and `clk._domainkey.flynorthaero.com` all point at Clerk today. So the tutor's Clerk must live under `ground.flynorthaero.com`, not on the root domain. This also keeps the tutor's logins apart from flynorth's (D17).

**Steps.**

1. Clerk Dashboard, the **North Aero Ground Tutor** application. At the top, select **Development** to open the instance menu, then **Create production instance**. Choose to clone the development settings (sign-in methods and the rest). Clerk says **SSO connections**, **Integrations** and **Paths** do not copy over.
2. **The domain.** Use `ground.flynorthaero.com`. Clerk's domain dialog has two kinds:
   - **Primary application:** the app on the subdomain, Clerk on the root domain (`clerk.flynorthaero.com`). **Do not use this.** That name is flynorth's.
   - **Secondary application:** the app and Clerk both under the subdomain (`clerk.ground.flynorthaero.com`). **Use this.**

   If the create step does not ask, open **Domains**, **Configure** next to the domain, then **Danger zone > Change domain**, and pick the subdomain kind there.
3. **DNS records.** Open Clerk's **Domains** page. It lists each record to add. Going by flynorth's live records, expect five CNAMEs under `ground.flynorthaero.com`: `clerk.ground`, `accounts.ground`, `clkmail.ground`, `clk._domainkey.ground` and `clk2._domainkey.ground`. Copy each name and value from Clerk's page, not from here.
   - At DreamHost: **Manage Websites**, the three dots next to `flynorthaero.com`, **DNS Settings**, then add each as a custom CNAME record. Enter only the part before `.flynorthaero.com` (for example `clerk.ground`).
   - None of these names may be `ground` itself, `bounce.ground`, or an SES DKIM name (`<token>._domainkey.ground`). They are not: Clerk's DKIM names start with `clk`.
   - Do not add `ground.flynorthaero.com` as its own domain in the DreamHost panel. The records under it live in the `flynorthaero.com` zone today.
4. Wait for Clerk to show each record verified. Clerk says DNS can take up to 48 hours. Then click **Deploy certificates**. If certificates hang more than a few minutes, Clerk says to check for CAA records on the root domain (`dig flynorthaero.com +short CAA`). Netlify's Let's Encrypt certificate works for `ground` today, so any CAA record allows Let's Encrypt. Clerk may also use Google Trust Services.
5. **Sign-in methods.** If Google sign-in is on, production needs Erick's own Google OAuth credentials. Clerk's shared development credentials do not work in production.
6. **Paths.** Set them again if staging's instance had any. The code already sends students to `/account/sign-in` and `/account/sign-up`.
7. **Keys.** On the Production instance's **API keys** page, copy `pk_live_...` and `sk_live_...` into the production Railway variables (step A2). Staging keeps its test keys.
8. **Allowed origins.** Clerk's production guide says to set `authorizedParties`, the list of sites allowed to use the login, to block cross-site attacks. The front door reads it from `FRONTDOOR_AUTHORIZED_PARTIES`. In production it is only `https://ground.flynorthaero.com` (step A2).
9. **Users do not move.** Clerk does not copy users from Development to Production. Erick signs up again on the live site and is made Owner again (step B3).

**Check after.** Every record on Clerk's Domains page is verified, and the certificates are issued. From any computer, `dig +short CNAME clerk.ground.flynorthaero.com` answers with a Clerk name.

**Roll back.** Nothing uses the Production instance until Railway has its keys. If launch is called off, the new DNS records can stay or be removed (Erick's yes). Do not touch flynorth's `clerk.`, `accounts.`, `clkmail.` or `clk` records.

**Cost.** Clerk's pricing page lists a free Hobby plan with a custom domain and up to 50,000 monthly retained users. It does not say whether a Production instance needs a paid plan (PRD K4). Erick checks.

**Sources:** [Deploy your Clerk app to production](https://clerk.com/docs/guides/development/deployment/production), [Change domain or subdomain](https://clerk.com/docs/guides/development/deployment/changing-domains), [Clerk pricing](https://clerk.com/pricing), [Clerk migration overview](https://clerk.com/docs/deployments/migrate-overview) (users cannot move from Development to Production). DreamHost: [Adding custom DNS records](https://help.dreamhost.com/hc/en-us/articles/360035516812).

**Not confirmed:** the exact list of Clerk's DNS records (Clerk's docs send you to the Domains page; the five names above come from flynorth's live records); whether the create-production step asks the primary or secondary question; whether Clerk offers an allowlist of subdomains for this setup (its production page recommends one when the root domain is used).

## A4. Stripe live mode

**Who:** Erick (his Stripe account, real money). Claude does not see or handle live keys.

All of these settings were made in the sandbox for staging. Live mode has its own copy of each. Several email switches are greyed out in the sandbox and exist only in live mode (decision log, "Launch list, Stripe live mode").

**Steps.**

1. **Account.** In live mode, check that the Dashboard asks for nothing more (business details, bank account) before it can take payments. On 2026-11-09 the master recommended a separate Stripe account for the tutor. Do these steps in the account staging's sandbox belongs to.
2. **Expire the mistaken live key** named `ground-tutor-staging`. On the **API keys** page in live mode, open the key's menu (the three dots) and first choose **View request logs** to see whether anything used it. Then choose **Expire key** and confirm. This cannot be undone, and it is Erick's own step. Also check that staging's `STRIPE_SECRET_KEY` in Railway starts with `sk_test_` or `rk_test_`, not `_live_`.

   Note: `ground-tutor-staging` is also the name `docs/kanban.md` (P0-07) gives a Claude Console key. The Stripe key may have been made from that card by mistake.
3. **Public details** (**Settings > Public details**): business name, support email `info@flynorthaero.com`, a statement descriptor such as `NORTHAERO GROUND`, and the **Terms of service** URL `https://ground.flynorthaero.com/legal/terms` (also the privacy URL). Checkout's terms box needs the terms URL. The terms must be approved and published first (gate G2).
4. **Products, prices, coupons and promotion codes.** Run the setup script in live mode (`frontdoor/billing/README.md`). It makes the product `north-aero-ground-tutor`, three prices with lookup keys `ground_tutor_monthly`, `ground_tutor_quarterly`, `ground_tutor_annual`, the coupons `north-aero-student-20` and `north-aero-tester-100`, and their promotion codes.
   - The prices come from `frontdoor/plans/index.ts` ($69, $179, $588). Prices are Erick's call (D34, gate G1). Confirm them before this step.
   - The script needs a live key that can create products, prices, coupons and promotion codes. The app's restricted key (item 8) cannot. Make a short-lived live restricted key for the script, run it, then expire that key.
   - Erick runs it in his own Ubuntu terminal, so the key never reaches chat:

     ```bash
     STRIPE_SECRET_KEY=<live setup key> STRIPE_STUDENT_PROMO_CODE=<student code> STRIPE_TESTER_PROMO_CODE=<long random tester code> npm run stripe:setup -w frontdoor -- --live --dry-run
     ```

     Read what it would change, then run it again without `--dry-run`.
   - The promotion codes are the words students type. Erick picks them. The live codes can match the sandbox words or be new. The tester code works 3 times in all (D14). Never write them in the repo or chat.
5. **Webhook endpoint** (live). Stripe's current docs: **Workbench**, the **Webhooks** tab, **Create an event destination**, **Your account**, payload **Snapshot** with API version `2026-10-28.endive`, select the events listed in `frontdoor/billing/README.md` step 3, **Continue**, **Webhook endpoint**, then the endpoint URL `https://ground.flynorthaero.com/account/stripe/webhook`. On the endpoint page, reveal the signing secret (`whsec_...`) and put it in production's `STRIPE_WEBHOOK_SECRET`.
   - Until the cutover, the URL reaches Netlify, so deliveries would fail. That is fine: there are no live customers yet, and Stripe retries live events for up to 3 days.
6. **Subscriptions and emails** (**Settings > Billing > Subscriptions and emails**, `dashboard.stripe.com/settings/billing/automatic`), in live mode, as in `frontdoor/billing/README.md` step 4:
   - "Send a reminder email 7 days before a free trial ends": on, with the link to a Stripe-hosted page.
   - "Send emails about upcoming renewals": off (the tutor sends its own annual notice).
   - Upcoming renewal events: 30 days.
   - Smart Retries on. If all retries fail: cancel the subscription.
   - The Stripe-hosted link for payments that need confirmation (3D Secure): on.
   - The Stripe-hosted subscription management link: on.
7. **Customer portal** (**Settings > Billing > Customer portal**), in live mode: payment methods on, invoice history on, cancel at the end of the billing period with no prorations, switch plans off, terms and privacy links, and default redirect `https://ground.flynorthaero.com/account/plans`. The code also sends that return address with each portal visit.
8. **The app's restricted key.** On the **API keys** page in live mode, create a restricted key as Stripe's restricted key guide describes. Permissions from `frontdoor/billing/README.md`: write for Customers, Checkout Sessions, Subscriptions and Customer portal; read for Prices, Coupons, Promotion codes, Invoices and Payment methods. Stripe shows a live key you create only once. Paste it straight into production's `STRIPE_SECRET_KEY`. Optional: attach an access policy.
9. **Customer emails** (**Settings > Business > Customer emails**; Stripe's portal guide links `dashboard.stripe.com/settings/emails`): successful payments on, refunds on.
10. Optional: **Radar > Risk controls > Free trial abuse**.
11. Expire the setup key from item 4.

**Check after.** In live mode: one product with three active prices and their lookup keys, two coupons, two active promotion codes, the webhook endpoint with the full event list, and the settings above saved. The API keys page shows the app's restricted key, and no `ground-tutor-staging` key that still works.

**Roll back.** Before the cutover nothing can be charged. If launch is called off: disable the webhook endpoint, archive the prices, and expire the restricted key. The script never deletes coupons, and neither should we.

**Sources:** [Stripe webhooks](https://docs.stripe.com/webhooks), [API keys](https://docs.stripe.com/keys), [Configure the customer portal](https://docs.stripe.com/customer-management/configure-portal), [Go-live checklist](https://docs.stripe.com/get-started/checklist/go-live), [Manage trial compliance](https://docs.stripe.com/billing/subscriptions/trials/manage-trial-compliance) (trial reminder emails are not sent in a sandbox), [Automate customer emails](https://docs.stripe.com/billing/revenue-recovery/customer-emails).

**Not confirmed:** that the event destination's API version list offers `2026-10-28.endive` (copy whatever the sandbox endpoint uses); the exact labels on the Subscriptions and emails page and on the restricted key permission list; how to tell from the Dashboard that the account is fully activated.

## A5. Amazon SES: nothing to change

**Who:** Claude checks. Erick only if a check fails.

The SES setup belongs to the AWS account and Region, not to a Railway environment. Production uses the same identity, configuration set and IAM user as staging. Facts: Region `us-east-2` (the AWS organization's rule allows only that Region), identity `ground.flynorthaero.com` with Easy DKIM 2048, configuration set `ground-tutor-reports` suppressing bounces and complaints, custom MAIL FROM `bounce.ground.flynorthaero.com`, IAM user `ground-tutor-ses-sender` with a send-only inline policy, production access granted 2026-11-11. Details: `docs/decisions/2026-11-08-ses-checklist.md`.

**Checks before launch.**

1. SES console, Region `us-east-2`, **Verified identities** > `ground.flynorthaero.com`: identity Verified, DKIM Successful, MAIL FROM Success.
2. **Account dashboard**: no sandbox notice. Note the daily sending quota.
3. Configuration set `ground-tutor-reports`: bounces and complaints suppressed.
4. Public DNS (step A6, item 1) still shows the three DKIM CNAMEs, the `bounce.ground` MX and SPF TXT, and Google's MX for `flynorthaero.com`.

**Known gap.** Turning reports off after a bounce, and telling the student, is not built (`docs/decisions/2026-11-08-email-reports.md`, "Follow-up"). SES's suppression list stops the mail meanwhile.

## A6. DNS preparation

**Who:** Erick at DreamHost. Claude reads public DNS before and after.

**What must survive every change.** Do not edit or remove any of these:

- The three SES DKIM CNAMEs, `<token>._domainkey.ground.flynorthaero.com`.
- `bounce.ground.flynorthaero.com`: DreamHost holds it as its own "DNS only" domain, with a custom MX `10 feedback-smtp.us-east-2.amazonses.com` and an SPF TXT.
- Everything for Google Workspace mail on `flynorthaero.com` itself (its MX records and the rest). Never touch it.
- flynorth's Clerk records on the root domain (`clerk.`, `accounts.`, `clkmail.`, `clk._domainkey.`).

**Steps.**

1. **Record what is there now** (Claude). Run and save the answers (DNS is public, so the answers are not secret):

   ```bash
   dig +noall +answer ground.flynorthaero.com CNAME
   dig +noall +answer bounce.ground.flynorthaero.com MX
   dig +noall +answer bounce.ground.flynorthaero.com TXT
   dig +noall +answer flynorthaero.com MX
   dig +noall +answer _dmarc.flynorthaero.com TXT
   dig +noall +answer flynorthaero.com CAA
   ```

   Also look up the three DKIM names (their tokens are on the SES identity page). On 2026-11-11 the answers were: `ground` CNAME `northaero-ground.netlify.app`; `bounce.ground` MX `10 feedback-smtp.us-east-2.amazonses.com` and TXT `v=spf1 include:amazonses.com ~all`; Google's five MX records for `flynorthaero.com`; DMARC `v=DMARC1; p=none;` on `flynorthaero.com` (it covers `ground` too). Every one had a TTL of 60 seconds.
2. **TTL.** The `ground` CNAME's TTL was already 60 seconds on 2026-11-11, at DreamHost's own name server. So other servers forget the old answer within a minute, and nothing needs lowering. Check it again the day before: the TTL is the number after the name in the `dig` answer. If it has grown above 300, and DreamHost's record form has a TTL box, set 300 at least a day ahead. DreamHost's help says its default TTL is 5 minutes.
3. **Railway custom domain.** Production app service > **Settings** > **Public Networking** > **+ Custom Domain** > `ground.flynorthaero.com`. Pick the port the front door listens on (the service's `PORT`, 3000 on staging). Railway then shows two records: a CNAME (its target) and a TXT (proof of ownership). Railway's docs say both are required.
4. **Add only the TXT record now** at DreamHost: **DNS Settings** for `flynorthaero.com`, add a custom TXT record with the name and value Railway shows. Enter the name without `.flynorthaero.com`. A TXT record does not change the website. **Do not change the `ground` CNAME yet.**

**Check after.** `dig +short TXT <the name Railway shows>.flynorthaero.com` returns Railway's value. The website still shows the Netlify page. The records listed under "What must survive" are unchanged.

**Roll back.** The TXT record is harmless. It can stay or be removed (Erick's yes).

**Sources:** [Railway: working with domains](https://docs.railway.com/networking/domains/working-with-domains), [DreamHost: editing or deleting custom DNS records](https://help.dreamhost.com/hc/en-us/articles/360056012291), [DreamHost: DNS propagation overview](https://help.dreamhost.com/hc/en-us/articles/215840248) (default TTL 5 minutes).

**Not confirmed:** the TXT record's name (Railway's docs only say it is shown in the dashboard; Railway's community forum shows `_railway-verify` names); whether DreamHost's form lets you change a TTL (its articles do not mention one); whether Railway can issue the certificate before the CNAME points at it.

## A7. First production deploy and smoke checks

**Who:** Claude, with Erick's yes, after steps A1 to A4 have filled every variable.

1. Approve the staged changes, or start a deploy by hand. Deploy the same commit staging runs.
2. Read the deploy log. Expect `[frontdoor] listening on ...` and the email line `email: Amazon SES`. Any "refuses to start" line names the variable to fix.
3. Without a public address, the app cannot be visited yet. That is expected: the custom domain answers only after the cutover, and Clerk's live keys work only on `ground.flynorthaero.com`.

**Optional:** to check the public pages before the cutover, Railway can make a temporary `*.up.railway.app` address for the production service (**Generate Domain**). Sign-in will not work there. Check that `/` loads and that `/api/chats` answers 401. Then remove the temporary address (Erick's yes).

**Roll back.** Nothing public points here yet.

## B1. Go or no go (Erick)

All of these must be true. If one is not, stop here; nothing public has changed.

- G1 to G4 in `docs/decisions/launch-gates.md` are marked passed by Erick.
- The approved terms, privacy policy and AI notice are on the site (not "Coming soon"). The landing page and billing wording are approved.
- Step A7's deploy is running with no errors, and on the commit Erick chose.
- Clerk's Production instance shows every record verified and its certificates issued.
- Stripe live mode is set up (step A4).
- The Railway TXT record answers (step A6).

## B2. Cutover

**Who:** Erick at DreamHost. Claude watches public DNS and Railway at the same time.

1. DreamHost: **Manage Websites**, the three dots next to `flynorthaero.com`, **DNS Settings**, **Custom Records**. Click the pencil next to the `ground` CNAME. Change its value from `northaero-ground.netlify.app` to the CNAME target Railway shows. **Save.** Change nothing else.
2. Claude checks DreamHost's own answer first, then public resolvers:

   ```bash
   dig +noall +answer ground.flynorthaero.com CNAME @ns1.dreamhost.com
   dig +noall +answer ground.flynorthaero.com CNAME @1.1.1.1
   dig +noall +answer ground.flynorthaero.com CNAME @8.8.8.8
   ```

   With a 60-second TTL, most resolvers follow within minutes. Some networks keep old answers longer; DreamHost says caching can take "a few hours up to 72 hours".
3. Railway shows a green check next to the domain once it is verified. Railway says the Let's Encrypt certificate normally comes within an hour of the DNS change. Until then, a visitor may see the old Netlify page or a certificate warning. That is why A0 picks a quiet hour.

## B3. Launch checks

**Who:** Claude for the page checks. Erick for sign-up and payment.

**Pages.**

- `curl -sI https://ground.flynorthaero.com/` answers 200 with a valid certificate for `ground.flynorthaero.com`, and the page is the tutor's landing page (not the Netlify site).
- `curl -s -o /dev/null -w '%{http_code}' https://ground.flynorthaero.com/api/chats` answers 401.
- `/how-it-works`, `/help`, `/legal/terms`, `/legal/privacy`, `/legal/ai-notice` and `/legal/license` load. The legal pages show the approved text.
- `/robots.txt` and `/sitemap.xml` name `https://ground.flynorthaero.com`.
- The footer's source link points at `erickcfi/learnharness` at the deployed commit (AGPL).
- The step A6 `dig` list gives the same answers as before, apart from the `ground` CNAME.

**Sign-up, Owner and trial** (Erick, with Claude reading logs).

1. Sign up at `https://ground.flynorthaero.com/account/sign-up` with your own email. Tick the 18+ box. If Clerk asks you to verify the email, its message should arrive. The new user must appear in Clerk's **Production** instance, not Development.
2. **Make yourself Owner again** (the production database is new). Erick runs the one-time step in `frontdoor/admin/README.md` with production's `SUPABASE_DB_URL`: the `grant-owner.ts` command or the SQL line in Supabase's SQL editor. Check that `/admin` opens.
3. **A plan for the Owner account.** The Owner account needs a plan like any student (no code exempts it). Erick decides how (trial, paid, or a code). **Do not cancel the Owner account's plan:** a cancel starts the 90-day hold, and on day 91 the account, its folder and its Owner role are deleted.
4. **Trial test.** Start the 7-day trial on the monthly plan with a real card, on the Owner account or on a second test account that you cancel afterwards in **Manage billing**. Checkout should show "7 days free", the price after the trial, the promotion code box and the terms box. The new customer and subscription must appear in Stripe's live mode, not the sandbox.
5. After Checkout:
   - The plans page shows the trial.
   - The sign-up confirmation arrives from `billing@ground.flynorthaero.com`. In Gmail, **Show original** shows DKIM PASS for `ground.flynorthaero.com`.
   - Stripe's own trial reminder arrives (for a 7-day trial Stripe sends it at once; it is never sent from the sandbox).
   - Workbench > Webhooks > the live endpoint > **Event deliveries** shows deliveries answered 200.
   - `/admin` shows the student as trial.
6. Study for a few minutes. The tutor answers (the Anthropic key works). `/admin` shows study time and model cost for that student.
7. **Manage billing** opens Stripe's portal, and its return link comes back to `/account/plans`.
8. Railway's log shows no errors, and no session text or email addresses (spot check).

**Then:** record the launch-day evidence in `docs/decisions/launch-gates.md`, and the cutover time in the decision log.

## B4. Roll back (only if a check fails and cannot be fixed quickly)

**Who:** Erick at DreamHost.

1. Edit the `ground` CNAME back to `northaero-ground.netlify.app`. Save. Within the TTL (60 seconds today) most visitors see the old site again.
2. Netlify still has the domain set up. **Do not remove it from Netlify until P7-04.**
3. Leave Railway's TXT record and the Clerk records. They are harmless.
4. Check Stripe live mode for customers who signed up in between. Cancel or refund them as needed (Erick's call).

**Not confirmed:** how long Netlify keeps serving HTTPS for the name after DNS has pointed away (its certificate renews only while DNS points at Netlify). A short outage should be fine. After many weeks it may not be. Source: [Netlify external DNS](https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns/).

## C. The week after

- **Watch** Railway's logs and memory (PRD K3; P0-07 is still open), Stripe's webhook deliveries, SES's bounce and complaint rates, and the alerts on `/admin`.
- **Backups:** the next day, the production Backups tab lists a daily backup, and Supabase lists its daily backup. Try "How to restore one student's folder" (`docs/decisions/2026-11-08-backups.md`) once, on staging.
- **Staging stays** as it is: Clerk Development instance, Stripe sandbox, the staging Supabase project, `staging-proxy`, and `FRONTDOOR_PUBLIC_URL` set to the staging address. Erick's staging Owner account stays in the sandbox (no real money).
- **P7-04:** retire the Netlify site after T6. Removing the domain and the site from Netlify are deletes: Erick's yes.
- **Docs:** move P7-03 to Done in `docs/kanban.md`, and log the launch in the decision log.

## Not confirmed, all in one place

| Vendor | What could not be confirmed |
|---|---|
| Railway | What a duplicated environment does with volumes and domains; how to keep `staging-proxy` out of production only; the custom domain TXT record's name; whether the certificate can be issued before the cutover. |
| Supabase | The current menu path of the Data API switch; the price of a new project. |
| Clerk | The exact DNS record list (taken from flynorth's live records, not Clerk's docs); whether "create production instance" asks for primary or secondary; a subdomain allowlist setting; whether production needs a paid plan. |
| Stripe | `2026-10-28.endive` in the event destination's version list; exact labels on the Subscriptions and emails page and the restricted key permissions; how the Dashboard shows full activation. |
| DreamHost | Whether the record form has a TTL box. |
| Netlify | How long HTTPS keeps working for the name after DNS points away. |

## Sources (read 2026-11-11)

- Railway: [Environments](https://docs.railway.com/environments), [Volumes](https://docs.railway.com/volumes), [Volume backups](https://docs.railway.com/volumes/backups), [Working with domains](https://docs.railway.com/networking/domains/working-with-domains), [GitHub autodeploys](https://docs.railway.com/guides/github-autodeploys)
- Supabase: [Database backups](https://supabase.com/docs/guides/platform/backups), [Data API](https://supabase.com/docs/guides/database/data-api), [Hardening the Data API](https://supabase.com/docs/guides/api/hardening-data-api)
- Clerk: [Deploy to production](https://clerk.com/docs/guides/development/deployment/production), [Change domain or subdomain](https://clerk.com/docs/guides/development/deployment/changing-domains), [Migration overview](https://clerk.com/docs/deployments/migrate-overview), [Pricing](https://clerk.com/pricing)
- Stripe: [Webhooks](https://docs.stripe.com/webhooks), [API keys](https://docs.stripe.com/keys), [Customer portal](https://docs.stripe.com/customer-management/configure-portal), [Go-live checklist](https://docs.stripe.com/get-started/checklist/go-live), [Trial compliance](https://docs.stripe.com/billing/subscriptions/trials/manage-trial-compliance), [Customer emails](https://docs.stripe.com/billing/revenue-recovery/customer-emails)
- Amazon SES: the sources in `docs/decisions/2026-11-08-ses-checklist.md`
- DreamHost: [Adding custom DNS records](https://help.dreamhost.com/hc/en-us/articles/360035516812), [Editing or deleting custom DNS records](https://help.dreamhost.com/hc/en-us/articles/360056012291), [DNS propagation overview](https://help.dreamhost.com/hc/en-us/articles/215840248)
- Netlify: [Configure external DNS](https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns/)

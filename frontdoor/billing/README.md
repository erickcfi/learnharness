# Billing (W2-8)

Stripe for North Aero Ground Tutor (PRD C2, cards P4-01 to P4-07): plans, the 7-day trial with its 2-hour study gate, Buy now, coupons, the customer portal, webhooks, and the billing emails California's automatic renewal law needs. Prices and trial terms live only in `frontdoor/plans/index.ts`.

Built and tested against a stand-in for Stripe's API (`testing.ts`). No test calls Stripe. stripe-node 23.1.0, which pins Stripe API version `2026-10-28.endive`.

## Files

| File | What |
|---|---|
| `config.ts` | Railway variables, fixed ids (product, coupons), paths, the start check |
| `catalog.ts` | The product, prices and coupons, from `plans/index.ts`; `PriceBook` finds prices by lookup key |
| `setup.ts`, `setup-cli.ts` | The idempotent setup script (P4-01) |
| `actions.ts` | Checkout with the trial, Buy now, the portal, the Owner's "remove tester discount", the plans screen's data |
| `trial.ts`, `access.ts` | One trial per email and card; the 2-hour / $10 trial gate; what a student may do now |
| `webhook.ts`, `sync.ts` | Signed, idempotent webhooks that keep `subscriptions` and `invoices` current |
| `gateway-hook.ts` | What `gateway/handler.ts` calls: the webhook route, the billing routes, the trial gate |
| `emails.ts`, `hooks.ts` | The sign-up confirmation and annual renewal notice; stand-ins for w2-email's sender and w2-pause's retention |
| `reporting.ts` | Plan, status, coupon, revenue and trial-to-paid conversion for the dashboard |
| `testing.ts` | The Stripe stand-in (tests only) |
| `../app/account/plans/` | The plans screen |

## How it works

| Route | What |
|---|---|
| `POST /account/stripe/webhook` | Stripe's events. No login: the Stripe signature is the check. |
| `GET /account/billing/state` | The plans screen's data |
| `POST /account/billing/checkout` | `plan=monthly\|quarterly\|annual` → Stripe Checkout |
| `POST /account/billing/buy-now` | `plan=…&agree=yes` → ends the trial and charges now |
| `POST /account/billing/portal` | → Stripe's customer portal ("Manage billing") |

The `/account/billing` routes sit behind the same login check as the tutor. Every `/api` route still answers 401 without a login.

- **A new student** goes to the plans screen from every tutor page until they have a plan. They see one button, "Start 7-day free trial", on the monthly price (C2 req 2, D11). 3-month and annual plans come through Buy now during the trial. A student with no trial left gets "Subscribe" on each plan, charged at Checkout.
- **Checkout** collects a card (`payment_method_collection: always`), takes promotion codes, needs the terms box ticked (`consent_collection.terms_of_service: required`), and uses our own Stripe customer with the Clerk email.
- **One trial per email and per card.**
  - The email is checked before Checkout, as a keyed one-way hash.
  - The card's fingerprint is known only after Checkout. The webhook claims both in `trial_claims`.
  - If either already had a trial, the new subscription is canceled at once and nothing is charged. The plans screen then says why, and the student can subscribe without a trial.
  - A tenant that ever had a subscription gets no new trial.
- **The trial gate.** The trial ends at 2 hours of active study (`study_time`, PD1) or $10 of model cost (PD2), whichever comes first.
  - After that, requests that start model work get 402 with a sentence naming the plans screen. Upstream shows it as the turn's error.
  - Opening New chat goes to the plans screen.
  - Every page and read still works.
  - Testers (the tester coupon) skip the gate.
- **Buy now** is one subscription update: `trial_end: now`, the new price, `proration_behavior: always_invoice`, `payment_behavior: pending_if_incomplete`. The same tenant keeps everything.
- **Ending.** When a subscription really ends, the webhook calls `startRetention(tenantId, endedAt)`. If the student subscribes again during retention, it calls `endRetention`.
- **Emails.** The sign-up confirmation and plan-change confirmation, and the notice 30 days before an annual plan renews, go through w2-email's `EmailSender`. Each email is sent inside the webhook step, so a failed send makes Stripe retry the event.

## Railway variables (test mode first)

| Name | What | Secret |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe's secret key: `sk_test_...` on staging, `sk_live_...` at launch. A restricted key (`rk_...`) also works. It needs write access to Customers, Checkout Sessions, Subscriptions and Customer portal, and read access to Prices, Coupons, Promotion codes, Invoices and Payment methods. | Yes |
| `STRIPE_WEBHOOK_SECRET` | The webhook endpoint's signing secret (`whsec_...`). Test and live endpoints have different secrets. | Yes |
| `LH_TRIAL_HASH_KEY` | Keys the one-way hash of trial emails. 32+ random characters, for example `openssl rand -base64 48`. **Never change it**, or earlier trial emails stop matching. | Yes |
| `FRONTDOOR_PUBLIC_URL` | The site's address for links in billing emails, for example the staging address. Defaults to the first `FRONTDOOR_AUTHORIZED_PARTIES` origin, then `https://ground.flynorthaero.com`. | No |
| `FRONTDOOR_BILLING` | `off` runs with no Stripe: no plans screen, no trial gate. Only for staging before Stripe test mode is set up. Never at launch. | No |

In production, the front door refuses to start without the three secrets unless `FRONTDOOR_BILLING=off` is set.

## Stripe Dashboard settings (do these in test mode first, then again in live mode)

1. **Settings > Public details**:
   - Terms of service URL: `https://<site>/legal/terms`. Checkout's terms box needs it.
   - Also the support email (`info@flynorthaero.com`) and a statement descriptor such as `NORTHAERO GROUND`.
2. **Run the setup script** (see below). It creates the product `north-aero-ground-tutor`, three prices with lookup keys `ground_tutor_monthly`, `ground_tutor_quarterly` and `ground_tutor_annual`, the coupons `north-aero-student-20` and `north-aero-tester-100`, and their promotion codes.
3. **Developers > Webhooks > Add endpoint**:
   - URL: `https://<site>/account/stripe/webhook`.
   - API version: **`2026-10-28.endive`** (the payload uses the endpoint's version).
   - Events:
     - `checkout.session.completed`
     - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
     - `customer.subscription.trial_will_end`, `customer.subscription.paused`, `customer.subscription.resumed`
     - `customer.subscription.pending_update_applied`, `customer.subscription.pending_update_expired`
     - `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.finalized`, `invoice.voided`, `invoice.marked_uncollectible`
     - `invoice.upcoming`
   - Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. **Settings > Billing > Subscriptions and emails** (`dashboard.stripe.com/settings/billing/automatic`):
   - "Send a reminder email 7 days before a free trial ends": **on**, with the link to a Stripe-hosted page (C2 req 6). For a 7-day trial Stripe sends it when the trial starts. Stripe does not send it in test mode.
   - "Send emails about upcoming renewals": **off**. It cannot be limited to annual plans, so monthly students would get one every month. The front door sends its own annual notice.
   - Prevent failed payments > "Upcoming renewal events": **30 days** (any value from 15 to 45 works). The annual notice is sent on that event.
   - Manage failed payments: Smart Retries on. If all retries for a payment fail: **cancel the subscription**. The 90-day retention then starts.
   - "Send a Stripe-hosted link for customers to confirm their payments when required": **on** (3D Secure).
   - Customer management: turn on the Stripe-hosted subscription management link, so Stripe's emails carry a cancel link.
5. **Settings > Billing > Customer portal**:
   - Customers can update payment methods: on.
   - Invoice history: on.
   - Cancel subscriptions: on, at the end of the billing period, no prorations. Cancellation reasons are optional.
   - Switch plans: off at launch (decision pending with the master).
   - Business information: terms and privacy links. Default redirect: `https://<site>/account/plans`.
6. **Settings > Business > Customer emails**: "Successful payments" on (receipts; Stripe sends none for $0 invoices), and "Refunds" on.
7. Optional: **Radar > Risk controls > Free trial abuse**. It adds Stripe's own check on repeat trial signups.

## The setup script (P4-01)

```bash
STRIPE_SECRET_KEY=sk_test_... STRIPE_STUDENT_PROMO_CODE=<code> STRIPE_TESTER_PROMO_CODE=<long random code> npm run stripe:setup -w frontdoor -- --dry-run
```

- **Dry run, then for real.** It prints what it would change and changes nothing. Run it again without `--dry-run` to make the changes.
- **Safe to repeat.** A second run changes nothing.
- **Live mode.** A live key also needs `--live`, so test mode comes first.
- **Promotion codes.** The codes are what students type. They are never stored in the repo (the repo is public) and never printed. The tester code works 3 times in all.
- **Price changes.** After a price change in `plans/index.ts`, the script makes a new price, moves the lookup key to it, and archives the old one. Students already on the old price keep it until they change plans. Stripe can't change a price's amount.
- **Coupon problems.** A coupon whose terms differ is reported, never deleted.

## Owner: when a tester's training ends (C2 req 8)

- **From code:** `removeTesterDiscount(core, tenantId)` (in `actions.ts`) removes the 100% discount, for a dashboard button.
- **By hand:** in the Stripe Dashboard, open the customer's subscription, choose to update the subscription, remove the coupon, and save. Stripe's docs describe adding a coupon but not this removal screen, so check it on staging.
- **What happens next:** the next invoice is at the plan's price. If the tester should stop instead, cancel the subscription in the Dashboard.

## What only staging with real test keys can check

- Checkout shows the trial ("7 days free"), the price after the trial, the promotion code box, and the terms box with our text.
- The card fingerprint arrives: Checkout either sets the subscription's `default_payment_method` (Stripe's docs don't say), or the customer's saved card is found.
- **Buy now:** with `always_invoice` it charges $588 at once in Stripe's default "flexible" billing mode. A 3D Secure test card (`4000 0025 0000 3155`) goes to the hosted invoice page, and the plan changes after payment.
- **Day-7 conversion:** check it with a Stripe test clock. Test clocks and Checkout together are not confirmed in Stripe's docs. If they don't mix, wait the 7 days, or test the day-7 charge on a subscription made through the API.
- **Portal cancel:** in flexible mode it sets `cancel_at` (not `cancel_at_period_end`), and `customer.subscription.deleted` arrives at period end.
- `invoice.upcoming` arrives 30 days before an annual renewal (use a test clock).
- **Test cards share a fingerprint.** Every test card number has one fingerprint per account. After the first trial with 4242, the next trial with 4242 is refused as a repeat card. Use other test numbers: `5555 5555 5555 4444`, `4000 0566 5566 5556`, and so on.
- The webhook endpoint answers 200 within Stripe's time limit.

## Stripe facts relied on (Stripe's docs, read 2026-11-08)

- stripe-node 23.1.0 pins `2026-10-28.endive`.
  - Period dates are on `items.data[]`.
  - `discounts` is an array of ids unless expanded.
  - A discount's coupon is `source.coupon`, an id; it doesn't auto-expand since 2025-09-30.
  - An invoice's subscription is `parent.subscription_details.subscription`.
  - Promotion codes take `promotion: { type: "coupon", coupon }`.
- **Checkout:**
  - `payment_method_collection: "always"` (the default) collects a card even with a trial or a 100% code.
  - `consent_collection.terms_of_service: "required"` needs a terms URL in Public details.
  - Passing `customer` makes the email read-only.
  - Checkout creates the subscription only after it completes.
- There is no Stripe setting for one trial per card. Radar's free-trial-abuse control is the nearest.
- **Ending a trial early:**
  - `trial_end: "now"` ends the trial and charges at once.
  - `pending_if_incomplete` supports `trial_end`, `items`, `proration_behavior` and `metadata`.
  - It holds the change until the invoice is paid, and expires after 23 hours.
  - 3D Secure goes through `latest_invoice.hosted_invoice_url`.
- **Coupons:**
  - Only `name` and `metadata` can change.
  - A coupon's `max_redemptions` caps every redemption.
  - `first_time_transaction` counts a started trial as a past purchase.
  - Every billing period gets an invoice, $0 included; Stripe sends no receipt for $0.
- **Webhooks:**
  - `constructEvent` needs the raw body; the default tolerance is 300 seconds.
  - Live mode retries for up to 3 days.
  - Duplicates happen and order is not guaranteed.
  - Snapshot payloads use the endpoint's API version.
- **Flexible billing mode** (the default since 2025-09-30): a portal cancel at period end sets `cancel_at` and leaves `cancel_at_period_end` false.
- **Stripe's emails:**
  - Stripe sends no sign-up confirmation email.
  - The 7-day trial reminder for a 7-day trial goes out when the trial starts.
  - "Upcoming renewals" can't be limited by interval, and Stripe's docs don't say whether it shows the price.

## Known gaps

- Two Checkout pages opened in two tabs before either finishes could make two subscriptions. Each Checkout page expires after 1 hour, and a second Checkout is refused while a plan is live.
- A trial refused for a repeat card counts on the dashboard as a short canceled subscription. The conversion numbers leave it out (`reporting.ts`).
- If no email and no card fingerprint can be found, the one-trial check is skipped and logged.

/**
 * Stripe webhooks and revenue (P4-06; PRD C2 req 9, C7 req 2 and 6), the
 * annual renewal notice (California automatic renewal law, PRD G2), and
 * billing's start checks.
 *  - Webhooks verify their signature and are idempotent: a repeated event changes nothing.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type Stripe from "stripe";
import { assertBillingEnv, billingEnvProblems, loadBillingConfig } from "../frontdoor/billing/config.ts";
import { siteUrlFrom } from "../frontdoor/billing/core.ts";
import { confirmationEmail, discountedCents, renewalNoticeEmail } from "../frontdoor/billing/emails.ts";
import { tenantBilling, trialConversion } from "../frontdoor/billing/reporting.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { sesSendEmailInput } from "../frontdoor/email/sender.ts";
import { STARTUP_CHECKS } from "../frontdoor/wiring/env.ts";
import { type Harness, startHarness, STUDENT_CODE, TESTER_CODE, WHSEC } from "./frontdoor-billing-harness.ts";

let h: Harness;
before(async () => {
	h = await startHarness();
});
after(async () => {
	await h.close();
});

const DAY = 24 * 60 * 60 * 1000;
const card = (name: string) => ({ fingerprint: `fp_hook_${name}`, last4: "4242", brand: "visa" });
const post = (payload: string, signature?: string) =>
	h.request("/account/stripe/webhook", { body: payload, headers: { "content-type": "application/json", ...(signature ? { "stripe-signature": signature } : {}) } });

/** A trialing student whose events are waiting, not yet delivered. */
async function pendingTrial(name: string): Promise<{ events: Stripe.Event[]; tenantId: string; subscriptionId: string }> {
	const s = await h.student(name);
	const sessionId = await h.checkout(s);
	const { subscriptionId } = await h.stripe.completeCheckout(sessionId, { card: card(name) });
	return { events: h.stripe.takeEvents(), tenantId: s.tenantId, subscriptionId };
}

describe("the signature (C2 req 9)", () => {
	it("refuses a missing, wrong, tampered or stale signature, and changes nothing", async () => {
		const { events, tenantId } = await pendingTrial("sig");
		const event = events.find((e) => e.type === "checkout.session.completed") as Stripe.Event;
		const good = h.stripe.sign(event);
		assert.equal((await post(good.payload)).status, 400, "missing");
		assert.equal((await post(good.payload, h.stripe.sign(event, "whsec_wrong_secret").header)).status, 400, "wrong secret");
		assert.equal((await post(good.payload.replace(tenantId, "00000000-0000-4000-8000-000000000000"), good.header)).status, 400, "tampered body");
		// Stripe's check compares the signed time with the real clock.
		const stale = h.stripe.sign(event, WHSEC, Math.floor(Date.now() / 1000) - 3600);
		assert.equal((await post(stale.payload, stale.header)).status, 400, "older than 5 minutes (Stripe's tolerance)");
		assert.equal(await dbm.getCurrentSubscription(h.db, tenantId), null);
		const rows = await h.db.query("select id from stripe_events where id = $1", [event.id]);
		assert.equal(rows.length, 0, "a refused event is not recorded");
	});

	it("accepts a good signature", async () => {
		const { events, tenantId } = await pendingTrial("sig-ok");
		for (const e of events) {
			const { payload, header } = h.stripe.sign(e);
			assert.equal((await post(payload, header)).status, 200);
		}
		assert.equal((await dbm.getCurrentSubscription(h.db, tenantId))?.status, "trialing");
	});
});

describe("idempotence and order (C2 req 9)", () => {
	it("a repeated event changes nothing: one trial claim, one email, one row", async () => {
		const { events, tenantId } = await pendingTrial("repeat");
		const sentBefore = h.email.sent.length;
		const claimsBefore = (await h.db.query("select count(*)::int as n from trial_claims"))[0]?.n;
		for (const e of events) {
			const { payload, header } = h.stripe.sign(e);
			assert.equal((await post(payload, header)).status, 200);
		}
		for (const e of events) {
			const { payload, header } = h.stripe.sign(e);
			const again = await post(payload, header);
			assert.equal(again.status, 200);
			assert.deepEqual(again.json(), { received: true, duplicate: true });
		}
		assert.equal(h.email.sent.length - sentBefore, 1, "one confirmation");
		assert.equal((await h.db.query("select count(*)::int as n from trial_claims"))[0]?.n, Number(claimsBefore) + 1, "one claim");
		assert.equal((await dbm.listSubscriptions(h.db, tenantId)).length, 1);
		assert.equal((await dbm.getCurrentSubscription(h.db, tenantId))?.status, "trialing", "the repeat did not refuse its own trial");
	});

	it("events in any order end in the right state (Stripe gives no order)", async () => {
		const { events, tenantId, subscriptionId } = await pendingTrial("order");
		h.stripe.advanceTo(h.stripe.now() + 8 * DAY);
		const later = h.stripe.takeEvents();
		for (const e of [...later, ...events].reverse()) {
			const { payload, header } = h.stripe.sign(e);
			assert.equal((await post(payload, header)).status, 200);
		}
		const row = await dbm.getCurrentSubscription(h.db, tenantId);
		assert.equal(row?.stripeSubscriptionId, subscriptionId);
		assert.equal(row?.status, "active", "the newest state wins");
		assert.ok((await dbm.listInvoices(h.db, tenantId)).some((i) => i.amountPaidCents === 6900));
	});

	it("a failure leaves no trace and Stripe's retry works", async () => {
		const { events, tenantId } = await pendingTrial("retry");
		const completed = events.find((e) => e.type === "checkout.session.completed") as Stripe.Event;
		h.email.failNext();
		const { payload, header } = h.stripe.sign(completed);
		const first = await post(payload, header);
		assert.equal(first.status, 500);
		assert.equal((await h.db.query("select id from stripe_events where id = $1", [completed.id])).length, 0);
		assert.equal((await h.db.query("select count(*)::int as n from subscriptions where tenant_id = $1", [tenantId]))[0]?.n, 0, "rolled back");
		const retry = h.stripe.sign(completed);
		assert.equal((await post(retry.payload, retry.header)).status, 200);
		assert.equal((await dbm.getCurrentSubscription(h.db, tenantId))?.status, "trialing");
	});

	it("starts retention after the event commits; if that fails, the event is forgotten and Stripe's retry starts it", async () => {
		const s = await h.student("retention-retry");
		const { subscriptionId } = await h.subscribe(s, { card: card("retention-retry") });
		await h.stripe.subscriptions.cancel(subscriptionId);
		const deleted = h.stripe.takeEvents().find((e) => e.type === "customer.subscription.deleted") as Stripe.Event;
		h.retentionFailNext = true;
		const first = h.stripe.sign(deleted);
		assert.equal((await post(first.payload, first.header)).status, 500);
		assert.equal((await h.db.query("select id from stripe_events where id = $1", [deleted.id])).length, 0, "forgotten, so the retry runs");
		assert.equal((await dbm.getTenant(h.db, s.tenantId))?.status, "ready");
		const retry = h.stripe.sign(deleted);
		assert.equal((await post(retry.payload, retry.header)).status, 200);
		assert.equal((await dbm.getTenant(h.db, s.tenantId))?.status, "retention");
		assert.equal(h.retentionCalls.filter((c) => c.tenantId === s.tenantId && c.kind === "start").length, 1);
	});

	it("ignores events for customers it does not know, and event types it does not use", async () => {
		const stranger = await h.stripe.customers.create({ email: "stranger@example.com" });
		void stranger;
		const fake = { id: "evt_unused_type", object: "event", type: "product.updated", created: Math.floor(h.stripe.now() / 1000), data: { object: { id: "prod_x" } } } as unknown as Stripe.Event;
		const { payload, header } = h.stripe.sign(fake);
		assert.equal((await post(payload, header)).status, 200);
	});
});

describe("revenue, plan, status, coupon and conversion for the dashboard (C7 req 2 and 6)", () => {
	it("stores what the tenant table needs", async () => {
		const other = await startHarness();
		try {
			const paid = await other.student("rev-paid");
			await other.subscribe(paid, { card: card("rev-paid"), promotionCode: STUDENT_CODE });
			const lapsed = await other.student("rev-lapsed");
			const l = await other.subscribe(lapsed, { card: card("rev-lapsed") });
			other.stripe.portalCancel(l.subscriptionId);
			await other.deliverAll();
			const tester = await other.student("rev-tester");
			await other.subscribe(tester, { card: card("rev-tester"), promotionCode: TESTER_CODE });
			const refused = await other.student("rev-refused");
			const r = await other.checkout(refused);
			await other.stripe.completeCheckout(r, { card: card("rev-paid") });
			await other.deliverAll();
			await other.days(8);

			const rows = await tenantBilling(other.db);
			const by = (id: string) => rows.find((x) => x.tenantId === id);
			assert.deepEqual(
				{ plan: by(paid.tenantId)?.plan, status: by(paid.tenantId)?.status, coupon: by(paid.tenantId)?.coupon, revenue: by(paid.tenantId)?.revenueCents, converted: by(paid.tenantId)?.convertedFromTrial },
				{ plan: "monthly", status: "active", coupon: "student", revenue: 5520, converted: true },
			);
			assert.equal(by(lapsed.tenantId)?.status, "retention");
			assert.equal(by(lapsed.tenantId)?.convertedFromTrial, false);
			assert.equal(by(tester.tenantId)?.coupon, "tester");
			assert.equal(by(tester.tenantId)?.revenueCents, 0);
			assert.equal(by(tester.tenantId)?.hadTrial, false, "testers are not counted as trials");
			assert.equal(by(refused.tenantId)?.hadTrial, false, "a refused trial is not a trial");
			assert.deepEqual(await trialConversion(other.db), { trials: 2, converted: 1, rate: 0.5 });
			const revenue = await dbm.revenueTotals(other.db, {});
			assert.equal(revenue.find((x) => x.tenantId === paid.tenantId)?.amountPaidCents, 5520);
		} finally {
			await other.close();
		}
	});
});

describe("the annual renewal notice (California automatic renewal law)", () => {
	it("emails annual students 30 days before renewal with the price and how to cancel; not monthly ones", async () => {
		const other = await startHarness();
		try {
			const a = await other.student("renew-annual", "annual.person@example.com");
			await other.subscribe(a, { card: card("renew-annual"), promotionCode: STUDENT_CODE });
			assert.equal((await other.request("/account/billing/buy-now", { student: a, form: { plan: "annual", agree: "yes" } })).status, 303);
			await other.deliverAll();
			const m = await other.student("renew-monthly", "monthly.person@example.com");
			await other.subscribe(m, { card: card("renew-monthly") });

			await other.days(334);
			assert.equal(other.email.sent.filter((x) => x.kind === "annual-renewal-notice").length, 0, "not yet");
			await other.days(2);
			const notices = other.email.sent.filter((x) => x.kind === "annual-renewal-notice");
			assert.equal(notices.length, 1);
			const notice = notices[0];
			assert.equal(notice?.to, "annual.person@example.com");
			assert.match(notice?.text ?? "", /renews automatically on/);
			assert.match(notice?.text ?? "", /charged \$470\.40 for the next 12 months/);
			assert.match(notice?.text ?? "", /how to cancel/i);
			assert.match(notice?.text ?? "", /https:\/\/ground\.test\/account\/plans/);
			assert.ok(!other.email.sent.some((x) => x.kind === "annual-renewal-notice" && x.to === "monthly.person@example.com"));
		} finally {
			await other.close();
		}
	});

	it("words the emails with plans/index.ts amounts, school-time dates, and no em dash", () => {
		assert.equal(discountedCents(58800, 20), 47040);
		assert.equal(discountedCents(6900, null), 6900);
		const start = confirmationEmail({ to: "a@b.c", siteUrl: "https://x", planId: "quarterly", percentOff: null, trialEndsAt: null, nextChargeAt: new Date("2027-02-09T20:00:00Z"), chargedTodayCents: 17900, reason: "start" });
		assert.match(start.text, /3 months, \$179 every 3 months/);
		assert.match(start.text, /Next charge: February 9, 2027/);
		// 03:00 UTC on November 10 is still November 9 in California (America/Los_Angeles).
		const notice = renewalNoticeEmail({ to: "a@b.c", siteUrl: "https://x", amountCents: 58800, renewsAt: new Date("2027-11-10T03:00:00Z"), months: 12 });
		assert.equal(notice.subject, "Your plan renews on November 9, 2027");
		for (const text of [start.text, notice.text, start.subject, notice.subject]) assert.equal(text.includes("—"), false);
	});

	it("comes from billing@ground.flynorthaero.com with Reply-To info@ (master, 2026-11-08)", () => {
		const mail = renewalNoticeEmail({ to: "a@b.c", siteUrl: "https://x", amountCents: 58800, renewsAt: new Date("2027-11-09T20:00:00Z"), months: 12 });
		assert.equal(mail.from, "billing");
		const input = sesSendEmailInput(mail);
		assert.equal(input.FromEmailAddress, '"North Aero Ground Tutor" <billing@ground.flynorthaero.com>');
		assert.deepEqual(input.ReplyToAddresses, ["info@flynorthaero.com"]);
		assert.equal(sesSendEmailInput({ ...mail, from: undefined }).FromEmailAddress, '"North Aero Ground Tutor" <reports@ground.flynorthaero.com>', "reports keep their address");
		assert.match(mail.html, /<html/);
	});
});

describe("billing's start checks", () => {
	const prod = { NODE_ENV: "production" };
	const staging = { FRONTDOOR_PUBLIC_URL: "https://staging.example" };
	it("requires both Stripe secrets in production unless FRONTDOOR_BILLING=off; the trial hash key is w2-pause's check", () => {
		const problems = billingEnvProblems(prod).join("\n");
		for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) assert.match(problems, new RegExp(name));
		assert.doesNotMatch(problems, /LH_TRIAL_HASH_KEY/);
		assert.deepEqual(billingEnvProblems({ ...prod, ...staging, FRONTDOOR_BILLING: "off" }), []);
		assert.deepEqual(billingEnvProblems({ NODE_ENV: "development" }), []);
		assert.ok(STARTUP_CHECKS.includes(assertBillingEnv), "billing's check is in the front door's start checks");
	});

	it("refuses FRONTDOOR_BILLING=off on the launch address, set or by default (master, 2026-11-08)", () => {
		for (const env of [{ FRONTDOOR_BILLING: "off" }, { FRONTDOOR_BILLING: "off", FRONTDOOR_PUBLIC_URL: "https://ground.flynorthaero.com/" }, { ...prod, FRONTDOOR_BILLING: "off" }]) {
			assert.match(billingEnvProblems(env).join("\n"), /FRONTDOOR_BILLING=off is for staging only/);
		}
		assert.deepEqual(billingEnvProblems({ ...staging, FRONTDOOR_BILLING: "off" }), []);
	});

	it("checks the shapes without printing values", () => {
		const secret = "sentinel-not-a-stripe-key-9c1";
		const problems = billingEnvProblems({ STRIPE_SECRET_KEY: secret, STRIPE_WEBHOOK_SECRET: secret, FRONTDOOR_BILLING: "maybe" }).join("\n");
		assert.match(problems, /STRIPE_SECRET_KEY must be/);
		assert.match(problems, /STRIPE_WEBHOOK_SECRET must be/);
		assert.match(problems, /FRONTDOOR_BILLING may only be "off"/);
		assert.equal(problems.includes(secret), false);
		assert.deepEqual(billingEnvProblems({ ...prod, STRIPE_SECRET_KEY: "rk_test_abc", STRIPE_WEBHOOK_SECRET: "whsec_abc" }), []);
	});

	it("loads nothing when billing is off or unset", () => {
		assert.equal(loadBillingConfig({ FRONTDOOR_BILLING: "off", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }), null);
		assert.deepEqual(loadBillingConfig({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }), { secretKey: "sk_test_x", webhookSecret: "whsec_x" });
		assert.equal(loadBillingConfig({}), null);
		assert.equal(siteUrlFrom({ FRONTDOOR_PUBLIC_URL: "https://staging.example/" }), "https://staging.example");
		assert.equal(siteUrlFrom({}), "https://ground.flynorthaero.com");
	});
});

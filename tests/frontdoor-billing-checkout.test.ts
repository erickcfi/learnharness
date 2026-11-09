/**
 * PRD C2 acceptance tests, against the Stripe stand-in (P4-02, P4-07):
 *  - Signup without a card is refused.
 *  - A second trial with the same email, or with the same card, is refused.
 *  - With no action, the monthly charge happens at day 7.
 *  - The North Aero code takes 20% off each plan, also for a student whose earlier trial was canceled.
 *  - The tester code produces $0 invoices, and a 4th redemption is refused.
 * Plus: a new student with no subscription lands on the plans screen.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { removeTesterDiscount } from "../frontdoor/billing/actions.ts";
import { STUDENT_COUPON_ID, TESTER_COUPON_ID } from "../frontdoor/billing/config.ts";
import { TEST_CARDS } from "../frontdoor/billing/testing.ts";
import type { BillingViewOn } from "../frontdoor/billing/view.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { type Harness, startHarness, type Student, STUDENT_CODE, TESTER_CODE } from "./frontdoor-billing-harness.ts";

let h: Harness;
before(async () => {
	h = await startHarness();
});
after(async () => {
	await h.close();
});

const card = (name: string) => ({ fingerprint: `fp_card_${name}`, last4: "4242", brand: "visa" });
const state = async (student: Student, query = "") => (await h.request(`/account/billing/state${query}`, { student })).json<BillingViewOn>();

describe("a new student lands on the plans screen (C2 req 1)", () => {
	it("every tutor page goes to /account/plans until there is a plan; /api writes get 402", async () => {
		const s = await h.student("newcomer");
		for (const path of ["/", "/chat/abc", "/settings"]) {
			const res = await h.request(path, { student: s });
			assert.equal(res.status, 302, path);
			assert.equal(res.location, "/account/plans");
		}
		const write = await h.request("/api/chat", { student: s, body: "{}", headers: { "content-type": "application/json" } });
		assert.equal(write.status, 402);
		const other = await h.request("/api/graph/positions", { student: s, method: "PUT", body: "{}" });
		assert.equal(other.status, 402);
		assert.match(other.json<{ error: string }>().error, /Choose a plan to start studying/);
		assert.equal(h.tenantHits.length, 0, "nothing reached the tutor");
		const view = await state(s);
		assert.equal(view.status, "none");
		assert.equal(view.trialEligible, true);
	});
});

describe("Checkout with the trial (P4-02, C2 req 1 and 2)", () => {
	it("asks Stripe for the monthly price, a 7-day trial, a card, promotion codes and the terms box", async () => {
		const s = await h.student("params");
		const sessionId = await h.checkout(s, "monthly");
		const params = h.stripe.checkoutSession(sessionId).params;
		assert.equal(params.mode, "subscription");
		assert.equal(params.payment_method_collection, "always", "card required, even with the trial");
		assert.equal(params.subscription_data?.trial_period_days, 7);
		assert.equal(params.allow_promotion_codes, true);
		assert.deepEqual(params.consent_collection, { terms_of_service: "required" });
		assert.match((params.custom_text?.terms_of_service_acceptance as { message?: string } | undefined)?.message ?? "", /renews automatically every month until I cancel/);
		assert.equal(params.client_reference_id, s.tenantId);
		const price = (await h.stripe.prices.list({ lookup_keys: ["ground_tutor_monthly"] })).data[0];
		assert.equal(params.line_items?.[0]?.price, price?.id);
		assert.match(params.success_url ?? "", /\/account\/plans\?checkout=\{CHECKOUT_SESSION_ID\}$/);
		const tenant = await dbm.getTenant(h.db, s.tenantId);
		assert.ok(tenant?.stripeCustomerId, "the Stripe customer is linked before Checkout");
	});

	it("signup without a card is refused, and the student still has no tutor", async () => {
		const s = await h.student("nocard");
		const sessionId = await h.checkout(s);
		await assert.rejects(h.stripe.completeCheckout(sessionId, {}), /needs a card/);
		await h.deliverAll();
		assert.equal((await h.request("/", { student: s })).location, "/account/plans");
	});

	it("terms not ticked: Checkout cannot finish", async () => {
		const s = await h.student("noterms");
		const sessionId = await h.checkout(s);
		await assert.rejects(h.stripe.completeCheckout(sessionId, { card: card("noterms"), acceptTerms: false }), /terms of service/);
	});

	it("a finished Checkout starts the trial: $0 invoice, the tutor opens, the confirmation email goes out", async () => {
		const s = await h.student("trialer", "trialer@example.com");
		const { subscriptionId } = await h.subscribe(s, { card: card("trialer") });
		const row = await dbm.getCurrentSubscription(h.db, s.tenantId);
		assert.equal(row?.stripeSubscriptionId, subscriptionId);
		assert.equal(row?.status, "trialing");
		assert.equal(row?.plan, "monthly");
		assert.equal(h.stripe.invoicesOf(subscriptionId)[0]?.amount_paid, 0);
		const page = await h.request("/", { student: s });
		assert.equal(page.status, 200);
		assert.equal(page.text, "from tenant");
		const mail = h.email.sent.find((m) => m.to === "trialer@example.com");
		assert.equal(mail?.kind, "billing-confirmation");
		assert.match(mail?.text ?? "", /Your trial lasts 7 days/);
		assert.match(mail?.text ?? "", /charged \$69 for the Monthly plan/);
		assert.match(mail?.text ?? "", /how to cancel/i);
		const view = await state(s);
		assert.equal(view.status, "trialing");
		assert.equal(view.trialStudyLimitMinutes, 120);
	});

	it("comes back to the plans screen with a welcome; 'finishing' while the webhook is on its way", async () => {
		const s = await h.student("returning-page");
		const sessionId = await h.checkout(s);
		await h.stripe.completeCheckout(sessionId, { card: card("returning-page") });
		assert.equal((await state(s, `?checkout=${sessionId}`)).notice, "finishing");
		await h.deliverAll();
		assert.equal((await state(s, `?checkout=${sessionId}`)).notice, "welcome");
		assert.equal((await state(s, "?checkout=canceled")).notice, "checkout-canceled");
	});

	it("with no action, the monthly charge happens at day 7 (C2 req 5, D11)", async () => {
		const s = await h.student("dayseven");
		const { subscriptionId } = await h.subscribe(s, { card: card("dayseven") });
		await h.days(6);
		assert.equal((await dbm.getCurrentSubscription(h.db, s.tenantId))?.status, "trialing");
		await h.days(1);
		const row = await dbm.getCurrentSubscription(h.db, s.tenantId);
		assert.equal(row?.status, "active");
		assert.equal(row?.plan, "monthly");
		const charges = h.stripe.invoicesOf(subscriptionId).filter((i) => i.amount_paid > 0);
		assert.deepEqual(charges.map((i) => [i.amount_paid, i.billing_reason]), [[6900, "subscription_cycle"]]);
		const stored = await dbm.listInvoices(h.db, s.tenantId);
		assert.ok(stored.some((i) => i.amountPaidCents === 6900 && i.status === "paid"), "the invoice reached the database");
	});
});

describe("one trial per email and per card (C2 req 2, D10)", () => {
	it("a second student with the same email gets Checkout with no trial", async () => {
		const first = await h.student("emailone", "same.person@example.com");
		await h.subscribe(first, { card: card("emailone") });
		const second = await h.student("emailtwo", " Same.Person@Example.com ");
		assert.equal((await state(second)).trialEligible, false);
		const sessionId = await h.checkout(second, "monthly");
		assert.equal(h.stripe.checkoutSession(sessionId).params.subscription_data?.trial_period_days, undefined);
		const { subscriptionId } = await h.stripe.completeCheckout(sessionId, { card: card("emailtwo") });
		await h.deliverAll();
		assert.equal(h.stripe.subscription(subscriptionId).status, "active", "charged at once, no trial");
		assert.equal(h.stripe.invoicesOf(subscriptionId)[0]?.amount_paid, 6900);
	});

	it("a second student with a new email but the same card: the trial is refused, nothing is charged", async () => {
		const shared = card("shared-card");
		const first = await h.student("cardone", "card.one@example.com");
		await h.subscribe(first, { card: shared });
		const second = await h.student("cardtwo", "card.two@example.com");
		assert.equal((await state(second)).trialEligible, true, "the email is new, so Checkout offers the trial");
		const sessionId = await h.checkout(second);
		const { subscriptionId } = await h.stripe.completeCheckout(sessionId, { card: shared });
		await h.deliverAll();

		const sub = h.stripe.subscription(subscriptionId);
		assert.equal(sub.status, "canceled");
		assert.equal(sub.metadata.trial_refused, "card");
		assert.equal(h.stripe.invoicesOf(subscriptionId).reduce((sum, i) => sum + i.amount_paid, 0), 0, "nothing charged");
		const view = await state(second, `?checkout=${sessionId}`);
		assert.equal(view.notice, "trial-refused-card");
		assert.equal(view.status, "none");
		assert.equal(view.trialEligible, false);
		assert.equal((await h.request("/", { student: second })).location, "/account/plans", "still no tutor");
		assert.equal((await dbm.getTenant(h.db, second.tenantId))?.status, "ready", "a refused trial starts no retention");
		assert.ok(!h.email.sent.some((m) => m.to === "card.two@example.com"), "no confirmation for a refused trial");

		// Subscribing now charges at once.
		const again = await h.checkout(second, "monthly");
		assert.equal(h.stripe.checkoutSession(again).params.subscription_data?.trial_period_days, undefined);
		const paid = await h.stripe.completeCheckout(again, { card: shared });
		await h.deliverAll();
		assert.equal(h.stripe.subscription(paid.subscriptionId).status, "active");
		assert.equal((await h.request("/", { student: second })).status, 200);
	});

	it("finds the card through the customer's saved cards when the subscription names no default card", async () => {
		const other = await startHarness({ standIn: { checkoutSetsDefaultPaymentMethod: false } });
		try {
			const shared = card("no-default");
			await other.subscribe(await other.student("nd1"), { card: shared });
			const second = await other.student("nd2");
			const sessionId = await other.checkout(second);
			const { subscriptionId } = await other.stripe.completeCheckout(sessionId, { card: shared });
			await other.deliverAll();
			assert.equal(other.stripe.subscription(subscriptionId).metadata.trial_refused, "card");
		} finally {
			await other.close();
		}
	});

	it("a student whose tenant had a subscription before gets no new trial", async () => {
		const s = await h.student("comeback");
		const { subscriptionId } = await h.subscribe(s, { card: card("comeback") });
		await h.stripe.subscriptions.cancel(subscriptionId);
		await h.deliverAll();
		const sessionId = await h.checkout(s);
		assert.equal(h.stripe.checkoutSession(sessionId).params.subscription_data?.trial_period_days, undefined);
	});

	it("refuses a second Checkout while a subscription is live", async () => {
		const s = await h.student("twice");
		await h.subscribe(s, { card: card("twice") });
		const res = await h.request("/account/billing/checkout", { student: s, form: { plan: "annual" } });
		assert.equal(res.status, 303);
		assert.equal(res.location, "/account/plans?error=already-subscribed");
	});

	it("keeps no email address in the database, only a keyed hash", async () => {
		const rows = await h.db.query("select email_hash, card_fingerprint from trial_claims");
		assert.ok(rows.length > 0);
		for (const r of rows) assert.match(String(r.email_hash), /^[0-9a-f]{64}$/);
		const dump = JSON.stringify(await h.db.query("select * from trial_claims"));
		assert.equal(dump.includes("@"), false);
	});
});

describe("the North Aero student code (C2 req 7, D13)", () => {
	it("takes 20% off the monthly price after the trial, and keeps it each month", async () => {
		const s = await h.student("na-monthly");
		const { subscriptionId } = await h.subscribe(s, { card: card("na-monthly"), promotionCode: STUDENT_CODE });
		const row = await dbm.getCurrentSubscription(h.db, s.tenantId);
		assert.equal(row?.couponId, STUDENT_COUPON_ID);
		assert.equal(row?.percentOff, 20);
		await h.days(7);
		await h.days(31);
		assert.deepEqual(
			h.stripe.invoicesOf(subscriptionId).filter((i) => i.billing_reason === "subscription_cycle").map((i) => i.amount_paid),
			[5520, 5520],
		);
		assert.match(h.email.sent.find((m) => m.to === s.email)?.text ?? "", /charged \$55\.20 for the Monthly plan/);
	});

	it("takes 20% off the 3-month and annual prices too", async () => {
		const q = await h.student("na-quarter", "returning.q@example.com");
		// A returning email: no trial, so the 3-month plan is charged at Checkout.
		await h.subscribe(await h.student("na-quarter-first", "returning.q@example.com"), { card: card("na-q0") });
		const quarter = await h.subscribe(q, { plan: "quarterly", card: card("na-q"), promotionCode: STUDENT_CODE });
		assert.equal(h.stripe.invoicesOf(quarter.subscriptionId)[0]?.amount_paid, 14320);

		const a = await h.student("na-annual");
		const annual = await h.subscribe(a, { card: card("na-a"), promotionCode: STUDENT_CODE });
		const buy = await h.request("/account/billing/buy-now", { student: a, form: { plan: "annual", agree: "yes" } });
		assert.equal(buy.location, "/account/plans?bought=annual");
		await h.deliverAll();
		assert.equal(h.stripe.invoicesOf(annual.subscriptionId).find((i) => i.billing_reason === "subscription_update")?.amount_paid, 47040);
	});

	it("works for a student whose earlier trial was canceled", async () => {
		const s = await h.student("na-again");
		const first = await h.subscribe(s, { card: card("na-again") });
		h.stripe.portalCancel(first.subscriptionId);
		await h.deliverAll();
		await h.days(8);
		assert.equal(h.stripe.subscription(first.subscriptionId).status, "canceled");
		const second = await h.subscribe(s, { card: card("na-again"), promotionCode: STUDENT_CODE });
		assert.equal(h.stripe.invoicesOf(second.subscriptionId)[0]?.amount_paid, 5520, "no trial now, 20% off at once");
		assert.equal((await dbm.getTenant(h.db, s.tenantId))?.status, "ready", "subscribing again ended retention");
	});
});

describe("the tester code (C2 req 8, D14)", () => {
	it("gives $0 invoices, skips the trial gate, and a 4th redemption is refused", async () => {
		const other = await startHarness();
		try {
			const testers = [];
			for (const name of ["t1", "t2", "t3"]) {
				const t = await other.student(name);
				const { subscriptionId } = await other.subscribe(t, { card: card(`tester-${name}`), promotionCode: TESTER_CODE });
				testers.push({ t, subscriptionId });
			}
			assert.equal(other.stripe.couponRedemptions(TESTER_COUPON_ID), 3);
			const fourth = await other.student("t4");
			const sessionId = await other.checkout(fourth);
			await assert.rejects(other.stripe.completeCheckout(sessionId, { card: card("tester-t4"), promotionCode: TESTER_CODE }), /maximum redemptions/);

			const first = testers[0];
			assert.ok(first);
			await other.addStudy(first.t, 3 * 3600, 3);
			await other.addCost(first.t, 25);
			assert.equal((await other.request("/api/chat", { student: first.t, body: "{}" })).status, 200, "the tester skips the 2-hour and $10 limits");
			await other.days(7);
			await other.days(31);
			const invoices = other.stripe.invoicesOf(first.subscriptionId);
			assert.ok(invoices.length >= 3);
			assert.ok(invoices.every((i) => i.amount_paid === 0 && i.status === "paid"), "every invoice is $0");
			assert.equal((await other.request("/account/billing/state", { student: first.t })).json<BillingViewOn>().tester, true);

			// The Owner removes the discount when training ends: the next invoice is full price.
			assert.equal(await removeTesterDiscount(other.core, first.t.tenantId), true);
			await other.deliverAll();
			assert.equal((await dbm.getCurrentSubscription(other.db, first.t.tenantId))?.couponId, null);
			await other.days(31);
			const last = other.stripe.invoicesOf(first.subscriptionId).at(-1);
			assert.equal(last?.amount_paid, 6900);
			assert.equal(await removeTesterDiscount(other.core, first.t.tenantId), false, "nothing left to remove");
		} finally {
			await other.close();
		}
	});

	it("uses Stripe's test cards in the stand-in like Stripe does (declines are refused at Checkout)", async () => {
		const s = await h.student("declined", "declined.person@example.com");
		await h.subscribe(await h.student("declined-first", "declined.person@example.com"), { card: card("decl0") });
		const sessionId = await h.checkout(s);
		await assert.rejects(h.stripe.completeCheckout(sessionId, { card: TEST_CARDS.declined }), /declined/);
	});
});

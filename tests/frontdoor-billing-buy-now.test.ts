/**
 * Buy now and the customer portal (P4-04, P4-05; PRD C2 req 1 and 4, C1 req 6).
 *  - Buy now on day 3 charges at once, ends the trial, and keeps every chat.
 *  - Buy now for the annual plan from the trial charges $588 and sets the annual price.
 *  - After a cancel in the portal, access lasts until the period ends. The 90-day retention starts then.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { BillingViewOn } from "../frontdoor/billing/view.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { type Harness, startHarness, type Student } from "./frontdoor-billing-harness.ts";

let h: Harness;
before(async () => {
	h = await startHarness();
});
after(async () => {
	await h.close();
});

const DAY = 24 * 60 * 60 * 1000;
const card = (name: string) => ({ fingerprint: `fp_buy_${name}`, last4: "4242", brand: "visa" });
const send = (s: Student) => h.request("/api/chat", { student: s, body: "{}" });
const state = async (s: Student, q = "") => (await h.request(`/account/billing/state${q}`, { student: s })).json<BillingViewOn>();
const buy = (s: Student, plan: string, agree = true) => h.request("/account/billing/buy-now", { student: s, form: { plan, ...(agree ? { agree: "yes" } : {}) } });

describe("Buy now (C2 req 4, D12)", () => {
	it("from the trial, for the annual plan: charges $588 at once and sets the annual price", async () => {
		const s = await h.student("annual");
		const { subscriptionId } = await h.subscribe(s, { card: card("annual") });
		const res = await buy(s, "annual");
		assert.equal(res.status, 303);
		assert.equal(res.location, "/account/plans?bought=annual");

		const call = h.stripe.lastCall("subscriptions.update")?.params as Record<string, unknown>;
		assert.equal(call.trial_end, "now");
		assert.equal(call.proration_behavior, "always_invoice", "invoice now in any billing mode");
		assert.equal(call.payment_behavior, "pending_if_incomplete");
		const annual = (await h.stripe.prices.list({ lookup_keys: ["ground_tutor_annual"] })).data[0];
		assert.deepEqual(call.items, [{ id: h.stripe.subscription(subscriptionId).itemId, price: annual?.id }]);

		const charge = h.stripe.invoicesOf(subscriptionId).find((i) => i.billing_reason === "subscription_update");
		assert.equal(charge?.amount_paid, 58800);
		assert.equal(charge?.status, "paid");
		assert.equal(h.stripe.priceOf(subscriptionId).lookup_key, "ground_tutor_annual");

		assert.equal((await state(s, "?bought=annual")).notice, "buy-now-pending", "before the webhook");
		await h.deliverAll();
		const row = await dbm.getCurrentSubscription(h.db, s.tenantId);
		assert.equal(row?.status, "active");
		assert.equal(row?.plan, "annual");
		assert.equal(row?.stripeSubscriptionId, subscriptionId, "the same subscription");
		const view = await state(s, "?bought=annual");
		assert.equal(view.notice, "bought");
		assert.equal(view.status, "active");
		assert.equal(view.plan, "annual");
		const renews = new Date(view.renewsAt ?? 0).getTime();
		assert.ok(Math.abs(renews - (h.stripe.now() + 365 * DAY)) < 2 * DAY, "renews in a year");

		const mail = h.email.sent.filter((m) => m.to === s.email).at(-1);
		assert.match(mail?.text ?? "", /Your plan has changed/);
		assert.equal(mail?.subject, "Your North Aero Ground Tutor plan has changed");
		assert.match(mail?.html ?? "", /Charged today/);
		assert.match(mail?.text ?? "", /Annual, \$588 every 12 months/);
		assert.match(mail?.text ?? "", /Charged today: \$588/);
	});

	it("on day 3 of a used-up trial: charges at once, ends the trial, and the same tenant keeps every chat", async () => {
		const s = await h.student("dayThree");
		const { subscriptionId } = await h.subscribe(s, { card: card("dayThree") });
		await h.request("/chat/first", { student: s });
		await h.days(3);
		await h.addStudy(s, 2 * 3600, 2);
		assert.equal((await send(s)).status, 402, "the trial's study time is used up");
		const hitsBefore = h.tenantHits.length;

		assert.equal((await buy(s, "monthly")).location, "/account/plans?bought=monthly");
		const charge = h.stripe.invoicesOf(subscriptionId).find((i) => i.billing_reason === "subscription_update");
		assert.equal(charge?.amount_paid, 6900);
		assert.ok((h.stripe.subscription(subscriptionId).trialEnd ?? 0) * 1000 <= h.stripe.now(), "the trial ended now");
		await h.deliverAll();
		assert.equal((await send(s)).status, 200, "studying again at once");
		const page = await h.request("/chat/first", { student: s });
		assert.equal(page.text, "from tenant");
		assert.equal(h.tenantHits.at(-1)?.url, "/chat/first", "the same tenant server, so every chat is still there");
		assert.ok(h.tenantHits.length > hitsBefore);
		assert.equal((await dbm.getTenant(h.db, s.tenantId))?.id, s.tenantId);
	});

	it("needs the 'I agree' box (California automatic renewal consent)", async () => {
		const s = await h.student("noagree");
		await h.subscribe(s, { card: card("noagree") });
		const res = await buy(s, "annual", false);
		assert.equal(res.location, "/account/plans?error=consent");
		assert.equal((await dbm.getCurrentSubscription(h.db, s.tenantId))?.status, "trialing");
	});

	it("a refused card changes nothing and sends the student to Stripe's invoice page", async () => {
		const s = await h.student("declines");
		const c = card("declines");
		const { subscriptionId } = await h.subscribe(s, { card: c });
		h.stripe.setCardDeclines(c.fingerprint, true);
		const res = await buy(s, "annual");
		assert.equal(res.status, 303);
		assert.match(res.location ?? "", /^https:\/\/invoice\.stripe\.test\/i\//);
		assert.equal(h.stripe.subscription(subscriptionId).status, "trialing");
		assert.equal(h.stripe.priceOf(subscriptionId).lookup_key, "ground_tutor_monthly");
		await h.deliverAll();
		assert.equal((await dbm.getCurrentSubscription(h.db, s.tenantId))?.status, "trialing");
	});

	it("is only for a trial", async () => {
		const s = await h.student("notrial");
		assert.equal((await buy(s, "annual")).location, "/account/plans?error=not-trialing");
		assert.equal((await buy(s, "weekly")).location, "/account/plans?error=unavailable");
	});
});

describe("the customer portal and cancellation (C2 req 1, C1 req 6)", () => {
	it("Manage billing opens Stripe's portal for this student's customer, returning to the plans screen", async () => {
		const s = await h.student("portal");
		await h.subscribe(s, { card: card("portal") });
		const res = await h.request("/account/billing/portal", { student: s, form: {} });
		assert.equal(res.status, 303);
		assert.match(res.location ?? "", /^https:\/\/billing\.stripe\.test\/p\/session\//);
		const session = h.stripe.portalSessions.at(-1);
		assert.equal(session?.customer, (await dbm.getTenant(h.db, s.tenantId))?.stripeCustomerId);
		assert.match(session?.return_url ?? "", /\/account\/plans$/);
		const none = await h.student("portal-none");
		assert.equal((await h.request("/account/billing/portal", { student: none, form: {} })).location, "/account/plans?error=unavailable");
	});

	it("after a cancel in the portal, access lasts until the period ends; then the 90 days start", async () => {
		const s = await h.student("cancels");
		const { subscriptionId } = await h.subscribe(s, { card: card("cancels") });
		await h.days(7);
		const periodEnd = h.stripe.subscription(subscriptionId).periodEnd * 1000;
		h.stripe.portalCancel(subscriptionId);
		await h.deliverAll();
		const row = await dbm.getCurrentSubscription(h.db, s.tenantId);
		assert.equal(row?.cancelAtPeriodEnd, true, "flexible mode: cancel_at counts as scheduled");
		const view = await state(s);
		assert.equal(view.status, "canceling");
		assert.equal(view.endsAt, new Date(periodEnd).toISOString());
		assert.equal((await dbm.getTenantOverview(h.db, s.tenantId))?.dashboardStatus, "canceled");

		await h.days(29);
		assert.equal((await send(s)).status, 200, "still studying before the period ends");
		assert.equal(h.retentionCalls.filter((c) => c.tenantId === s.tenantId).length, 0);
		await h.days(3);
		const calls = h.retentionCalls.filter((c) => c.tenantId === s.tenantId);
		assert.deepEqual(calls.map((c) => [c.kind, c.at?.toISOString()]), [["start", new Date(periodEnd).toISOString()]], "startRetention(tenantId, endedAt)");
		const tenant = await dbm.getTenant(h.db, s.tenantId);
		assert.equal(tenant?.status, "retention");
		assert.equal(tenant?.retentionEndsAt?.toISOString(), new Date(periodEnd + 90 * DAY).toISOString());
		const ended = await state(s);
		assert.equal(ended.status, "ended");
		assert.equal(ended.retentionEndsAt, new Date(periodEnd + 90 * DAY).toISOString());
	});

	it("a classic-mode cancel (cancel_at_period_end) works the same", async () => {
		const s = await h.student("classic");
		const { subscriptionId } = await h.subscribe(s, { card: card("classic") });
		await h.days(7);
		h.stripe.portalCancel(subscriptionId, "classic");
		await h.deliverAll();
		assert.equal((await state(s)).status, "canceling");
	});

	it("a failed renewal keeps the tutor while Stripe retries (past due)", async () => {
		const s = await h.student("pastdue");
		const c = card("pastdue");
		await h.subscribe(s, { card: c });
		h.stripe.setCardDeclines(c.fingerprint, true);
		await h.days(7);
		assert.equal((await dbm.getCurrentSubscription(h.db, s.tenantId))?.status, "past_due");
		assert.equal((await send(s)).status, 200);
		assert.equal((await state(s)).status, "past-due");
	});
});

/**
 * Data access: Stripe webhook state, invoices, trial claims, and the
 * dashboard status view (C2 req 2 and 9, C7 req 2, D10).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";

const AGE = new Date("2026-11-01T12:00:00Z");
let t: TestDb;
let n = 0;
async function tenant() {
	const { tenant } = await dbm.createStudentAccount(t.db, { clerkUserId: `user_bill_${++n}`, age18ConfirmedAt: AGE });
	return tenant;
}
const at = (iso: string) => new Date(iso);

before(async () => {
	t = await createTestDb();
});
after(async () => {
	await t.close();
});

describe("Stripe webhook events are idempotent (C2 req 9)", () => {
	it("runs the handler for the first delivery and ignores a repeat", async () => {
		const tn = await tenant();
		let runs = 0;
		const event = { id: "evt_once", type: "customer.subscription.updated", createdAt: at("2026-11-08T10:00:00Z") };
		const handler = async (tx: dbm.Db) => {
			runs++;
			await dbm.recordSearch(tx, { tenantId: tn.id, feeUsd: 0 });
		};
		assert.equal(await dbm.processStripeEventOnce(t.db, event, handler), "processed");
		assert.equal(await dbm.processStripeEventOnce(t.db, event, handler), "duplicate");
		assert.equal(runs, 1);
		assert.equal((await dbm.searchUsageSince(t.db, tn.id, new Date(0))).count, 1);
	});

	it("forgets an event whose handler failed, so Stripe's retry runs it", async () => {
		const tn = await tenant();
		const event = { id: "evt_retry", type: "invoice.paid", createdAt: at("2026-11-08T10:00:00Z") };
		await assert.rejects(
			dbm.processStripeEventOnce(t.db, event, async (tx) => {
				await dbm.recordSearch(tx, { tenantId: tn.id, feeUsd: 0 });
				throw new Error("boom");
			}),
			/boom/,
		);
		assert.equal((await dbm.searchUsageSince(t.db, tn.id, new Date(0))).count, 0, "the failed handler's write was rolled back");
		assert.equal(await dbm.processStripeEventOnce(t.db, event, async () => {}), "processed");
	});
});

describe("subscriptions from webhooks", () => {
	it("stores a subscription and applies newer events", async () => {
		const tn = await tenant();
		const first = await dbm.upsertSubscription(t.db, {
			stripeSubscriptionId: "sub_new",
			tenantId: tn.id,
			status: "trialing",
			plan: "monthly",
			priceId: "price_monthly",
			trialStart: at("2026-11-08T00:00:00Z"),
			trialEnd: at("2026-11-15T00:00:00Z"),
			currentPeriodEnd: at("2026-11-15T00:00:00Z"),
			eventCreatedAt: at("2026-11-08T00:00:01Z"),
		});
		assert.equal(first.applied, true);
		const upd = await dbm.upsertSubscription(t.db, {
			stripeSubscriptionId: "sub_new",
			tenantId: tn.id,
			status: "active",
			plan: "annual",
			priceId: "price_annual",
			trialStart: at("2026-11-08T00:00:00Z"),
			trialEnd: at("2026-11-10T00:00:00Z"),
			currentPeriodStart: at("2026-11-10T00:00:00Z"),
			currentPeriodEnd: at("2027-11-10T00:00:00Z"),
			couponId: "north_aero_20",
			promotionCodeId: "promo_1",
			percentOff: 20,
			eventCreatedAt: at("2026-11-10T00:00:00Z"),
		});
		assert.equal(upd.applied, true);
		const cur = await dbm.getCurrentSubscription(t.db, tn.id);
		assert.ok(cur);
		assert.equal(cur.status, "active");
		assert.equal(cur.plan, "annual");
		assert.equal(cur.priceId, "price_annual");
		assert.equal(cur.trialEnd?.toISOString(), "2026-11-10T00:00:00.000Z");
		assert.equal(cur.currentPeriodEnd?.toISOString(), "2027-11-10T00:00:00.000Z");
		assert.equal(cur.cancelAtPeriodEnd, false);
		assert.equal(cur.couponId, "north_aero_20");
		assert.equal(cur.promotionCodeId, "promo_1");
		assert.equal(cur.percentOff, 20);
	});

	it("skips an event older than the one already applied", async () => {
		const tn = await tenant();
		await dbm.upsertSubscription(t.db, { stripeSubscriptionId: "sub_order", tenantId: tn.id, status: "active", eventCreatedAt: at("2026-11-10T00:00:00Z") });
		const stale = await dbm.upsertSubscription(t.db, {
			stripeSubscriptionId: "sub_order",
			tenantId: tn.id,
			status: "trialing",
			eventCreatedAt: at("2026-11-09T00:00:00Z"),
		});
		assert.equal(stale.applied, false);
		assert.equal((await dbm.getCurrentSubscription(t.db, tn.id))?.status, "active");
	});

	it("refuses a plan name other than monthly, three_month or annual", async () => {
		const tn = await tenant();
		await assert.rejects(
			dbm.upsertSubscription(t.db, {
				stripeSubscriptionId: "sub_bad",
				tenantId: tn.id,
				status: "active",
				plan: "weekly" as dbm.Plan,
				eventCreatedAt: new Date(),
			}),
		);
	});

	it("getCurrentSubscription picks the newest subscription", async () => {
		const tn = await tenant();
		await dbm.upsertSubscription(t.db, { stripeSubscriptionId: "sub_old", tenantId: tn.id, status: "canceled", eventCreatedAt: at("2026-11-01T00:00:00Z") });
		await dbm.upsertSubscription(t.db, { stripeSubscriptionId: "sub_fresh", tenantId: tn.id, status: "active", eventCreatedAt: at("2026-12-01T00:00:00Z") });
		assert.equal((await dbm.getCurrentSubscription(t.db, tn.id))?.stripeSubscriptionId, "sub_fresh");
		assert.equal(await dbm.getCurrentSubscription(t.db, (await tenant()).id), null);
	});

	it("maps a Stripe customer to its tenant", async () => {
		const tn = await tenant();
		await dbm.setStripeCustomerId(t.db, tn.id, "cus_map");
		assert.equal((await dbm.getTenantByStripeCustomerId(t.db, "cus_map"))?.id, tn.id);
		assert.equal(await dbm.getTenantByStripeCustomerId(t.db, "cus_none"), null);
		const other = await tenant();
		await assert.rejects(dbm.setStripeCustomerId(t.db, other.id, "cus_map"));
	});
});

describe("invoices and revenue", () => {
	it("upserts invoices and totals the amounts paid per tenant", async () => {
		const a = await tenant();
		await dbm.upsertInvoice(t.db, { stripeInvoiceId: "in_1", tenantId: a.id, status: "open", amountPaidCents: 0, billingReason: "subscription_create" });
		await dbm.upsertInvoice(t.db, {
			stripeInvoiceId: "in_1",
			tenantId: a.id,
			stripeSubscriptionId: "sub_x",
			status: "paid",
			amountPaidCents: 6900,
			paidAt: at("2026-11-15T00:00:00Z"),
			billingReason: "subscription_cycle",
		});
		await dbm.upsertInvoice(t.db, { stripeInvoiceId: "in_2", tenantId: a.id, status: "paid", amountPaidCents: 5520, paidAt: at("2026-12-15T00:00:00Z") });
		const invoices = await dbm.listInvoices(t.db, a.id);
		assert.equal(invoices.length, 2);
		assert.equal(invoices[0]!.status, "paid");
		assert.equal(invoices[0]!.currency, "usd");
		assert.equal(invoices[0]!.billingReason, "subscription_cycle");
		const all = await dbm.revenueTotals(t.db, {});
		assert.equal(all.find((x) => x.tenantId === a.id)?.amountPaidCents, 12420);
		const nov = await dbm.revenueTotals(t.db, { since: at("2026-11-01T00:00:00Z"), until: at("2026-12-01T00:00:00Z") });
		assert.equal(nov.find((x) => x.tenantId === a.id)?.amountPaidCents, 6900);
	});
});

describe("trial claims (C2 req 2, D10)", () => {
	it("hashes an email so case and spaces don't matter and the address is not stored", () => {
		const h = dbm.hashEmailForTrial("  Pilot@Example.COM ", "key-1");
		assert.match(h, /^[0-9a-f]{64}$/);
		assert.equal(h, dbm.hashEmailForTrial("pilot@example.com", "key-1"));
		assert.notEqual(h, dbm.hashEmailForTrial("pilot@example.com", "key-2"));
		assert.notEqual(h, dbm.hashEmailForTrial("other@example.com", "key-1"));
		assert.throws(() => dbm.hashEmailForTrial("pilot@example.com", ""));
	});

	it("allows one trial per email and one per card", async () => {
		const e1 = dbm.hashEmailForTrial("one@example.com", "k");
		const e2 = dbm.hashEmailForTrial("two@example.com", "k");
		const e3 = dbm.hashEmailForTrial("three@example.com", "k");
		assert.equal(await dbm.isTrialUsed(t.db, { emailHash: e1, cardFingerprint: "fp_1" }), false);
		assert.equal(await dbm.claimTrial(t.db, { emailHash: e1, cardFingerprint: "fp_1" }), true);
		assert.equal(await dbm.isTrialUsed(t.db, { emailHash: e1 }), true);
		assert.equal(await dbm.isTrialUsed(t.db, { cardFingerprint: "fp_1" }), true);
		assert.equal(await dbm.claimTrial(t.db, { emailHash: e1, cardFingerprint: "fp_2" }), false, "same email, new card");
		assert.equal(await dbm.claimTrial(t.db, { emailHash: e2, cardFingerprint: "fp_1" }), false, "new email, same card");
		assert.equal(await dbm.isTrialUsed(t.db, { emailHash: e2, cardFingerprint: "fp_2" }), false, "a refused claim leaves nothing behind");
		assert.equal(await dbm.claimTrial(t.db, { emailHash: e3, cardFingerprint: "fp_3" }), true);
	});

	it("refuses a claim with neither an email hash nor a card", async () => {
		await assert.rejects(dbm.claimTrial(t.db, {}));
		assert.equal(await dbm.isTrialUsed(t.db, {}), false);
	});
});

describe("tenant_overview: the dashboard status (C7 req 2)", () => {
	it("labels trial, active, canceled, paused, retention and none", async () => {
		const trial = await tenant();
		await dbm.upsertSubscription(t.db, { stripeSubscriptionId: "sub_ov_trial", tenantId: trial.id, status: "trialing", eventCreatedAt: new Date() });
		const active = await tenant();
		await dbm.upsertSubscription(t.db, { stripeSubscriptionId: "sub_ov_active", tenantId: active.id, status: "active", couponId: "tester_100", eventCreatedAt: new Date() });
		const canceling = await tenant();
		await dbm.upsertSubscription(t.db, {
			stripeSubscriptionId: "sub_ov_cancel",
			tenantId: canceling.id,
			status: "active",
			cancelAtPeriodEnd: true,
			eventCreatedAt: new Date(),
		});
		const paused = await tenant();
		await dbm.upsertSubscription(t.db, { stripeSubscriptionId: "sub_ov_paused", tenantId: paused.id, status: "active", eventCreatedAt: new Date() });
		await dbm.pauseTenant(t.db, { tenantId: paused.id, reason: "autopause" });
		const retained = await tenant();
		await dbm.upsertSubscription(t.db, { stripeSubscriptionId: "sub_ov_ret", tenantId: retained.id, status: "canceled", eventCreatedAt: new Date() });
		await dbm.startRetention(t.db, retained.id, new Date());
		const none = await tenant();

		const rows = await dbm.listTenantOverview(t.db);
		const status = (id: string) => rows.find((r) => r.tenantId === id)?.dashboardStatus;
		assert.equal(status(trial.id), "trial");
		assert.equal(status(active.id), "active");
		assert.equal(status(canceling.id), "canceled");
		assert.equal(status(paused.id), "paused");
		assert.equal(status(retained.id), "retention");
		assert.equal(status(none.id), "none");
		const one = await dbm.getTenantOverview(t.db, active.id);
		assert.equal(one?.couponId, "tester_100");
		assert.equal(one?.paused, false);
		assert.equal((await dbm.getTenantOverview(t.db, paused.id))?.paused, true);
	});
});

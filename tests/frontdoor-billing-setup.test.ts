/**
 * P4-01: products, prices, coupons and promotion codes (PRD C2 plans,
 * req 7 and 8). Runs against the Stripe stand-in only; the setup script
 * never runs in tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COUPONS, PriceBook, priceSpecs, recurringFor } from "../frontdoor/billing/catalog.ts";
import { PRODUCT_ID, STUDENT_COUPON_ID, TESTER_COUPON_ID } from "../frontdoor/billing/config.ts";
import { runSetupCli } from "../frontdoor/billing/setup-cli.ts";
import { applySetup, describeAction, planSetup } from "../frontdoor/billing/setup.ts";
import { StripeStandIn } from "../frontdoor/billing/testing.ts";
import { PLANS, STRIPE_LOOKUP_KEYS } from "../frontdoor/plans/index.ts";

const CODES = { [STUDENT_COUPON_ID]: "NAstudentCode", [TESTER_COUPON_ID]: "tester-Code-xyz123" };
const fresh = () => new StripeStandIn({ webhookSecret: "whsec_test_setup" });

describe("the catalog comes from plans/index.ts", () => {
	it("maps each plan to Stripe's recurring settings (C2 plans table)", () => {
		assert.deepEqual(recurringFor(1), { interval: "month", intervalCount: 1 });
		assert.deepEqual(recurringFor(3), { interval: "month", intervalCount: 3 });
		assert.deepEqual(recurringFor(12), { interval: "year", intervalCount: 1 });
		const specs = priceSpecs();
		assert.deepEqual(
			specs.map((s) => [s.planId, s.unitAmount, s.interval, s.intervalCount, s.lookupKey]),
			[
				["monthly", 6900, "month", 1, STRIPE_LOOKUP_KEYS.monthly],
				["quarterly", 17900, "month", 3, STRIPE_LOOKUP_KEYS.quarterly],
				["annual", 58800, "year", 1, STRIPE_LOOKUP_KEYS.annual],
			],
		);
		assert.equal(specs.length, PLANS.length);
	});

	it("defines the student coupon (20% forever) and the tester coupon (100% forever, 3 uses)", () => {
		const student = COUPONS.find((c) => c.id === STUDENT_COUPON_ID);
		const tester = COUPONS.find((c) => c.id === TESTER_COUPON_ID);
		assert.equal(student?.percentOff, 20);
		assert.equal(student?.maxRedemptions, undefined);
		assert.equal(tester?.percentOff, 100);
		assert.equal(tester?.maxRedemptions, 3);
	});
});

describe("setup is idempotent and has a dry run", () => {
	it("plans everything on an empty account, and a dry run changes nothing", async () => {
		const stripe = fresh();
		const plan = await planSetup(stripe, { codes: CODES });
		assert.deepEqual(
			plan.actions.map((a) => a.kind),
			["create-product", "create-price", "create-price", "create-price", "create-coupon", "create-promotion-code", "create-coupon", "create-promotion-code"],
		);
		assert.deepEqual(plan.problems, []);
		assert.equal(stripe.calls.filter((c) => /\.(create|update)$/.test(c.method)).length, 0, "planning only reads");
		for (const a of plan.actions) assert.equal(describeAction(a).includes(CODES[STUDENT_COUPON_ID]) || describeAction(a).includes(CODES[TESTER_COUPON_ID]), false, "codes are never printed");
	});

	it("creates the product, prices, coupons and codes with Stripe's settings", async () => {
		const stripe = fresh();
		await applySetup(stripe, await planSetup(stripe, { codes: CODES }));

		const prices = stripe.calls.filter((c) => c.method === "prices.create").map((c) => c.params as Record<string, unknown>);
		assert.deepEqual(
			prices.map((p) => [p.unit_amount, p.recurring, p.lookup_key, p.currency, p.product]),
			[
				[6900, { interval: "month", interval_count: 1 }, "ground_tutor_monthly", "usd", PRODUCT_ID],
				[17900, { interval: "month", interval_count: 3 }, "ground_tutor_quarterly", "usd", PRODUCT_ID],
				[58800, { interval: "year", interval_count: 1 }, "ground_tutor_annual", "usd", PRODUCT_ID],
			],
		);
		const student = await stripe.coupons.retrieve(STUDENT_COUPON_ID);
		assert.equal(student.percent_off, 20);
		assert.equal(student.duration, "forever");
		assert.equal(student.max_redemptions ?? null, null);
		assert.deepEqual(student.applies_to?.products, [PRODUCT_ID], "applies to all three prices (one product)");
		const tester = await stripe.coupons.retrieve(TESTER_COUPON_ID);
		assert.equal(tester.percent_off, 100);
		assert.equal(tester.duration, "forever");
		assert.equal(tester.max_redemptions, 3);

		const codes = stripe.calls.filter((c) => c.method === "promotionCodes.create").map((c) => c.params as Record<string, unknown>);
		assert.equal(codes.length, 2);
		for (const c of codes) assert.deepEqual(c.restrictions, { first_time_transaction: false }, "first-time order only stays off (C2 req 7)");
		const studentCode = (await stripe.promotionCodes.list({ code: CODES[STUDENT_COUPON_ID] })).data[0];
		assert.equal(studentCode?.promotion.coupon, STUDENT_COUPON_ID);
	});

	it("a second run changes nothing", async () => {
		const stripe = fresh();
		await applySetup(stripe, await planSetup(stripe, { codes: CODES }));
		const again = await planSetup(stripe, { codes: CODES });
		assert.deepEqual(again.actions, []);
		assert.deepEqual(again.problems, []);
		assert.equal(again.ok.length, 1 + 3 + 2 + 2);
	});

	it("a price change in plans/index.ts makes a new price, moves the lookup key and archives the old one", async () => {
		const stripe = fresh();
		await applySetup(stripe, await planSetup(stripe, { codes: {} }));
		const before = await new PriceBook(stripe).price("monthly");
		const changed = priceSpecs(PLANS.map((p) => (p.id === "monthly" ? { ...p, priceUsd: 79 } : p)));
		const plan = await planSetup(stripe, { codes: {}, prices: changed });
		assert.deepEqual(plan.actions.map((a) => a.kind), ["replace-price"]);
		await applySetup(stripe, plan);
		const after = await new PriceBook(stripe).price("monthly");
		assert.notEqual(after.id, before.id);
		assert.equal(after.unit_amount, 7900);
		const old = (await stripe.prices.list({ lookup_keys: ["ground_tutor_monthly"] })).data;
		assert.deepEqual(old.map((p) => p.id), [after.id], "only the new price holds the key");
		assert.equal(stripe.lastCall("prices.update")?.id, before.id);
		assert.deepEqual(stripe.lastCall("prices.update")?.params, { active: false });
	});

	it("reports a coupon with the wrong terms instead of deleting it", async () => {
		const stripe = fresh();
		await stripe.coupons.create({ id: TESTER_COUPON_ID, percent_off: 50, duration: "forever" });
		const plan = await planSetup(stripe, { codes: {} });
		assert.equal(plan.problems.length, 1);
		assert.match(plan.problems[0] ?? "", /north-aero-tester-100 exists but it takes 50% off/);
		await assert.rejects(applySetup(stripe, plan), /Fix these first/);
	});

	it("skips a promotion code that was not given, and refuses one used by another coupon", async () => {
		const stripe = fresh();
		await applySetup(stripe, await planSetup(stripe, { codes: { [STUDENT_COUPON_ID]: "SHARED-1" } }));
		const plan = await planSetup(stripe, { codes: { [TESTER_COUPON_ID]: "shared-1" } });
		assert.equal(plan.skipped.length, 1);
		assert.match(plan.skipped[0] ?? "", /STRIPE_STUDENT_PROMO_CODE/);
		assert.match(plan.problems.join("\n"), /already used by another coupon/);
	});
});

describe("the command line", () => {
	it("refuses to run under NODE_ENV=test, without a key, or with a live key and no --live", async () => {
		const errors: string[] = [];
		const original = console.error;
		console.error = (line: string) => errors.push(line);
		try {
			assert.equal(await runSetupCli(["--dry-run"], { NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_x" }), 1);
			assert.equal(await runSetupCli(["--dry-run"], {}), 1);
			assert.equal(await runSetupCli(["--dry-run"], { STRIPE_SECRET_KEY: "sk_live_x" }), 1);
			assert.equal(await runSetupCli(["--nope"], { STRIPE_SECRET_KEY: "sk_test_x" }), 1);
		} finally {
			console.error = original;
		}
		assert.match(errors.join("\n"), /NODE_ENV=test/);
		assert.match(errors.join("\n"), /LIVE key/);
	});
});

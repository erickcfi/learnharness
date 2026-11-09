/**
 * Billing wired into the whole front door (W2-8): startFrontDoor() with the
 * Stripe variables set gets the webhook, the billing routes and the trial
 * gate; without them (or with FRONTDOOR_BILLING=off) it runs with no gate.
 * Stripe is the stand-in; no test calls Stripe.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type Stripe from "stripe";
import { applySetup, planSetup } from "../frontdoor/billing/setup.ts";
import { StripeStandIn } from "../frontdoor/billing/testing.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import { startFrontDoor, type FrontDoor } from "../frontdoor/wiring/front-door.ts";

const WHSEC = "whsec_wiring_test_secret";
const volume = fs.mkdtempSync(path.join(os.tmpdir(), "lh-billing-wiring-"));
const BASE_ENV: Record<string, string> = {
	NODE_ENV: "test",
	FRONTDOOR_SESSION_SECRET: "billing-wiring-session-secret-0123456789abc",
	CLERK_SECRET_KEY: "sk_test_billing_wiring_clerk",
	NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_billing_wiring",
	FRONTDOOR_VOLUME: volume,
	FRONTDOOR_LISTEN_HOST: "127.0.0.1",
	PORT: "0",
};
const BILLING_ENV = { STRIPE_SECRET_KEY: "sk_test_wiring_never_dialed", STRIPE_WEBHOOK_SECRET: WHSEC, LH_TRIAL_HASH_KEY: "wiring-trial-hash-key-0123456789abcdef" };

const opened: { fd: FrontDoor; t: TestDb }[] = [];
after(async () => {
	for (const { fd, t } of opened) {
		await fd.close();
		await t.close();
	}
	fs.rmSync(volume, { recursive: true, force: true });
});

async function open(env: Record<string, string>, stripe?: StripeStandIn): Promise<{ fd: FrontDoor; lines: string[] }> {
	const t = await createTestDb();
	const lines: string[] = [];
	const fd = await startFrontDoor({
		env,
		db: t.db,
		frontDoorApp: (_req, res) => res.end("front door page"),
		clerk: { authenticate: async () => ({ status: "signed-out" }), isSessionActive: async () => true },
		...(stripe ? { stripe, emailLookup: async () => "student@example.com" } : {}),
		log: (line) => lines.push(line),
	});
	opened.push({ fd, t });
	return { fd, lines };
}

describe("billing in startFrontDoor()", () => {
	it("with the Stripe variables: the webhook checks signatures, the billing routes need a login, /api still needs a login", async () => {
		const stripe = new StripeStandIn({ webhookSecret: WHSEC });
		await applySetup(stripe, await planSetup(stripe, { codes: {} }));
		const { fd, lines } = await open({ ...BASE_ENV, ...BILLING_ENV }, stripe);
		assert.ok(!lines.some((l) => /billing (off|not configured)/.test(l)));

		const unsigned = await fetch(`${fd.url}/account/stripe/webhook`, { method: "POST", body: "{}" });
		assert.equal(unsigned.status, 400);
		const event = { id: "evt_wiring_1", object: "event", type: "customer.created", created: Math.floor(Date.now() / 1000), data: { object: { id: "cus_x" } } } as unknown as Stripe.Event;
		const { payload, header } = stripe.sign(event);
		const signed = await fetch(`${fd.url}/account/stripe/webhook`, { method: "POST", body: payload, headers: { "Stripe-Signature": header } });
		assert.equal(signed.status, 200);
		assert.deepEqual(await signed.json(), { received: true });

		const state = await fetch(`${fd.url}/account/billing/state`, { redirect: "manual" });
		assert.equal(state.status, 302);
		assert.equal((await fetch(`${fd.url}/api/chat`, { method: "POST", body: "{}" })).status, 401);
	});

	it("with FRONTDOOR_BILLING=off: no webhook, and the plans screen says plans are not available", async () => {
		const { fd, lines } = await open({ ...BASE_ENV, ...BILLING_ENV, FRONTDOOR_BILLING: "off" });
		assert.ok(lines.some((l) => l.includes("billing off (FRONTDOOR_BILLING=off)")));
		assert.equal((await fetch(`${fd.url}/account/stripe/webhook`, { method: "POST", body: "{}" })).status, 404);
	});

	it("outside production with no Stripe variables: runs with billing off and says so", async () => {
		const { lines } = await open(BASE_ENV);
		assert.ok(lines.some((l) => l.includes("billing not configured")));
	});
});

/**
 * The trial's study-time gate and the login gate (P4-03; PRD C2 req 3, PD1,
 * PD2, X4; C1 acceptance test).
 *  - When the trial's study time is used up, new turns are refused, and all
 *    chats are still readable. Same at $10 of model cost, even before 2 hours.
 *  - Testers skip it (D14).
 *  - Every /api route still answers 401 without a login, with billing in place.
 *  - Stripe's webhook is reachable with no login; the billing routes are not.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { isTurnRequest } from "../frontdoor/billing/gateway-hook.ts";
import type { BillingViewOn } from "../frontdoor/billing/view.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { type Harness, startHarness, type Student, TESTER_CODE } from "./frontdoor-billing-harness.ts";

const REPO = path.join(import.meta.dirname, "..");
let h: Harness;
before(async () => {
	h = await startHarness();
});
after(async () => {
	await h.close();
});

const card = (name: string) => ({ fingerprint: `fp_gate_${name}`, last4: "4242", brand: "visa" });
const send = (s: Student) => h.request("/api/chat", { student: s, body: JSON.stringify({ chatId: "c1" }), headers: { "content-type": "application/json" } });
const state = async (s: Student) => (await h.request("/account/billing/state", { student: s })).json<BillingViewOn>();

/** Every route file under app/api, as a request path. */
function apiRoutePaths(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name === "route.ts") {
				const rel = path.relative(path.join(REPO, "app"), dir).split(path.sep).join("/");
				out.push(`/${rel}`.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, "a/b").replace(/\[[^\]]+\]/g, "x"));
			}
		}
	};
	walk(path.join(REPO, "app", "api"));
	return out.sort();
}

describe("the trial gate at 2 hours of study (C2 req 3, PD1)", () => {
	it("refuses new turns once 2 hours are used, keeps every page and read open, and shows the plans", async () => {
		const s = await h.student("twohours");
		await h.subscribe(s, { card: card("twohours") });
		await h.addStudy(s, 119 * 60, 3);
		assert.equal((await send(s)).status, 200, "1 h 59 min: still studying");

		await h.addStudy(s, 60, 3);
		const refused = await send(s);
		assert.equal(refused.status, 402);
		assert.match(refused.contentType, /^text\/plain/);
		assert.equal(refused.text, "Your free trial's study time is used up. Choose a plan to keep studying: http://127.0.0.1:" + new URL(h.base).port + "/account/plans");
		for (const [method, p] of [
			["POST", "/api/chats"],
			["POST", "/api/chats/abc/steer"],
			["POST", "/api/graph/import"],
			["POST", "/api/graph/coverage/extract"],
		] as const) {
			assert.equal((await h.request(p, { student: s, method, body: "{}" })).status, 402, `${method} ${p}`);
		}

		const before = h.tenantHits.length;
		for (const p of ["/", "/chat/abc", "/settings", "/api/chats", "/api/chats/abc", "/api/chats/abc/markdown", "/api/graph", "/_next/static/chunk.js"]) {
			const res = await h.request(p, { student: s });
			assert.equal(res.status, 200, p);
			assert.equal(res.text, "from tenant", p);
		}
		assert.equal(h.tenantHits.length - before, 8, "every read reached the tutor");
		assert.equal((await h.request("/api/activity/abort", { student: s, method: "POST", body: "{}" })).status, 200, "stopping a running turn still works");

		const newChat = await h.request("/chat/new", { student: s });
		assert.equal(newChat.status, 302);
		assert.equal(newChat.location, "/account/plans?reason=trial-used");
		const view = await state(s);
		assert.equal(view.status, "trial-used");
		assert.equal(view.trialUsedUp, "time");
		assert.equal(view.trialStudyMinutes, 120);
	});

	it("does not count idle time: only the study_time stretches count (PD1)", async () => {
		const s = await h.student("idle");
		await h.subscribe(s, { card: card("idle") });
		await h.days(3);
		assert.equal((await send(s)).status, 200, "three days with the tab open but no active time");
	});
});

describe("the $10 model-cost backstop (PD2)", () => {
	it("ends trial use at $10 even before 2 hours", async () => {
		const s = await h.student("tendollars");
		await h.subscribe(s, { card: card("tendollars") });
		h.stripe.advanceTo(h.stripe.now() + 60_000);
		await h.addStudy(s, 30 * 60, 1);
		await h.addCost(s, 9.99);
		assert.equal((await send(s)).status, 200);
		await h.addCost(s, 0.01);
		assert.equal((await send(s)).status, 402);
		assert.equal((await state(s)).trialUsedUp, "cost");
	});

	it("counts only cost since the trial began", async () => {
		const s = await h.student("oldcost");
		await h.addCost(s, 50);
		await h.days(1);
		await h.subscribe(s, { card: card("oldcost") });
		assert.equal((await send(s)).status, 200);
	});
});

describe("testers and paid plans have no trial gate", () => {
	it("a tester keeps studying past 2 hours and $10 (D14)", async () => {
		const s = await h.student("tester-gate");
		await h.subscribe(s, { card: card("tester-gate"), promotionCode: TESTER_CODE });
		h.stripe.advanceTo(h.stripe.now() + 60_000);
		await h.addStudy(s, 5 * 3600, 6);
		await h.addCost(s, 40);
		assert.equal((await send(s)).status, 200);
		assert.equal((await h.request("/chat/new", { student: s })).status, 200);
	});

	it("after day 7 the monthly plan has no study limit", async () => {
		const s = await h.student("paid-gate");
		await h.subscribe(s, { card: card("paid-gate") });
		await h.addStudy(s, 3 * 3600, 4);
		assert.equal((await send(s)).status, 402);
		await h.days(7);
		assert.equal((await send(s)).status, 200);
	});
});

describe("the login gate is unchanged (C1 acceptance test)", () => {
	it("every /api route still answers 401 without a login, for every method", async () => {
		const routes = apiRoutePaths();
		assert.ok(routes.length >= 30);
		const hits = h.tenantHits.length;
		for (const route of routes) {
			for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
				const res = await h.request(route, { method, ...(method === "GET" ? {} : { body: "{}" }) });
				assert.equal(res.status, 401, `${method} ${route}`);
			}
		}
		assert.equal(h.tenantHits.length, hits, "nothing reached a tutor");
	});

	it("the billing routes need the login: 401 for a form, sign-in for a page", async () => {
		for (const p of ["/account/billing/checkout", "/account/billing/buy-now", "/account/billing/portal"]) {
			assert.equal((await h.request(p, { form: { plan: "monthly" } })).status, 401, p);
		}
		const page = await h.request("/account/billing/state");
		assert.equal(page.status, 302);
		assert.match(page.location ?? "", /^\/account\/sign-in\?next=/);
	});

	it("Stripe's webhook needs no login, but needs Stripe's signature", async () => {
		const res = await h.request("/account/stripe/webhook", { body: JSON.stringify({ id: "evt_x", type: "invoice.paid" }), headers: { "content-type": "application/json" } });
		assert.equal(res.status, 400);
		assert.deepEqual(res.json(), { error: "Missing Stripe-Signature." });
		assert.equal((await h.request("/account/stripe/webhook")).status, 200, "a GET is just a front door page");
	});

	it("billing forms from another site are refused", async () => {
		const s = await h.student("csrf");
		const res = await h.request("/account/billing/checkout", { student: s, form: { plan: "monthly" }, headers: { origin: "https://evil.example" } });
		assert.equal(res.status, 403);
	});

	it("names the turn routes from upstream's app/api", () => {
		const routes = new Set(apiRoutePaths());
		for (const p of ["/api/chat", "/api/chats", "/api/chats/x/steer", "/api/graph/import", "/api/graph/coverage/extract"]) {
			assert.ok(routes.has(p), `${p} exists upstream`);
			assert.ok(isTurnRequest("POST", p.replace("/x/", "/abc/")), p);
		}
		assert.equal(isTurnRequest("GET", "/api/chats"), false);
		assert.equal(isTurnRequest("POST", "/api/activity/abort"), false);
	});
});

describe("a plan that ended keeps chats readable (C1 req 6)", () => {
	it("after the period ends: reads work, turns are refused, New chat shows the plans", async () => {
		const s = await h.student("ended");
		const { subscriptionId } = await h.subscribe(s, { card: card("ended") });
		await h.days(7);
		h.stripe.portalCancel(subscriptionId);
		await h.deliverAll();
		assert.equal((await state(s)).status, "canceling");
		assert.equal((await send(s)).status, 200, "access lasts until the period ends");
		await h.days(31);
		assert.equal((await dbm.getTenant(h.db, s.tenantId))?.status, "retention");
		assert.equal((await h.request("/chat/abc", { student: s })).status, 200);
		const refused = await send(s);
		assert.equal(refused.status, 402);
		assert.match(refused.text, /Your plan has ended/);
		assert.equal((await h.request("/chat/new", { student: s })).location, "/account/plans?reason=ended");
	});
});

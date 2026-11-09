/**
 * P3-03 tenant table, the threshold settings (from P3-06), and the pause and
 * alert buttons (C7 req 2, 5 and 6; C3 req 5 and 6).
 *
 * C7 acceptance test: "Model cost on the dashboard matches the metering
 * proxy". Rows written through the meter's own store show up per tenant,
 * with unpriced calls counted, and search fees beside them.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { clerkDirectory } from "../frontdoor/admin/directory.ts";
import { buildOverview } from "../frontdoor/admin/overview.ts";
import { databasePauseActions } from "../frontdoor/admin/pause.ts";
import { periodRange, startOfMonthIn } from "../frontdoor/admin/period.ts";
import { parseThresholds } from "../frontdoor/admin/thresholds.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { createSupabaseMeteringStore } from "../frontdoor/metering/supabase-store.ts";
import { createStudyTimeRecorder } from "../frontdoor/study-time/index.ts";
import { type Fixture, startFixture } from "./frontdoor-admin-fixture.ts";

let f: Fixture;
let a: { tenantId: string; clerkUserId: string };
let b: { tenantId: string; clerkUserId: string };
let owner: string;
const DAY = 24 * 3600 * 1000;

before(async () => {
	f = await startFixture();
	a = await f.student("dash_a");
	b = await f.student("dash_b");
	owner = await f.cookie(f.owner.clerkUserId);
});
after(async () => {
	await f.close();
});

async function overview(period = "30d"): Promise<Awaited<ReturnType<typeof buildOverview>>> {
	const res = await fetch(`${f.base}/admin/api/overview?period=${period}`, { headers: { Cookie: owner, Accept: "application/json" } });
	assert.equal(res.status, 200);
	return (await res.json()) as Awaited<ReturnType<typeof buildOverview>>;
}
const rowOf = (o: Awaited<ReturnType<typeof overview>>, tenantId: string) => {
	const row = o.rows.find((r) => r.tenantId === tenantId);
	assert.ok(row, `row for ${tenantId}`);
	return row;
};

describe("the tenant table shows metered cost per tenant (C7 acceptance test)", () => {
	before(async () => {
		// Through the meter's own store, as the proxy writes them.
		const store = createSupabaseMeteringStore(f.db, {});
		const at = new Date(f.clock.now - DAY);
		const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 };
		store.recordCall({ tenantId: a.tenantId, at, model: "claude-opus-5-5", dollars: 1.25, requestId: "req_a1", ...usage });
		store.recordCall({ tenantId: a.tenantId, at, model: "claude-opus-5-5", dollars: 0.5, requestId: "req_a2", ...usage });
		store.recordCall({ tenantId: a.tenantId, at, model: "claude-mystery-9", dollars: null, requestId: "req_a3", ...usage });
		store.recordCall({ tenantId: b.tenantId, at, model: "claude-sonnet-5-5", dollars: 0.333333, requestId: "req_b1", ...usage });
		store.recordSearch({ tenantId: a.tenantId, at });
		store.recordSearch({ tenantId: a.tenantId, at });
		// Outside the last 30 days.
		store.recordCall({ tenantId: b.tenantId, at: new Date(f.clock.now - 40 * DAY), model: "claude-opus-5-5", dollars: 10, requestId: "req_b_old", ...usage });
		await store.flush();
		await store.close();
	});

	it("each row has its model cost, unpriced calls, searches and fees", async () => {
		const o = await overview();
		const ra = rowOf(o, a.tenantId);
		assert.equal(ra.modelCostUsd, 1.75);
		assert.equal(ra.modelCalls, 3);
		assert.equal(ra.unpricedCalls, 1);
		assert.equal(ra.searchCount, 2);
		assert.equal(ra.searchFeeUsd, 0.016);
		assert.equal(ra.costUsd, 1.766);
		const rb = rowOf(o, b.tenantId);
		assert.equal(rb.modelCostUsd, 0.333333);
		assert.equal(rb.unpricedCalls, 0);
	});

	it("matches the meter's own sums, per tenant and in total", async () => {
		const o = await overview("all");
		for (const t of [a, b]) {
			const meter = await dbm.modelCostSince(f.db, t.tenantId, new Date(0), new Date(f.clock.now));
			assert.ok(Math.abs(rowOf(o, t.tenantId).modelCostUsd - meter) < 0.01, `tenant ${t.tenantId}`);
		}
		assert.equal(rowOf(o, b.tenantId).modelCostUsd, 10.333333);
		assert.ok(Math.abs(o.totals.modelCostUsd - 12.083333) < 1e-6);
		assert.equal(o.totals.unpricedCalls, 1);
	});

	it("the period switch changes the window", async () => {
		assert.equal(rowOf(await overview("30d"), b.tenantId).modelCostUsd, 0.333333);
		assert.equal(rowOf(await overview("all"), b.tenantId).modelCostUsd, 10.333333);
		assert.equal((await overview("nonsense")).period, "30d");
	});
});

describe("billing columns before and after W2-8", () => {
	it("are blank, with billingConnected false, until Stripe data exists", async () => {
		const o = await overview();
		assert.equal(o.billingConnected, false);
		assert.equal(rowOf(o, a.tenantId).plan, null);
		assert.equal(rowOf(o, a.tenantId).status, "none");
		assert.equal(o.totals.revenueUsd, 0);
		assert.equal(o.totals.conversionRate, null);
	});

	it("fill in from subscriptions and invoices alone, with trial-to-paid conversion", async () => {
		const c = await f.student("dash_c");
		const tester = await f.student("dash_tester");
		const ago = (d: number) => new Date(f.clock.now - d * DAY);
		const sub = (id: string, tenantId: string, extra: Partial<dbm.SubscriptionInput>) =>
			dbm.upsertSubscription(f.db, { stripeSubscriptionId: id, tenantId, status: "active", plan: "monthly", trialStart: ago(10), trialEnd: ago(3), eventCreatedAt: ago(1), ...extra });
		await sub("sub_a", a.tenantId, { promotionCodeId: "promo_na", couponId: "coupon_na", percentOff: 20 });
		await dbm.upsertInvoice(f.db, { stripeInvoiceId: "in_a", tenantId: a.tenantId, status: "paid", amountPaidCents: 5520, paidAt: ago(2) });
		await sub("sub_b", b.tenantId, { status: "canceled" });
		await sub("sub_c", c.tenantId, { status: "trialing", trialStart: ago(1), trialEnd: new Date(f.clock.now + 6 * DAY) });
		await sub("sub_t", tester.tenantId, { percentOff: 100, couponId: "coupon_tester" });
		await dbm.upsertInvoice(f.db, { stripeInvoiceId: "in_t", tenantId: tester.tenantId, status: "paid", amountPaidCents: 0, paidAt: ago(2) });

		const o = await overview();
		assert.equal(o.billingConnected, true);
		const ra = rowOf(o, a.tenantId);
		assert.equal(ra.plan, "monthly");
		assert.equal(ra.coupon, "20% off");
		assert.equal(ra.revenueUsd, 55.2);
		assert.equal(ra.status, "active");
		assert.equal(ra.conversion, "converted");
		assert.equal(rowOf(o, b.tenantId).conversion, "not-converted");
		assert.equal(rowOf(o, c.tenantId).conversion, "in-trial");
		assert.equal(rowOf(o, c.tenantId).status, "trial");
		assert.equal(rowOf(o, tester.tenantId).conversion, "not-converted", "a $0 tester invoice is not a sale");
		assert.equal(o.totals.trialsEnded, 3);
		assert.equal(o.totals.converted, 1);
		assert.equal(o.totals.conversionRate, 1 / 3);
		assert.equal(o.totals.revenueUsd, 55.2);
		assert.ok(Math.abs(o.totals.marginUsd - (55.2 - o.totals.costUsd)) < 1e-9);
	});
});

describe("study hours and sessions come from the front door's records (C7 acceptance test)", () => {
	it("match study_time for a scripted session", async () => {
		let clock = f.clock.now - 2 * 3600_000;
		const rec = createStudyTimeRecorder({ db: f.db, now: () => clock });
		for (let i = 0; i < 40; i++) {
			await rec.beat(a.tenantId, i < 20 ? "chat_s1" : "chat_s2");
			clock += 30_000;
		}
		const row = rowOf(await overview(), a.tenantId);
		assert.equal(row.studySeconds, 1200);
		assert.equal(row.sessions, 2);
	});
});

describe("alerts, pause and unpause from the dashboard", () => {
	it("the pause and unpause buttons call W2-7's actions with the Owner's account", async () => {
		const res = await fetch(`${f.base}/admin/api/tenants/${b.tenantId}/pause`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded", ...f.origin() },
			body: `back=${encodeURIComponent(`/admin/students/${b.tenantId}`)}`,
		});
		assert.equal(res.status, 303);
		assert.equal(res.headers.get("location"), `/admin/students/${b.tenantId}?done=paused`);
		const un = await fetch(`${f.base}/admin/api/tenants/${b.tenantId}/unpause`, { method: "POST", headers: { Cookie: owner, Accept: "application/json", ...f.origin() } });
		assert.deepEqual(await un.json(), { ok: true, done: "unpaused" });
		assert.deepEqual(f.pause.calls.slice(-2), [
			{ action: "pause", tenantId: b.tenantId, by: f.owner.accountId, reason: "owner" },
			{ action: "unpause", tenantId: b.tenantId, by: f.owner.accountId },
		]);
	});

	it("a back link outside /admin is ignored", async () => {
		for (const back of ["https://evil.example/", "//evil.example", "/api/chats", "/admin\\x"]) {
			const res = await fetch(`${f.base}/admin/api/tenants/${b.tenantId}/unpause`, {
				method: "POST",
				redirect: "manual",
				headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded", ...f.origin() },
				body: `back=${encodeURIComponent(back)}`,
			});
			assert.equal(res.headers.get("location"), "/admin?done=unpaused", back);
		}
	});

	it("the interim database actions pause and unpause for real (the meter obeys the pause row)", async () => {
		const actions = databasePauseActions(f.db);
		await actions.pauseTenant(b.tenantId, "owner", f.owner.accountId);
		assert.equal(await dbm.isPaused(f.db, b.tenantId), true);
		const o = await overview();
		assert.equal(rowOf(o, b.tenantId).paused, true);
		assert.equal(rowOf(o, b.tenantId).status, "paused");
		await actions.unpauseTenant(b.tenantId, f.owner.accountId);
		assert.equal(await dbm.isPaused(f.db, b.tenantId), false);
	});

	it("open alerts show first, and the Owner can clear one", async () => {
		const { alert } = await dbm.openAlert(f.db, { tenantId: b.tenantId, kind: "cost_alert", thresholdUsd: 60, windowCostUsd: 61.5 });
		let o = await overview();
		assert.equal(o.rows[0]?.tenantId, b.tenantId);
		assert.deepEqual(o.rows[0]?.alerts, ["cost_alert"]);
		assert.equal(o.totals.openAlerts, 1);
		const res = await fetch(`${f.base}/admin/api/alerts/${alert.id}/clear`, { method: "POST", headers: { Cookie: owner, Accept: "application/json", ...f.origin() } });
		assert.equal(res.status, 200);
		o = await overview();
		assert.equal(o.totals.openAlerts, 0);
		const [cleared] = await dbm.listAlerts(f.db, b.tenantId);
		assert.equal(cleared?.clearedBy, f.owner.accountId);
	});
});

describe("threshold settings (C3 req 5, C7 req 5)", () => {
	const post = (body: string, json = false) =>
		fetch(`${f.base}/admin/api/thresholds`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded", ...(json ? { Accept: "application/json" } : {}), ...f.origin() },
			body,
		});

	it("start at $60 and $89, and the Owner changes them", async () => {
		assert.deepEqual([(await dbm.getOwnerSettings(f.db)).alertUsd, (await dbm.getOwnerSettings(f.db)).autopauseUsd], [60, 89]);
		const res = await post("alertUsd=45.50&autopauseUsd=%2475&back=%2Fadmin%2Fsettings");
		assert.equal(res.status, 303);
		assert.equal(res.headers.get("location"), "/admin/settings?done=thresholds-saved");
		const s = await dbm.getOwnerSettings(f.db);
		assert.deepEqual([s.alertUsd, s.autopauseUsd, s.updatedBy], [45.5, 75, f.owner.accountId]);
	});

	it("refuses bad values in plain words and changes nothing", async () => {
		for (const body of ["alertUsd=80&autopauseUsd=80", "alertUsd=0&autopauseUsd=10", "alertUsd=abc&autopauseUsd=10", "alertUsd=5&autopauseUsd=20000", "alertUsd=-1&autopauseUsd=10"]) {
			const res = await post(`${body}&back=%2Fadmin%2Fsettings`);
			assert.equal(res.status, 303, body);
			assert.match(res.headers.get("location") ?? "", /^\/admin\/settings\?error=/, body);
		}
		const json = await post("alertUsd=90&autopauseUsd=80", true);
		assert.equal(json.status, 400);
		assert.match(((await json.json()) as { error: string }).error, /lower than autopause/);
		const s = await dbm.getOwnerSettings(f.db);
		assert.deepEqual([s.alertUsd, s.autopauseUsd], [45.5, 75]);
	});

	it("parse money the way the form sends it", () => {
		assert.deepEqual(parseThresholds({ alertUsd: "60", autopauseUsd: "89" }), { ok: true, value: { alertUsd: 60, autopauseUsd: 89 } });
		assert.equal(parseThresholds({ alertUsd: "60.123", autopauseUsd: "89" }).ok, false);
		assert.equal(parseThresholds({}).ok, false);
	});
});

describe("student names (Clerk, read-only, cached)", () => {
	it("shows names and emails from the directory, and short ids when Clerk fails", async () => {
		let calls = 0;
		let fail = false;
		const dir = clerkDirectory(
			{
				users: {
					async getUserList({ userId }) {
						calls += 1;
						if (fail) throw Object.assign(new Error("down"), { status: 503 });
						return { data: userId.map((id) => ({ id, firstName: "Pat", lastName: id === a.clerkUserId ? "Lee" : null, primaryEmailAddress: { emailAddress: `${id}@example.com` } })) };
					},
				},
			},
			{ now: () => f.clock.now },
		);
		const o = await buildOverview(f.db, { period: "30d", now: new Date(f.clock.now), directory: dir });
		const ra = o.rows.find((r) => r.tenantId === a.tenantId);
		assert.equal(ra?.name, "Pat Lee");
		assert.equal(ra?.email, `${a.clerkUserId}@example.com`);
		await buildOverview(f.db, { period: "30d", now: new Date(f.clock.now), directory: dir });
		assert.equal(calls, 1, "cached");
		fail = true;
		const logs: string[] = [];
		const cold = clerkDirectory({ users: { getUserList: async () => Promise.reject(Object.assign(new Error("x"), { status: 503 })) } }, { log: (l) => logs.push(l) });
		const o2 = await buildOverview(f.db, { period: "30d", now: new Date(f.clock.now), directory: cold });
		assert.equal(o2.rows.find((r) => r.tenantId === a.tenantId)?.name, null);
		assert.equal(o2.rows.find((r) => r.tenantId === a.tenantId)?.shortId, a.tenantId.slice(0, 8));
		assert.ok(logs.every((l) => !l.includes("@")));
	});

	it("marks the Owner's own study account", async () => {
		const ownerTenant = await dbm.createTenant(f.db, f.owner.accountId);
		const o = await overview();
		assert.deepEqual(rowOf(o, ownerTenant.id).roles, ["owner"]);
		assert.deepEqual(rowOf(o, a.tenantId).roles, []);
	});
});

describe("dates in the school's time zone (Salinas, California)", () => {
	it("this month starts at local midnight, across daylight saving", () => {
		assert.equal(startOfMonthIn(new Date("2026-11-08T18:00:00Z"), "America/Los_Angeles").toISOString(), "2026-11-01T07:00:00.000Z");
		assert.equal(startOfMonthIn(new Date("2026-03-15T18:00:00Z"), "America/Los_Angeles").toISOString(), "2026-03-01T08:00:00.000Z");
		assert.equal(startOfMonthIn(new Date("2026-12-01T07:30:00Z"), "America/Los_Angeles").toISOString(), "2026-11-01T07:00:00.000Z");
		const r = periodRange("30d", new Date("2026-11-08T18:00:00Z"));
		assert.equal(r.since.toISOString(), "2026-10-09T18:00:00.000Z");
	});
});

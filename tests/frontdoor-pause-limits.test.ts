/**
 * P2-05 (C3 req 5 and 6, D15, D16): the cost count, the alert, autopause,
 * and the Owner's pause and unpause controls, on the real migrations
 * (PGlite).
 *
 * The unpause hold (master decision, 2026-11-08, see frontdoor/pause/README.md):
 * an unpause starts a fresh count. Alert and autopause then count only the
 * model cost after the latest unpause, until 30 days have passed.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import { costTowardLimits, createCostWatch, createPauseControls, type AlertEvent } from "../frontdoor/pause/index.ts";

const AGE = new Date("2026-10-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-08T12:00:00Z");
let t: TestDb;
let n = 0;

async function student() {
	return dbm.createStudentAccount(t.db, { clerkUserId: `user_pause_${++n}`, age18ConfirmedAt: AGE });
}
async function owner() {
	const account = await dbm.createAccount(t.db, { clerkUserId: `owner_pause_${++n}`, age18ConfirmedAt: AGE });
	await dbm.grantRole(t.db, { accountId: account.id, role: "owner" });
	return account;
}
let req = 0;
async function spend(tenantId: string, costUsd: number | null, at: Date) {
	await dbm.recordModelUsage(t.db, {
		tenantId,
		occurredAt: at,
		model: "claude-opus-5-5",
		inputTokens: 100,
		outputTokens: 10,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd,
		requestId: `req_pause_${++req}`,
	});
}

before(async () => {
	t = await createTestDb();
});
after(async () => {
	await t.close();
});

describe("the cost count (D15)", () => {
	it("is the model cost of the last 30 days; unpriced calls and older calls add nothing", async () => {
		const { tenant } = await student();
		await spend(tenant.id, 10, new Date(NOW.getTime() - 31 * DAY));
		await spend(tenant.id, 20, new Date(NOW.getTime() - 29 * DAY));
		await spend(tenant.id, null, new Date(NOW.getTime() - DAY));
		await spend(tenant.id, 5.5, new Date(NOW.getTime() - 60_000));
		const c = await costTowardLimits(t.db, tenant.id, NOW);
		assert.equal(c.rollingUsd, 25.5);
		assert.equal(c.countedUsd, 25.5);
		assert.equal(c.countedSince.getTime(), NOW.getTime() - 30 * DAY);
		assert.equal(c.lastUnpausedAt, null);
	});

	it("after an unpause counts only cost after the unpause, until 30 days have passed", async () => {
		const { tenant } = await student();
		const unpausedAt = new Date(NOW.getTime() - 10 * DAY);
		await dbm.pauseTenant(t.db, { tenantId: tenant.id, reason: "autopause", at: new Date(unpausedAt.getTime() - DAY) });
		await dbm.unpauseTenant(t.db, { tenantId: tenant.id, at: unpausedAt });
		await spend(tenant.id, 80, new Date(unpausedAt.getTime() - 2 * DAY));
		await spend(tenant.id, 7, new Date(unpausedAt.getTime() + DAY));
		const c = await costTowardLimits(t.db, tenant.id, NOW);
		assert.equal(c.rollingUsd, 87, "the dashboard still sees the whole 30 days");
		assert.equal(c.countedUsd, 7, "only cost after the unpause counts");
		assert.equal(c.countedSince.getTime(), unpausedAt.getTime());

		// 31 days after the unpause, the normal rolling window is back.
		const later = new Date(unpausedAt.getTime() + 31 * DAY);
		const c2 = await costTowardLimits(t.db, tenant.id, later);
		assert.equal(c2.countedSince.getTime(), later.getTime() - 30 * DAY);
	});
});

describe("alert and autopause (C3 req 5, D15)", () => {
	function watch(clock: () => Date) {
		const events: AlertEvent[] = [];
		const w = createCostWatch({ db: t.db, now: clock, onAlert: (e) => void events.push(e), log: () => {} });
		return { w, events };
	}

	it("below the alert threshold: nothing happens", async () => {
		const { tenant } = await student();
		await spend(tenant.id, 59.99, NOW);
		const { w, events } = watch(() => NOW);
		const r = await w.check(tenant.id);
		assert.deepEqual({ alert: r.alertOpened, paused: r.paused }, { alert: false, paused: false });
		assert.equal(events.length, 0);
		assert.equal((await dbm.listAlerts(t.db, tenant.id)).length, 0);
	});

	it("at the alert threshold: one cost alert, reported once to onAlert, and no pause", async () => {
		const { tenant } = await student();
		await spend(tenant.id, 60, NOW);
		const { w, events } = watch(() => NOW);
		const first = await w.check(tenant.id);
		assert.equal(first.alertOpened, true);
		assert.equal(first.paused, false);
		await spend(tenant.id, 5, NOW);
		const second = await w.check(tenant.id);
		assert.equal(second.alertOpened, false, "one open alert per tenant");
		const alerts = await dbm.listAlerts(t.db, tenant.id);
		assert.equal(alerts.length, 1);
		assert.equal(alerts[0]!.kind, "cost_alert");
		assert.equal(alerts[0]!.thresholdUsd, 60);
		assert.equal(alerts[0]!.windowCostUsd, 60);
		assert.equal(events.length, 1);
		assert.deepEqual(
			{ ...events[0]!, createdAt: 0, countedSince: 0 },
			{ alertId: alerts[0]!.id, tenantId: tenant.id, kind: "cost_alert", thresholdUsd: 60, windowCostUsd: 60, createdAt: 0, countedSince: 0 },
		);
		assert.equal(await dbm.isPaused(t.db, tenant.id), false);
	});

	it("at the autopause threshold: the tenant is paused, with an autopause alert, reported once", async () => {
		const { tenant } = await student();
		await spend(tenant.id, 89, NOW);
		const { w, events } = watch(() => NOW);
		const r = await w.check(tenant.id);
		assert.equal(r.paused, true);
		assert.equal(r.alertOpened, true);
		const pause = await dbm.getOpenPause(t.db, tenant.id);
		assert.equal(pause?.reason, "autopause");
		assert.equal(pause?.pausedBy, null);
		assert.deepEqual((await dbm.listAlerts(t.db, tenant.id)).map((a) => a.kind).sort(), ["autopause", "cost_alert"]);
		assert.deepEqual(events.map((e) => e.kind).sort(), ["autopause", "cost_alert"]);
		const again = await w.check(tenant.id);
		assert.equal(again.paused, false, "already paused: no second pause");
		assert.equal(events.length, 2);
	});

	it("reads the Owner's thresholds from owner_settings on every check", async () => {
		const { tenant } = await student();
		await spend(tenant.id, 30, NOW);
		await dbm.updateOwnerSettings(t.db, { alertUsd: 20, autopauseUsd: 25 });
		try {
			const { w } = watch(() => NOW);
			const r = await w.check(tenant.id);
			assert.equal(r.paused, true);
			const alerts = await dbm.listAlerts(t.db, tenant.id);
			assert.deepEqual(alerts.map((a) => a.thresholdUsd).sort((a, b) => a - b), [20, 25]);
		} finally {
			await dbm.updateOwnerSettings(t.db, { alertUsd: 60, autopauseUsd: 89 });
		}
	});

	it("afterCall runs the check in the background and never throws", async () => {
		const { tenant } = await student();
		await spend(tenant.id, 95, NOW);
		const logs: string[] = [];
		const w = createCostWatch({ db: t.db, now: () => NOW, log: (l) => logs.push(l) });
		w.afterCall(tenant.id);
		w.afterCall(tenant.id);
		await w.idle();
		assert.equal(await dbm.isPaused(t.db, tenant.id), true);
		const broken = createCostWatch({
			db: { query: async () => Promise.reject(new Error("db down")), transaction: async () => Promise.reject(new Error("db down")) },
			log: (l) => logs.push(l),
		});
		broken.afterCall(tenant.id);
		await broken.idle();
		assert.ok(logs.some((l) => l.includes(tenant.id) && l.includes("could not")), logs.join("\n"));
		assert.ok(logs.every((l) => !l.includes("@")));
	});
});

describe("the Owner's pause and unpause (C3 req 6, C7 req 2)", () => {
	it("pauseTenant(tenantId, reason, by) and unpauseTenant(tenantId, by) record who and when", async () => {
		const { tenant } = await student();
		const erick = await owner();
		const controls = createPauseControls({ db: t.db, now: () => NOW });
		const p = await controls.pauseTenant(tenant.id, "owner", erick.id);
		assert.equal(p.created, true);
		assert.equal(p.pause.pausedBy, erick.id);
		assert.equal((await controls.pauseTenant(tenant.id, "owner", erick.id)).created, false);
		assert.equal(await controls.unpauseTenant(tenant.id, erick.id), true);
		assert.equal(await controls.unpauseTenant(tenant.id, erick.id), false, "not paused any more");
		const [row] = await dbm.listPauses(t.db, tenant.id);
		assert.equal(row?.unpausedBy, erick.id);
		assert.equal(row?.unpausedAt?.getTime(), NOW.getTime());
	});

	it("refuses a tenant id or an account id that is not a UUID", async () => {
		const controls = createPauseControls({ db: t.db });
		await assert.rejects(controls.pauseTenant("../x", "owner", null), /tenant id/);
		const { tenant } = await student();
		await assert.rejects(controls.pauseTenant(tenant.id, "owner", "erick"), /account id/);
		await assert.rejects(controls.pauseTenant(tenant.id, "later" as never, null), /reason/);
	});

	it("an unpause holds: the next call does not pause again, and a fresh $89 pauses again", async () => {
		const { tenant } = await student();
		const erick = await owner();
		let clock = NOW;
		const events: AlertEvent[] = [];
		const w = createCostWatch({ db: t.db, now: () => clock, onAlert: (e) => void events.push(e), log: () => {} });
		const controls = createPauseControls({ db: t.db, now: () => clock });

		await spend(tenant.id, 90, clock);
		assert.equal((await w.check(tenant.id)).paused, true);

		clock = new Date(NOW.getTime() + 60 * 60 * 1000);
		assert.equal(await controls.unpauseTenant(tenant.id, erick.id), true);
		const open = await dbm.listAlerts(t.db, tenant.id);
		assert.equal(open.find((a) => a.kind === "autopause")?.clearedBy, erick.id, "the unpause clears the autopause alert");
		assert.equal(open.find((a) => a.kind === "cost_alert")?.clearedAt, null, "the cost alert stays for the Owner to clear");

		clock = new Date(clock.getTime() + 60_000);
		await spend(tenant.id, 2, clock);
		const next = await w.check(tenant.id);
		assert.equal(next.paused, false, "still over $89 in 30 days, but the unpause holds");
		assert.equal(await dbm.isPaused(t.db, tenant.id), false);

		clock = new Date(clock.getTime() + DAY);
		await spend(tenant.id, 87, clock);
		const fresh = await w.check(tenant.id);
		assert.equal(fresh.paused, true, "$89 after the unpause pauses again");
		assert.equal(events.filter((e) => e.kind === "autopause").length, 2, "the second autopause is reported too");
	});
});

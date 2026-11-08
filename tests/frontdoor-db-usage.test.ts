/**
 * Data access: metered usage, search counts, alerts, pause state, and the
 * Owner's thresholds (C3 req 4 to 7, C7 req 5, D15, D16, D29).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";

const AGE = new Date("2026-11-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-08T12:00:00Z");
let t: TestDb;
let n = 0;
async function tenant() {
	const { tenant } = await dbm.createStudentAccount(t.db, { clerkUserId: `user_use_${++n}`, age18ConfirmedAt: AGE });
	return tenant;
}
const call = (tenantId: string, costUsd: number | null, occurredAt: Date, requestId?: string): dbm.ModelUsageInput => ({
	tenantId,
	occurredAt,
	model: "claude-opus-5-5",
	inputTokens: 1200,
	outputTokens: 300,
	cacheReadTokens: 5000,
	cacheWriteTokens: 800,
	cacheWrite1hTokens: 200,
	costUsd,
	requestId,
});

before(async () => {
	t = await createTestDb();
});
after(async () => {
	await t.close();
});

describe("model usage rows (C3 req 4)", () => {
	it("stores tenant, time, model, the token counts (with the 1-hour cache-write part) and list-price dollars", async () => {
		const tn = await tenant();
		const at = new Date("2026-11-08T11:00:00Z");
		const res = await dbm.recordModelUsage(t.db, call(tn.id, 0.123456, at, "msg_store_1"));
		assert.equal(res.recorded, true);
		const rows = await dbm.listModelUsage(t.db, tn.id);
		assert.equal(rows.length, 1);
		assert.deepEqual(
			{ ...rows[0]!, id: 0 },
			{
				id: 0,
				tenantId: tn.id,
				occurredAt: at,
				model: "claude-opus-5-5",
				inputTokens: 1200,
				outputTokens: 300,
				cacheReadTokens: 5000,
				cacheWriteTokens: 800,
				cacheWrite1hTokens: 200,
				costUsd: 0.123456,
				requestId: "msg_store_1",
			},
		);
	});

	it("defaults the 1-hour cache-write part to 0 and keeps it within the total", async () => {
		const tn = await tenant();
		const { cacheWrite1hTokens: _omit, ...without } = call(tn.id, 0.01, NOW, "msg_1h_default");
		await dbm.recordModelUsage(t.db, without);
		assert.equal((await dbm.listModelUsage(t.db, tn.id))[0]!.cacheWrite1hTokens, 0);
		await assert.rejects(dbm.recordModelUsage(t.db, { ...call(tn.id, 0.01, NOW), cacheWriteTokens: 100, cacheWrite1hTokens: 101 }));
		await assert.rejects(dbm.recordModelUsage(t.db, { ...call(tn.id, 0.01, NOW), cacheWrite1hTokens: -1 }));
	});

	it("stores an unpriced call with no dollars, left out of the cost sums but counted", async () => {
		const tn = await tenant();
		await dbm.recordModelUsage(t.db, call(tn.id, 2, NOW, "msg_priced"));
		await dbm.recordModelUsage(t.db, { ...call(tn.id, null, NOW, "msg_unpriced"), model: "some-new-model" });
		const rows = await dbm.listModelUsage(t.db, tn.id);
		assert.equal(rows.find((r) => r.requestId === "msg_unpriced")?.costUsd, null);
		assert.equal(await dbm.rollingModelCost(t.db, tn.id, NOW), 2);
		const totals = await dbm.usageTotals(t.db, { since: new Date(NOW.getTime() - DAY), until: new Date(NOW.getTime() + DAY) });
		const mine = totals.find((x) => x.tenantId === tn.id)!;
		assert.equal(mine.modelCalls, 2);
		assert.equal(mine.unpricedCalls, 1);
		assert.equal(mine.modelCostUsd, 2);
	});

	it("does not count a repeated provider request ID twice", async () => {
		const tn = await tenant();
		assert.equal((await dbm.recordModelUsage(t.db, call(tn.id, 1, NOW, "msg_dupe"))).recorded, true);
		assert.equal((await dbm.recordModelUsage(t.db, call(tn.id, 1, NOW, "msg_dupe"))).recorded, false);
		assert.equal(await dbm.rollingModelCost(t.db, tn.id, NOW), 1);
	});

	it("records calls without a request ID every time", async () => {
		const tn = await tenant();
		await dbm.recordModelUsage(t.db, call(tn.id, 0.25, NOW));
		await dbm.recordModelUsage(t.db, call(tn.id, 0.25, NOW));
		assert.equal(await dbm.rollingModelCost(t.db, tn.id, NOW), 0.5);
	});

	it("refuses negative tokens or dollars", async () => {
		const tn = await tenant();
		await assert.rejects(dbm.recordModelUsage(t.db, { ...call(tn.id, 0.1, NOW), inputTokens: -1 }));
		await assert.rejects(dbm.recordModelUsage(t.db, call(tn.id, -0.1, NOW)));
	});

	it("rollingModelCost sums this tenant's last 30 days only", async () => {
		const a = await tenant();
		const b = await tenant();
		await dbm.recordModelUsage(t.db, call(a.id, 10, new Date(NOW.getTime() - 31 * DAY)));
		await dbm.recordModelUsage(t.db, call(a.id, 20, new Date(NOW.getTime() - 29 * DAY)));
		await dbm.recordModelUsage(t.db, call(a.id, 5, NOW));
		await dbm.recordModelUsage(t.db, call(a.id, 7, new Date(NOW.getTime() + 60_000)));
		await dbm.recordModelUsage(t.db, call(b.id, 99, NOW));
		assert.equal(await dbm.rollingModelCost(t.db, a.id, NOW), 25);
		assert.equal(await dbm.rollingModelCost(t.db, a.id, NOW, 60), 35);
		assert.equal(await dbm.modelCostSince(t.db, a.id, new Date(NOW.getTime() - DAY), new Date(NOW.getTime() + DAY)), 12);
	});

	it("keeps fractions of a cent exact across many calls", async () => {
		const tn = await tenant();
		for (let i = 0; i < 250; i++) await dbm.recordModelUsage(t.db, call(tn.id, 0.000137, NOW));
		assert.equal(await dbm.rollingModelCost(t.db, tn.id, NOW), 0.03425);
	});
});

describe("search counts (C3 req 7)", () => {
	it("counts each tenant's searches and their fee", async () => {
		const a = await tenant();
		const b = await tenant();
		for (let i = 0; i < 3; i++) await dbm.recordSearch(t.db, { tenantId: a.id, feeUsd: 0.008, occurredAt: NOW });
		await dbm.recordSearch(t.db, { tenantId: a.id, feeUsd: 0.008, occurredAt: new Date(NOW.getTime() - 40 * DAY) });
		await dbm.recordSearch(t.db, { tenantId: b.id, feeUsd: 0.008, occurredAt: NOW });
		assert.deepEqual(await dbm.searchUsageSince(t.db, a.id, new Date(NOW.getTime() - 30 * DAY)), { count: 3, feeUsd: 0.024 });
		assert.deepEqual(await dbm.searchUsageSince(t.db, a.id, new Date(0)), { count: 4, feeUsd: 0.032 });
	});

	it("usageTotals gives model cost and search fees per tenant", async () => {
		const a = await tenant();
		await dbm.recordModelUsage(t.db, call(a.id, 1.5, NOW));
		await dbm.recordSearch(t.db, { tenantId: a.id, feeUsd: 0.008, occurredAt: NOW });
		await dbm.recordSearch(t.db, { tenantId: a.id, feeUsd: 0.008, occurredAt: NOW });
		const totals = await dbm.usageTotals(t.db, { since: new Date(NOW.getTime() - DAY), until: new Date(NOW.getTime() + DAY) });
		assert.deepEqual(
			totals.find((x) => x.tenantId === a.id),
			{ tenantId: a.id, modelCostUsd: 1.5, modelCalls: 1, unpricedCalls: 0, searchCount: 2, searchFeeUsd: 0.016 },
		);
	});

	it("uses the Tavily basic-search fee ($0.008, C3 req 7) when no fee is given", async () => {
		const a = await tenant();
		assert.equal(dbm.TAVILY_SEARCH_FEE_USD, 0.008);
		await dbm.recordSearch(t.db, { tenantId: a.id, occurredAt: NOW });
		assert.deepEqual(await dbm.searchUsageSince(t.db, a.id, new Date(0)), { count: 1, feeUsd: 0.008 });
	});
});

describe("alerts (C3 req 5, D15)", () => {
	it("keeps one open alert per tenant and kind, until the Owner clears it", async () => {
		const tn = await tenant();
		const owner = await dbm.createAccount(t.db, { clerkUserId: `user_use_owner_${++n}`, age18ConfirmedAt: AGE });
		const first = await dbm.openAlert(t.db, { tenantId: tn.id, kind: "cost_alert", thresholdUsd: 60, windowCostUsd: 60.01 });
		assert.equal(first.created, true);
		assert.equal(first.alert.thresholdUsd, 60);
		assert.equal(first.alert.windowCostUsd, 60.01);
		const second = await dbm.openAlert(t.db, { tenantId: tn.id, kind: "cost_alert", thresholdUsd: 60, windowCostUsd: 62 });
		assert.equal(second.created, false);
		assert.equal(second.alert.id, first.alert.id);
		const other = await dbm.openAlert(t.db, { tenantId: tn.id, kind: "autopause", thresholdUsd: 89, windowCostUsd: 90 });
		assert.equal(other.created, true);
		assert.equal((await dbm.listOpenAlerts(t.db)).filter((x) => x.tenantId === tn.id).length, 2);
		assert.equal(await dbm.clearAlert(t.db, first.alert.id, owner.id), true);
		assert.equal(await dbm.clearAlert(t.db, first.alert.id, owner.id), false);
		const third = await dbm.openAlert(t.db, { tenantId: tn.id, kind: "cost_alert", thresholdUsd: 60, windowCostUsd: 61 });
		assert.equal(third.created, true);
		const history = await dbm.listAlerts(t.db, tn.id);
		assert.equal(history.length, 3);
		const cleared = history.find((x) => x.id === first.alert.id)!;
		assert.equal(cleared.clearedBy, owner.id);
		assert.ok(cleared.clearedAt instanceof Date);
	});
});

describe("pause state (C3 req 6, D16)", () => {
	it("pauses once, reports it, and unpauses", async () => {
		const tn = await tenant();
		const owner = await dbm.createAccount(t.db, { clerkUserId: `user_use_owner_${++n}`, age18ConfirmedAt: AGE });
		assert.equal(await dbm.isPaused(t.db, tn.id), false);
		assert.equal(await dbm.getOpenPause(t.db, tn.id), null);
		const p = await dbm.pauseTenant(t.db, { tenantId: tn.id, reason: "autopause" });
		assert.equal(p.created, true);
		assert.equal(p.pause.reason, "autopause");
		const again = await dbm.pauseTenant(t.db, { tenantId: tn.id, reason: "owner", pausedBy: owner.id });
		assert.equal(again.created, false);
		assert.equal(again.pause.id, p.pause.id);
		assert.equal(await dbm.isPaused(t.db, tn.id), true);
		assert.equal(await dbm.unpauseTenant(t.db, { tenantId: tn.id, unpausedBy: owner.id }), true);
		assert.equal(await dbm.isPaused(t.db, tn.id), false);
		assert.equal(await dbm.unpauseTenant(t.db, { tenantId: tn.id, unpausedBy: owner.id }), false);
		const history = await dbm.listPauses(t.db, tn.id);
		assert.equal(history.length, 1);
		assert.equal(history[0]!.unpausedBy, owner.id);
	});
});

describe("Owner's thresholds (C3 req 5, C7 req 5)", () => {
	it("reads the defaults, edits them, and keeps the alert below autopause", async () => {
		const owner = await dbm.createAccount(t.db, { clerkUserId: `user_use_owner_${++n}`, age18ConfirmedAt: AGE });
		const s = await dbm.getOwnerSettings(t.db);
		assert.equal(s.alertUsd, 60);
		assert.equal(s.autopauseUsd, 89);
		const u = await dbm.updateOwnerSettings(t.db, { alertUsd: 45.5, updatedBy: owner.id });
		assert.equal(u.alertUsd, 45.5);
		assert.equal(u.autopauseUsd, 89);
		assert.equal(u.updatedBy, owner.id);
		await assert.rejects(dbm.updateOwnerSettings(t.db, { alertUsd: 100 }));
		await assert.rejects(dbm.updateOwnerSettings(t.db, { autopauseUsd: 0 }));
		const back = await dbm.updateOwnerSettings(t.db, { alertUsd: 60, autopauseUsd: 89 });
		assert.equal(back.alertUsd, 60);
		assert.equal(back.autopauseUsd, 89);
		assert.deepEqual(await dbm.getOwnerSettings(t.db), back);
	});
});

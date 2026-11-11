/**
 * Data access: study time (PD1, X4), report settings and sends (C6 req 3,
 * N12, D26), and the non-aviation labels (C7 req 4, N7).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";

const AGE = new Date("2026-11-01T12:00:00Z");
const T0 = new Date("2026-11-08T10:00:00Z");
const plus = (s: number) => new Date(T0.getTime() + s * 1000);
let t: TestDb;
let n = 0;
async function tenant() {
	const { tenant } = await dbm.createStudentAccount(t.db, { clerkUserId: `user_sr_${++n}`, age18ConfirmedAt: AGE });
	return tenant;
}

before(async () => {
	t = await createTestDb();
});
after(async () => {
	await t.close();
});

describe("study time (PD1)", () => {
	it("extends a stretch within the gap and starts a new one after it", async () => {
		const tn = await tenant();
		const s1 = await dbm.addActiveStudyTime(t.db, { tenantId: tn.id, chatId: "chat-a", at: plus(60), seconds: 60, maxGapSeconds: 300 });
		assert.equal(s1.startedAt.toISOString(), T0.toISOString());
		assert.equal(s1.lastActiveAt.toISOString(), plus(60).toISOString());
		assert.equal(s1.activeSeconds, 60);
		const s2 = await dbm.addActiveStudyTime(t.db, { tenantId: tn.id, chatId: "chat-a", at: plus(120), seconds: 60, maxGapSeconds: 300 });
		assert.equal(s2.id, s1.id);
		assert.equal(s2.activeSeconds, 120);
		assert.equal(s2.lastActiveAt.toISOString(), plus(120).toISOString());
		const s3 = await dbm.addActiveStudyTime(t.db, { tenantId: tn.id, chatId: "chat-a", at: plus(1000), seconds: 30, maxGapSeconds: 300 });
		assert.notEqual(s3.id, s1.id);
		assert.equal(s3.activeSeconds, 30);
		const s4 = await dbm.addActiveStudyTime(t.db, { tenantId: tn.id, chatId: "chat-b", at: plus(1010), seconds: 10, maxGapSeconds: 300 });
		assert.notEqual(s4.id, s3.id, "another chat gets its own stretch");
		const s5 = await dbm.addActiveStudyTime(t.db, { tenantId: tn.id, at: plus(1020), seconds: 5, maxGapSeconds: 300 });
		const s6 = await dbm.addActiveStudyTime(t.db, { tenantId: tn.id, at: plus(1030), seconds: 5, maxGapSeconds: 300 });
		assert.equal(s6.id, s5.id, "time outside any chat merges too");
		assert.equal(await dbm.studySecondsSince(t.db, tn.id, T0), 170);
		assert.equal(await dbm.studySecondsSince(t.db, tn.id, plus(900)), 50);
	});

	it("refuses negative seconds", async () => {
		const tn = await tenant();
		await assert.rejects(dbm.addActiveStudyTime(t.db, { tenantId: tn.id, seconds: -1, maxGapSeconds: 300 }));
	});

	it("studySummary gives seconds, stretches and chats per tenant", async () => {
		const a = await tenant();
		await dbm.addActiveStudyTime(t.db, { tenantId: a.id, chatId: "x", at: plus(10), seconds: 10, maxGapSeconds: 300 });
		await dbm.addActiveStudyTime(t.db, { tenantId: a.id, chatId: "y", at: plus(20), seconds: 20, maxGapSeconds: 300 });
		await dbm.addActiveStudyTime(t.db, { tenantId: a.id, chatId: "x", at: plus(5000), seconds: 30, maxGapSeconds: 300 });
		const rows = await dbm.studySummary(t.db, { since: T0, until: plus(10_000) });
		assert.deepEqual(
			rows.find((r) => r.tenantId === a.id),
			{ tenantId: a.id, activeSeconds: 60, stretches: 3, chats: 2 },
		);
	});
});

describe("report settings (C6 req 3, N12)", () => {
	it("starts with both reports off and an unsubscribe token", async () => {
		const tn = await tenant();
		const s = await dbm.getReportSettings(t.db, tn.id);
		assert.equal(s.sessionReportEnabled, false);
		assert.equal(s.weeklyReportEnabled, false);
		assert.equal(s.reportEmail, null);
		assert.match(s.unsubscribeToken, /^[0-9a-f]{64}$/);
		assert.deepEqual(await dbm.getReportSettings(t.db, tn.id), s, "reading again keeps the same token");
	});

	it("needs an address before a report can be on", async () => {
		const tn = await tenant();
		await assert.rejects(dbm.updateReportSettings(t.db, tn.id, { sessionReportEnabled: true }));
		const s = await dbm.updateReportSettings(t.db, tn.id, { sessionReportEnabled: true, reportEmail: "cfi@example.com" });
		assert.equal(s.sessionReportEnabled, true);
		assert.equal(s.weeklyReportEnabled, false);
		assert.equal(s.reportEmail, "cfi@example.com");
		const w = await dbm.updateReportSettings(t.db, tn.id, { weeklyReportEnabled: true });
		assert.equal(w.sessionReportEnabled, true, "a partial update keeps the other fields");
		assert.equal(w.weeklyReportEnabled, true);
	});

	it("unsubscribes by token, one kind or all", async () => {
		const tn = await tenant();
		const s = await dbm.updateReportSettings(t.db, tn.id, { sessionReportEnabled: true, weeklyReportEnabled: true, reportEmail: "me@example.com" });
		assert.equal(await dbm.unsubscribeByToken(t.db, s.unsubscribeToken, "weekly"), true);
		let now = await dbm.getReportSettings(t.db, tn.id);
		assert.equal(now.weeklyReportEnabled, false);
		assert.equal(now.sessionReportEnabled, true);
		assert.equal(await dbm.unsubscribeByToken(t.db, s.unsubscribeToken, "all"), true);
		now = await dbm.getReportSettings(t.db, tn.id);
		assert.equal(now.sessionReportEnabled, false);
		assert.equal(await dbm.unsubscribeByToken(t.db, "0".repeat(64), "all"), false);
	});

	it("lists weekly recipients that are on and have an address", async () => {
		const on = await tenant();
		const off = await tenant();
		await dbm.updateReportSettings(t.db, on.id, { weeklyReportEnabled: true, reportEmail: "on@example.com" });
		await dbm.updateReportSettings(t.db, off.id, { sessionReportEnabled: true, reportEmail: "off@example.com" });
		const list = await dbm.listWeeklyRecipients(t.db);
		assert.ok(list.some((r) => r.tenantId === on.id && r.reportEmail === "on@example.com"));
		assert.ok(!list.some((r) => r.tenantId === off.id));
	});
});

describe("report sends: never twice (C6 req 3, D26)", () => {
	it("claims a session report once per chat and a weekly report once per week", async () => {
		const tn = await tenant();
		const s1 = await dbm.claimReportSend(t.db, { tenantId: tn.id, kind: "session", chatId: "chat-1" });
		assert.ok(s1);
		assert.equal(await dbm.claimReportSend(t.db, { tenantId: tn.id, kind: "session", chatId: "chat-1" }), null);
		assert.ok(await dbm.claimReportSend(t.db, { tenantId: tn.id, kind: "session", chatId: "chat-2" }));
		const w1 = await dbm.claimReportSend(t.db, { tenantId: tn.id, kind: "weekly", weekStart: "2026-11-02" });
		assert.ok(w1);
		assert.equal(await dbm.claimReportSend(t.db, { tenantId: tn.id, kind: "weekly", weekStart: "2026-11-02" }), null);
		assert.ok(await dbm.claimReportSend(t.db, { tenantId: tn.id, kind: "weekly", weekStart: "2026-11-09" }));
		assert.equal(s1.sentAt, null);
		const sent = await dbm.markReportSent(t.db, s1.id, "ses-message-1");
		assert.ok(sent.sentAt instanceof Date);
		assert.equal(sent.providerMessageId, "ses-message-1");
		assert.equal(w1.weekStart, "2026-11-02");
		assert.equal(w1.chatId, null);
	});
});

describe("topic labels (C7 req 4, N7)", () => {
	it("saves one label per session and replaces it on relabel", async () => {
		const tn = await tenant();
		await dbm.saveTopicLabel(t.db, { tenantId: tn.id, chatId: "c1", topic: "Decode a METAR", isAviation: true, model: "claude-haiku-5-5" });
		await dbm.saveTopicLabel(t.db, { tenantId: tn.id, chatId: "c2", topic: "Sourdough bread", isAviation: false, model: "claude-haiku-5-5" });
		await dbm.saveTopicLabel(t.db, { tenantId: tn.id, chatId: "c2", topic: "Sourdough at altitude", isAviation: false, model: "claude-haiku-5-5" });
		const labels = await dbm.getTopicLabels(t.db, tn.id);
		assert.equal(labels.length, 2);
		const c2 = await dbm.getTopicLabel(t.db, tn.id, "c2");
		assert.equal(c2?.topic, "Sourdough at altitude");
		assert.equal(c2?.isAviation, false);
		assert.equal(await dbm.getTopicLabel(t.db, tn.id, "nope"), null);
	});

	it("keeps no label (null) for a chat the tenant server did not have, and replaces it with a real one later", async () => {
		const tn = await tenant();
		const gone = await dbm.saveTopicLabel(t.db, { tenantId: tn.id, chatId: "gone", topic: "", isAviation: null, model: "none: chat not found" });
		assert.equal(gone.isAviation, null);
		assert.equal((await dbm.getTopicLabel(t.db, tn.id, "gone"))?.isAviation, null);
		await dbm.saveTopicLabel(t.db, { tenantId: tn.id, chatId: "gone", topic: "Back again", isAviation: false, model: "claude-haiku-5-5" });
		assert.equal((await dbm.getTopicLabel(t.db, tn.id, "gone"))?.isAviation, false);
	});
});

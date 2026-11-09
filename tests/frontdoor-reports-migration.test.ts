/**
 * The W2-10 migration (report_sends: one session report per study sitting).
 * Runs after the first five migrations, runs twice without harm, and gives
 * session rows the per-sitting rule while rows with no sitting time keep
 * the old per-chat rule.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { readMigrations } from "../frontdoor/db/migrations.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import { claimSittingReport } from "../frontdoor/reports/store.ts";

const NAME = "20261108001000_report_sends_sitting.sql";
let t: TestDb;
let tenantId = "";

before(async () => {
	t = await createTestDb();
	const { tenant } = await dbm.createStudentAccount(t.db, { clerkUserId: "user_mig", age18ConfirmedAt: new Date("2026-10-01T00:00:00Z") });
	tenantId = tenant.id;
});
after(async () => {
	await t.close();
});

describe("report_sends sitting migration", () => {
	it("comes after the first five migrations", () => {
		const names = readMigrations().map((m) => m.name);
		const at = names.indexOf(NAME);
		assert.ok(at >= 5, `${NAME} is at ${at}`);
		assert.ok(names.slice(0, at).includes("20261108000400_study_reports_labels.sql"));
	});

	it("can run a second time without error", async () => {
		const sql = readMigrations().find((m) => m.name === NAME)!.sql;
		await t.pg.exec(sql);
		const rows = await t.db.query("select indexname from pg_indexes where tablename = 'report_sends' and indexname like 'report_sends_%once_idx' order by indexname");
		assert.deepEqual(
			rows.map((r) => r.indexname),
			["report_sends_session_once_idx", "report_sends_sitting_once_idx", "report_sends_weekly_once_idx"],
		);
	});

	it("allows one session report per sitting, so the same chat can report again another day", async () => {
		const day1 = new Date("2026-11-08T17:00:00Z");
		const day2 = new Date("2026-11-09T17:00:00Z");
		assert.ok(await claimSittingReport(t.db, { tenantId, sittingStartedAt: day1, chatId: "chat-a" }));
		assert.equal(await claimSittingReport(t.db, { tenantId, sittingStartedAt: day1, chatId: "chat-b" }), null, "same sitting: once");
		assert.ok(await claimSittingReport(t.db, { tenantId, sittingStartedAt: day2, chatId: "chat-a" }), "same chat, new sitting");
	});

	it("keeps sitting times on session rows only", async () => {
		await assert.rejects(
			t.db.query("insert into report_sends (tenant_id, kind, week_start, sitting_started_at) values ($1, 'weekly', '2026-11-02', now())", [tenantId]),
			/report_sends_sitting_kind/,
		);
	});
});

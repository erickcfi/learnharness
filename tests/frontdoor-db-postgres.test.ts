/**
 * The migrations and the data-access module on a real Postgres server,
 * through the production adapter (postgres.js), as a second check beside the
 * in-process PGlite tests.
 *
 * Runs only when LH_TEST_PG=1. It connects with the standard Postgres
 * variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) to a throwaway
 * server where it may create roles and create and drop a scratch database,
 * for example a local superuser over the socket:
 *
 *     LH_TEST_PG=1 PGHOST=/var/run/postgresql npx tsx --test tests/frontdoor-db-postgres.test.ts
 *
 * CI has no such server, so it skips there. Never point it at Supabase.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import postgres from "postgres";
import * as dbm from "../frontdoor/db/index.ts";
import { readMigrations } from "../frontdoor/db/migrations.ts";
import { SUPABASE_ROLES_SQL } from "../frontdoor/db/testing.ts";
import { EXPECTED_TABLES } from "./helpers/frontdoor-db-tables.ts";

const enabled = process.env.LH_TEST_PG === "1";
const AGE = new Date("2026-11-01T12:00:00Z");

describe("real Postgres through postgres.js", { skip: !enabled && "set LH_TEST_PG=1 and the PG* variables to run" }, () => {
	const name = `lh_db_test_${process.pid}_${Date.now()}`;
	let admin: postgres.Sql;
	let sql: postgres.Sql;
	let db: dbm.Db;

	before(async () => {
		admin = postgres({ max: 1, onnotice: () => {} });
		await admin.unsafe(`create database ${name}`);
		sql = postgres({ database: name, max: 2, onnotice: () => {} });
		await sql.unsafe(SUPABASE_ROLES_SQL);
		for (const m of readMigrations()) await sql.unsafe(m.sql);
		db = dbm.fromPostgresJs(sql);
	});
	after(async () => {
		await sql?.end();
		await admin?.unsafe(`drop database if exists ${name} with (force)`);
		await admin?.end();
	});

	it("applies every migration and switches RLS on for every table", async () => {
		const rows = await db.query<{ relname: string; relrowsecurity: boolean }>(
			"select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by c.relname",
		);
		assert.deepEqual(
			rows.map((r) => r.relname),
			EXPECTED_TABLES,
		);
		for (const r of rows) assert.equal(r.relrowsecurity, true, `RLS is off on ${r.relname}`);
		assert.deepEqual(await db.query("select policyname from pg_policies where schemaname = 'public'"), []);
		assert.deepEqual(
			await db.query("select table_name from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')"),
			[],
		);
	});

	it("refuses the authenticated role", async () => {
		await assert.rejects(
			sql.begin(async (tx) => {
				await tx.unsafe("set local role authenticated");
				await tx.unsafe("select * from public.tenants");
			}),
			/permission denied/,
		);
	});

	it("runs the module through the production adapter", async () => {
		const { tenant } = await dbm.createStudentAccount(db, { clerkUserId: "user_pg_1", age18ConfirmedAt: AGE });
		assert.equal(tenant.folder, `tenants/${tenant.id}`);
		const now = new Date();
		await dbm.recordModelUsage(db, {
			tenantId: tenant.id,
			occurredAt: now,
			model: "claude-opus-5-5",
			inputTokens: 1,
			outputTokens: 2,
			cacheReadTokens: 3,
			cacheWriteTokens: 4,
			costUsd: 0.000137,
			requestId: "msg_pg_1",
		});
		assert.equal((await dbm.recordModelUsage(db, { tenantId: tenant.id, model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1, requestId: "msg_pg_1" })).recorded, false);
		assert.equal(await dbm.rollingModelCost(db, tenant.id, now), 0.000137);
		const [usage] = await dbm.listModelUsage(db, tenant.id);
		assert.equal(typeof usage!.id, "number");
		assert.equal(usage!.costUsd, 0.000137);

		const event = { id: "evt_pg_1", type: "invoice.paid", createdAt: now };
		await assert.rejects(
			dbm.processStripeEventOnce(db, event, async (tx) => {
				await dbm.recordSearch(tx, { tenantId: tenant.id, feeUsd: 0.008 });
				throw new Error("boom");
			}),
		);
		assert.equal((await dbm.searchUsageSince(db, tenant.id, new Date(0))).count, 0);
		assert.equal(await dbm.processStripeEventOnce(db, event, async () => {}), "processed");
		assert.equal(await dbm.processStripeEventOnce(db, event, async () => {}), "duplicate");

		await dbm.addActiveStudyTime(db, { tenantId: tenant.id, chatId: "c", at: now, seconds: 60, maxGapSeconds: 300 });
		assert.equal(await dbm.studySecondsSince(db, tenant.id, new Date(now.getTime() - 3_600_000)), 60);
		const s = await dbm.getReportSettings(db, tenant.id);
		assert.match(s.unsubscribeToken, /^[0-9a-f]{64}$/);
		const send = await dbm.claimReportSend(db, { tenantId: tenant.id, kind: "weekly", weekStart: "2026-11-02" });
		assert.equal(send?.weekStart, "2026-11-02");
		assert.equal((await dbm.getTenantOverview(db, tenant.id))?.dashboardStatus, "none");
		assert.equal((await dbm.getOwnerSettings(db)).autopauseUsd, 89);
		assert.equal(await dbm.deleteTenantAndAccount(db, tenant.id), true);
	});
});

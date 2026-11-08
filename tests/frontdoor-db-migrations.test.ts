/**
 * The tutor's Supabase migrations (P1-03, C1 req 7, PD5). Every migration in
 * frontdoor/supabase/migrations/ applies cleanly, in order, to a fresh
 * Postgres (PGlite, in-process), and the result has the project's tables.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readMigrations } from "../frontdoor/db/migrations.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import { EXPECTED_TABLES } from "./helpers/frontdoor-db-tables.ts";

describe("migration files", () => {
	it("use the Supabase CLI name format and sort in apply order", () => {
		const migrations = readMigrations();
		assert.ok(migrations.length > 0, "no migrations found");
		for (const m of migrations) {
			assert.match(m.name, /^\d{14}_[a-z0-9_]+\.sql$/, `bad migration name: ${m.name}`);
			assert.ok(m.sql.trim().length > 0, `${m.name} is empty`);
		}
		const names = migrations.map((m) => m.name);
		assert.deepEqual(names, [...names].sort());
	});
});

describe("a fresh database", () => {
	let t: TestDb;
	before(async () => {
		t = await createTestDb();
	});
	after(async () => {
		await t.close();
	});

	it("gets every table, and nothing else, in public", async () => {
		const rows = await t.db.query<{ table_name: string }>(
			"select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
		);
		assert.deepEqual(
			rows.map((r) => r.table_name),
			EXPECTED_TABLES,
		);
	});

	it("gets the tenant_overview view", async () => {
		const rows = await t.db.query<{ table_name: string }>(
			"select table_name from information_schema.views where table_schema = 'public' order by table_name",
		);
		assert.deepEqual(
			rows.map((r) => r.table_name),
			["tenant_overview"],
		);
	});

	it("seeds the Owner's thresholds: alert $60, autopause $89", async () => {
		const rows = await t.db.query<{ alert_usd: string; autopause_usd: string }>(
			"select alert_usd, autopause_usd from owner_settings",
		);
		assert.equal(rows.length, 1);
		assert.equal(Number(rows[0]!.alert_usd), 60);
		assert.equal(Number(rows[0]!.autopause_usd), 89);
	});

	it("allows only one owner_settings row", async () => {
		await assert.rejects(t.db.query("insert into owner_settings (id) values (2)"));
		await assert.rejects(t.db.query("insert into owner_settings (id) values (1)"));
	});
});

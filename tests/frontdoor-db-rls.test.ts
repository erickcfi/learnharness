/**
 * Row-level security (C1 req 7, PD5). Owner's choice (2026-11-08): RLS is on
 * for every table, with no allow rules, and Supabase's `anon` and
 * `authenticated` roles get no table rights. Only the server reads and writes.
 *
 * Two layers are checked. First, a non-service role is refused outright (no
 * grants). Second, even when a grant is added by mistake, RLS still returns
 * no rows, so tenant A's login never sees tenant B's rows.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import { EXPECTED_TABLES, NON_TENANT_TABLES } from "./helpers/frontdoor-db-tables.ts";

const NON_SERVICE_ROLES = ["anon", "authenticated"] as const;
const AGE = new Date("2026-11-01T12:00:00Z");

let t: TestDb;
let tenantA: dbm.Tenant;
let tenantB: dbm.Tenant;
let accountB: dbm.Account;

/** One row of tenant B's data in every table, so each table has something to leak. */
async function seedTenant(db: dbm.Db, clerkUserId: string, suffix: string) {
	const { account, tenant } = await dbm.createStudentAccount(db, { clerkUserId, age18ConfirmedAt: AGE });
	await dbm.grantRole(db, { accountId: account.id, role: "staff" });
	await dbm.grantConsent(db, { tenantId: tenant.id, kind: "session_text_opt_in" });
	await dbm.recordModelUsage(db, {
		tenantId: tenant.id,
		model: "claude-opus-5-5",
		inputTokens: 10,
		outputTokens: 20,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.01,
		requestId: `msg_${suffix}`,
	});
	await dbm.recordSearch(db, { tenantId: tenant.id, feeUsd: 0.008 });
	await dbm.openAlert(db, { tenantId: tenant.id, kind: "cost_alert", thresholdUsd: 60, windowCostUsd: 61 });
	await dbm.pauseTenant(db, { tenantId: tenant.id, reason: "owner" });
	await dbm.setStripeCustomerId(db, tenant.id, `cus_${suffix}`);
	await dbm.upsertSubscription(db, {
		stripeSubscriptionId: `sub_${suffix}`,
		tenantId: tenant.id,
		status: "trialing",
		plan: "monthly",
		eventCreatedAt: new Date("2026-11-02T00:00:00Z"),
	});
	await dbm.processStripeEventOnce(db, { id: `evt_${suffix}`, type: "customer.subscription.created", createdAt: new Date() }, async () => {});
	await dbm.upsertInvoice(db, {
		stripeInvoiceId: `in_${suffix}`,
		tenantId: tenant.id,
		status: "paid",
		amountPaidCents: 6900,
	});
	await dbm.claimTrial(db, { emailHash: dbm.hashEmailForTrial(`${suffix}@example.com`, "test-key"), cardFingerprint: `fp_${suffix}` });
	await dbm.addActiveStudyTime(db, { tenantId: tenant.id, chatId: "chat-1", seconds: 60, maxGapSeconds: 300 });
	await dbm.updateReportSettings(db, tenant.id, { weeklyReportEnabled: true, reportEmail: `${suffix}@example.com` });
	await dbm.claimReportSend(db, { tenantId: tenant.id, kind: "session", chatId: "chat-1" });
	await dbm.saveTopicLabel(db, { tenantId: tenant.id, chatId: "chat-1", topic: "METAR", isAviation: true, model: "claude-haiku-5-5" });
	await dbm.recordLegStart(db, { tenantId: tenant.id, legId: "sample-leg", chatId: "chat-1" });
	// Sealed bytes only (own AI key, 2026-11-13); no real key.
	await dbm.saveOwnAiKey(db, { tenantId: tenant.id, ciphertext: Buffer.alloc(40, 1), iv: Buffer.alloc(12, 2), authTag: Buffer.alloc(16, 3), last4: "TEST" });
	return { account, tenant };
}

/** Run fn as a Supabase role, with a signed-in user's claims set the way PostgREST sets them. */
async function asRole<T>(pg: PGlite, role: string, sub: string | null, fn: () => Promise<T>): Promise<T> {
	await pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(sub ? { sub, role } : { role })]);
	await pg.exec(`set role ${role}`);
	try {
		return await fn();
	} finally {
		await pg.exec("reset role");
		await pg.query("select set_config('request.jwt.claims', '', false)");
	}
}

before(async () => {
	t = await createTestDb();
	({ tenant: tenantA } = await seedTenant(t.db, "user_rls_a", "a"));
	({ account: accountB, tenant: tenantB } = await seedTenant(t.db, "user_rls_b", "b"));
});
after(async () => {
	await t.close();
});

describe("RLS setup in the catalog", () => {
	it("has RLS switched on for every table in public", async () => {
		const rows = await t.db.query<{ relname: string; relrowsecurity: boolean }>(
			"select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by c.relname",
		);
		assert.deepEqual(
			rows.map((r) => r.relname),
			EXPECTED_TABLES,
		);
		for (const r of rows) assert.equal(r.relrowsecurity, true, `RLS is off on ${r.relname}`);
	});

	it("has no allow rules (policies) at all", async () => {
		const rows = await t.db.query("select schemaname, tablename, policyname from pg_policies where schemaname = 'public'");
		assert.deepEqual(rows, []);
	});

	it("gives anon and authenticated no rights on any table, view or sequence", async () => {
		const rows = await t.db.query<{ grantee: string; table_name: string; privilege_type: string }>(
			"select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')",
		);
		assert.deepEqual(rows, []);
		const seq = await t.db.query<{ sequence_name: string }>(
			"select c.relname as sequence_name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'S' and (has_sequence_privilege('anon', c.oid, 'USAGE') or has_sequence_privilege('authenticated', c.oid, 'USAGE'))",
		);
		assert.deepEqual(seq, []);
	});

	it("gives service_role read and write rights on every table", async () => {
		for (const table of EXPECTED_TABLES) {
			for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
				const [row] = await t.db.query<{ ok: boolean }>("select has_table_privilege('service_role', $1, $2) as ok", [`public.${table}`, priv]);
				assert.equal(row!.ok, true, `service_role lacks ${priv} on ${table}`);
			}
		}
	});
});

describe("a non-service login", () => {
	for (const role of NON_SERVICE_ROLES) {
		it(`(${role}) is refused on every table and the view`, async () => {
			for (const table of [...EXPECTED_TABLES, "tenant_overview"]) {
				await assert.rejects(
					asRole(t.pg, role, "user_rls_a", () => t.pg.query(`select * from public.${table}`)),
					/permission denied/,
					`${role} could read ${table}`,
				);
			}
		});

		it(`(${role}) cannot write tenant B's rows`, async () => {
			await assert.rejects(
				asRole(t.pg, role, "user_rls_a", () => t.pg.query("update public.tenants set status = 'ready' where id = $1", [tenantB.id])),
				/permission denied/,
			);
			await assert.rejects(
				asRole(t.pg, role, "user_rls_a", () => t.pg.query("delete from public.accounts where id = $1", [accountB.id])),
				/permission denied/,
			);
		});
	}

	it("sees no rows of tenant B, or any rows, even if a grant is added by mistake", async () => {
		await t.pg.exec("grant select, insert, update, delete on all tables in schema public to anon, authenticated");
		try {
			for (const role of NON_SERVICE_ROLES) {
				for (const table of EXPECTED_TABLES) {
					const res = await asRole(t.pg, role, "user_rls_a", () => t.pg.query(`select * from public.${table}`));
					assert.equal(res.rows.length, 0, `${role} saw ${res.rows.length} row(s) of ${table}`);
				}
				const upd = await asRole(t.pg, role, "user_rls_a", () =>
					t.pg.query("update public.tenants set status = 'ready' where id = $1", [tenantB.id]),
				);
				assert.equal(upd.affectedRows ?? 0, 0, `${role} updated tenant B`);
				await assert.rejects(
					asRole(t.pg, role, "user_rls_a", () => t.pg.query("insert into public.search_usage (tenant_id, fee_usd) values ($1, 0)", [tenantB.id])),
					/row-level security/,
				);
			}
		} finally {
			await t.pg.exec("revoke all on all tables in schema public from anon, authenticated");
		}
	});
});

describe("the service role", () => {
	it("reads both tenants' rows in every tenant table", async () => {
		const tenantTables = EXPECTED_TABLES.filter((n) => !NON_TENANT_TABLES.includes(n));
		for (const table of tenantTables) {
			const col = table === "tenants" ? "id" : "tenant_id";
			const res = await asRole(t.pg, "service_role", null, () =>
				t.pg.query<{ n: number }>(`select count(distinct ${col})::int as n from public.${table} where ${col} in ($1, $2)`, [tenantA.id, tenantB.id]),
			);
			assert.equal(res.rows[0]!.n, 2, `service_role sees ${res.rows[0]!.n} tenant(s) in ${table}`);
		}
	});
});

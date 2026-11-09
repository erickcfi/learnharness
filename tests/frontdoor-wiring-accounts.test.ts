/**
 * The Supabase-backed AccountStore (W1-6 wire-up; PRD C1 req 2, 5, 7, D28).
 *
 * The front door talks to the AccountStore interface (tenants/accounts.ts).
 * This adapter maps it onto frontdoor/db, as the database notes say:
 *   get          -> getAccountByClerkUserId + getTenantByAccountId
 *   confirmAge   -> ensureStudentAccount (keeps the first 18+ date)
 *   assignTenant -> getTenantByClerkUserId; no account -> AgeNotConfirmedError
 * The tenant id is the one the database made. Runs on PGlite.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import { AgeNotConfirmedError } from "../frontdoor/tenants/accounts.ts";
import { isTenantId } from "../frontdoor/tenants/paths.ts";
import { SupabaseAccountStore } from "../frontdoor/tenants/supabase-accounts.ts";

const FIRST = new Date("2026-11-01T12:00:00Z");
const LATER = new Date("2026-11-05T09:30:00Z");
let t: TestDb;
let store: SupabaseAccountStore;
let n = 0;
const userId = () => `user_wire_${++n}`;

before(async () => {
	t = await createTestDb();
	store = new SupabaseAccountStore(t.db);
});
after(async () => {
	await t.close();
});

describe("Supabase AccountStore", () => {
	it("has no account before the 18+ tick", async () => {
		assert.equal(await store.get(userId()), null);
	});

	it("refuses a tenant before the 18+ tick (D28)", async () => {
		await assert.rejects(store.assignTenant(userId()), AgeNotConfirmedError);
	});

	it("confirmAge saves the date and makes the account and its tenant", async () => {
		const id = userId();
		const account = await store.confirmAge(id, FIRST);
		assert.equal(account.userId, id);
		assert.equal(account.ageConfirmedAt?.toISOString(), FIRST.toISOString());
		assert.ok(account.tenantId && isTenantId(account.tenantId), "a UUID tenant id from the database");
		const row = await dbm.getTenantByClerkUserId(t.db, id);
		assert.equal(row?.id, account.tenantId);
		assert.equal(row?.status, "provisioning");
	});

	it("confirmAge is safe to repeat and keeps the first date", async () => {
		const id = userId();
		const first = await store.confirmAge(id, FIRST);
		const second = await store.confirmAge(id, LATER);
		assert.equal(second.ageConfirmedAt?.toISOString(), FIRST.toISOString());
		assert.equal(second.tenantId, first.tenantId);
	});

	it("two tabs confirming at once get one account and one tenant", async () => {
		const id = userId();
		const [a, b] = await Promise.all([store.confirmAge(id, FIRST), store.confirmAge(id, LATER)]);
		assert.equal(a.tenantId, b.tenantId);
		const rows = await t.db.query("select t.id from tenants t join accounts a on a.id = t.account_id where a.clerk_user_id = $1", [id]);
		assert.equal(rows.length, 1);
	});

	it("assignTenant returns the database's tenant, the same every time", async () => {
		const id = userId();
		const { tenantId } = await store.confirmAge(id, FIRST);
		assert.equal(await store.assignTenant(id), tenantId);
		assert.equal(await store.assignTenant(id), tenantId);
	});

	it("get returns the account with its tenant and dates", async () => {
		const id = userId();
		const made = await store.confirmAge(id, FIRST);
		const got = await store.get(id);
		assert.ok(got);
		assert.equal(got.userId, id);
		assert.equal(got.tenantId, made.tenantId);
		assert.equal(got.ageConfirmedAt?.toISOString(), FIRST.toISOString());
		assert.ok(got.createdAt instanceof Date);
	});

	it("an account made without a tenant (the Owner) gets one on its first sign-in", async () => {
		const id = userId();
		await dbm.createAccount(t.db, { clerkUserId: id, age18ConfirmedAt: FIRST });
		const got = await store.get(id);
		assert.equal(got?.tenantId, null);
		const tenantId = await store.assignTenant(id);
		assert.ok(isTenantId(tenantId));
		assert.equal((await store.get(id))?.tenantId, tenantId);
	});
});

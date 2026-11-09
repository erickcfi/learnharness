/**
 * Data access: accounts, tenants, roles, consents, retention (C1 req 2, 5, 6,
 * 7; C7 req 1 and 3; section 3 roles; D19, D25, D27, D28).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";

const AGE = new Date("2026-11-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
let t: TestDb;
let n = 0;
const clerkId = () => `user_acc_${++n}`;
const student = () => dbm.createStudentAccount(t.db, { clerkUserId: clerkId(), age18ConfirmedAt: AGE });

before(async () => {
	t = await createTestDb();
});
after(async () => {
	await t.close();
});

describe("accounts and tenants", () => {
	it("createStudentAccount makes an account and its tenant folder mapping", async () => {
		const id = clerkId();
		const { account, tenant } = await dbm.createStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: AGE });
		assert.equal(account.clerkUserId, id);
		assert.equal(account.age18ConfirmedAt.toISOString(), AGE.toISOString());
		assert.ok(account.createdAt instanceof Date);
		assert.equal(tenant.accountId, account.id);
		assert.match(tenant.id, /^[0-9a-f-]{36}$/);
		assert.equal(tenant.folder, `tenants/${tenant.id}`);
		assert.equal(tenant.status, "provisioning");
		assert.equal(tenant.readyAt, null);
		assert.equal(tenant.retentionEndsAt, null);
		assert.equal(tenant.stripeCustomerId, null);
	});

	it("refuses a second account for the same Clerk user", async () => {
		const id = clerkId();
		await dbm.createStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: AGE });
		await assert.rejects(dbm.createStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: AGE }));
		assert.equal((await t.db.query("select 1 from accounts where clerk_user_id = $1", [id])).length, 1);
	});

	it("refuses an account without the 18+ confirmation date (D28)", async () => {
		await assert.rejects(t.db.query("insert into accounts (clerk_user_id) values ($1)", [clerkId()]));
	});

	it("allows only one tenant per account", async () => {
		const { account } = await student();
		await assert.rejects(dbm.createTenant(t.db, account.id));
	});

	it("an Owner or staff account can exist with no tenant", async () => {
		const account = await dbm.createAccount(t.db, { clerkUserId: clerkId(), age18ConfirmedAt: AGE });
		assert.equal(await dbm.getTenantByAccountId(t.db, account.id), null);
	});

	it("looks a tenant up by Clerk user, account, tenant ID", async () => {
		const id = clerkId();
		const { account, tenant } = await dbm.createStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: AGE });
		assert.deepEqual(await dbm.getAccountByClerkUserId(t.db, id), account);
		assert.deepEqual(await dbm.getTenantByClerkUserId(t.db, id), tenant);
		assert.deepEqual(await dbm.getTenantByAccountId(t.db, account.id), tenant);
		assert.deepEqual(await dbm.getTenant(t.db, tenant.id), tenant);
		assert.equal(await dbm.getTenantByClerkUserId(t.db, "user_nobody"), null);
		assert.equal(await dbm.getAccountByClerkUserId(t.db, "user_nobody"), null);
		assert.equal(await dbm.getTenant(t.db, "00000000-0000-4000-8000-000000000000"), null);
	});

	it("markTenantReady moves a tenant from provisioning to ready", async () => {
		const { tenant } = await student();
		const at = new Date("2026-11-08T10:00:00Z");
		const ready = await dbm.markTenantReady(t.db, tenant.id, at);
		assert.equal(ready.status, "ready");
		assert.equal(ready.readyAt?.toISOString(), at.toISOString());
	});

	it("markTenantReady is safe to repeat: a ready tenant comes back unchanged", async () => {
		const { tenant } = await student();
		const first = new Date("2026-11-08T10:00:00Z");
		await dbm.markTenantReady(t.db, tenant.id, first);
		const again = await dbm.markTenantReady(t.db, tenant.id, new Date("2026-11-09T10:00:00Z"));
		assert.equal(again.status, "ready");
		assert.equal(again.readyAt?.toISOString(), first.toISOString());
	});

	it("markTenantReady leaves a tenant in retention as it is", async () => {
		const { tenant } = await student();
		await dbm.markTenantReady(t.db, tenant.id);
		const kept = await dbm.startRetention(t.db, tenant.id, new Date("2026-12-01T00:00:00Z"));
		const after91 = await dbm.markTenantReady(t.db, tenant.id);
		assert.deepEqual(after91, kept);
		assert.equal(after91.status, "retention");
	});

	it("markTenantReady throws for a tenant that does not exist", async () => {
		await assert.rejects(dbm.markTenantReady(t.db, "00000000-0000-4000-8000-000000000000"));
	});

	it("ensureStudentAccount makes the account and its tenant on the first call", async () => {
		const id = clerkId();
		const { account, tenant } = await dbm.ensureStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: AGE });
		assert.equal(account.clerkUserId, id);
		assert.equal(account.age18ConfirmedAt.toISOString(), AGE.toISOString());
		assert.equal(tenant.accountId, account.id);
		assert.equal(tenant.folder, `tenants/${tenant.id}`);
		assert.equal(tenant.status, "provisioning");
		assert.deepEqual(await dbm.getTenantByClerkUserId(t.db, id), tenant);
	});

	it("ensureStudentAccount is safe to repeat and keeps the first 18+ date", async () => {
		const id = clerkId();
		const first = await dbm.ensureStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: AGE });
		const again = await dbm.ensureStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: new Date(AGE.getTime() + DAY) });
		assert.deepEqual(again, first);
		assert.equal(again.account.age18ConfirmedAt.toISOString(), AGE.toISOString());
		assert.equal((await t.db.query("select 1 from accounts where clerk_user_id = $1", [id])).length, 1);
		assert.equal((await t.db.query("select 1 from tenants where account_id = $1", [first.account.id])).length, 1);
	});

	it("two ensureStudentAccount calls at once give one account and one tenant", async () => {
		const id = clerkId();
		const [a, b] = await Promise.all([
			dbm.ensureStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: AGE }),
			dbm.ensureStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: new Date(AGE.getTime() + DAY) }),
		]);
		assert.deepEqual(a, b);
		assert.equal((await t.db.query("select 1 from accounts where clerk_user_id = $1", [id])).length, 1);
	});

	it("ensureStudentAccount returns a tenant that is already ready as it is", async () => {
		const id = clerkId();
		const { tenant } = await dbm.ensureStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: AGE });
		const ready = await dbm.markTenantReady(t.db, tenant.id);
		const again = await dbm.ensureStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: AGE });
		assert.deepEqual(again.tenant, ready);
	});

	it("ensureStudentAccount gives a tenant to an account that has none, keeping its date", async () => {
		const id = clerkId();
		const account = await dbm.createAccount(t.db, { clerkUserId: id, age18ConfirmedAt: AGE });
		const got = await dbm.ensureStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: new Date(AGE.getTime() + DAY) });
		assert.deepEqual(got.account, account);
		assert.equal(got.tenant.accountId, account.id);
		assert.equal(got.tenant.status, "provisioning");
	});

	it("listTenants includes every tenant", async () => {
		const { tenant } = await student();
		const all = await dbm.listTenants(t.db);
		assert.ok(all.some((x) => x.id === tenant.id));
	});
});

describe("roles (owner, staff)", () => {
	it("grants, checks, lists and revokes roles; no role means student", async () => {
		const owner = await dbm.createAccount(t.db, { clerkUserId: clerkId(), age18ConfirmedAt: AGE });
		const { account: pupil } = await student();
		assert.deepEqual(await dbm.getRoles(t.db, owner.id), []);
		await dbm.grantRole(t.db, { accountId: owner.id, role: "owner" });
		await dbm.grantRole(t.db, { accountId: owner.id, role: "owner" });
		await dbm.grantRole(t.db, { accountId: owner.id, role: "staff", grantedBy: owner.id });
		assert.deepEqual(await dbm.getRoles(t.db, owner.id), ["owner", "staff"]);
		assert.equal(await dbm.hasRole(t.db, owner.id, "owner"), true);
		assert.equal(await dbm.hasRole(t.db, pupil.id, "owner"), false);
		assert.equal(await dbm.revokeRole(t.db, owner.id, "staff"), true);
		assert.equal(await dbm.revokeRole(t.db, owner.id, "staff"), false);
		assert.deepEqual(await dbm.getRoles(t.db, owner.id), ["owner"]);
	});

	it("refuses a role other than owner or staff", async () => {
		const a = await dbm.createAccount(t.db, { clerkUserId: clerkId(), age18ConfirmedAt: AGE });
		await assert.rejects(t.db.query("insert into account_roles (account_id, role) values ($1, 'student')", [a.id]));
	});
});

describe("consents with dates (D19, C7 req 3)", () => {
	it("records, checks and revokes a session-text opt-in, keeping its history", async () => {
		const { tenant } = await student();
		assert.equal(await dbm.hasActiveConsent(t.db, tenant.id, "session_text_opt_in"), false);
		const g1 = new Date("2026-11-02T09:00:00Z");
		const c = await dbm.grantConsent(t.db, { tenantId: tenant.id, kind: "session_text_opt_in", at: g1 });
		assert.equal(c.grantedAt.toISOString(), g1.toISOString());
		assert.equal(c.revokedAt, null);
		const again = await dbm.grantConsent(t.db, { tenantId: tenant.id, kind: "session_text_opt_in" });
		assert.equal(again.id, c.id, "a second grant while active keeps the first record");
		assert.equal(await dbm.hasActiveConsent(t.db, tenant.id, "session_text_opt_in"), true);
		const r1 = new Date("2026-11-03T09:00:00Z");
		assert.equal(await dbm.revokeConsent(t.db, { tenantId: tenant.id, kind: "session_text_opt_in", at: r1 }), true);
		assert.equal(await dbm.revokeConsent(t.db, { tenantId: tenant.id, kind: "session_text_opt_in" }), false);
		assert.equal(await dbm.hasActiveConsent(t.db, tenant.id, "session_text_opt_in"), false);
		await dbm.grantConsent(t.db, { tenantId: tenant.id, kind: "session_text_opt_in" });
		const history = await dbm.listConsents(t.db, tenant.id);
		assert.equal(history.length, 2);
		assert.equal(history[0]!.revokedAt?.toISOString(), r1.toISOString());
		assert.equal(history[1]!.revokedAt, null);
	});

	it("records a tester's written OK with who recorded it and a note", async () => {
		const owner = await dbm.createAccount(t.db, { clerkUserId: clerkId(), age18ConfirmedAt: AGE });
		const { tenant } = await student();
		const c = await dbm.grantConsent(t.db, { tenantId: tenant.id, kind: "tester_written_ok", recordedBy: owner.id, note: "signed form on file" });
		assert.equal(c.recordedBy, owner.id);
		assert.equal(c.note, "signed form on file");
	});

	it("canShowSessionText is true only with an active opt-in or tester OK", async () => {
		const { tenant: a } = await student();
		const { tenant: b } = await student();
		const { tenant: c } = await student();
		await dbm.grantConsent(t.db, { tenantId: a.id, kind: "session_text_opt_in" });
		await dbm.grantConsent(t.db, { tenantId: b.id, kind: "tester_written_ok" });
		assert.equal(await dbm.canShowSessionText(t.db, a.id), true);
		assert.equal(await dbm.canShowSessionText(t.db, b.id), true);
		assert.equal(await dbm.canShowSessionText(t.db, c.id), false);
		await dbm.revokeConsent(t.db, { tenantId: a.id, kind: "session_text_opt_in" });
		assert.equal(await dbm.canShowSessionText(t.db, a.id), false);
	});
});

describe("retention and day-91 delete (C1 req 6, D25)", () => {
	it("starts a 90-day retention when the subscription ends", async () => {
		const { tenant } = await student();
		await dbm.markTenantReady(t.db, tenant.id);
		const ended = new Date("2026-12-01T00:00:00Z");
		const r = await dbm.startRetention(t.db, tenant.id, ended);
		assert.equal(r.status, "retention");
		assert.equal(r.retentionEndsAt?.toISOString(), new Date(ended.getTime() + 90 * DAY).toISOString());
	});

	it("lists the tenant for deletion on day 91, not on day 89", async () => {
		const { tenant } = await student();
		const ended = new Date("2027-01-10T00:00:00Z");
		await dbm.startRetention(t.db, tenant.id, ended);
		const day89 = new Date(ended.getTime() + 89 * DAY);
		const day91 = new Date(ended.getTime() + 91 * DAY);
		assert.ok(!(await dbm.listTenantsDueForDeletion(t.db, day89)).some((x) => x.id === tenant.id));
		assert.ok((await dbm.listTenantsDueForDeletion(t.db, day91)).some((x) => x.id === tenant.id));
	});

	it("endRetention returns a resubscribed tenant to ready", async () => {
		const { tenant } = await student();
		await dbm.startRetention(t.db, tenant.id, new Date());
		const back = await dbm.endRetention(t.db, tenant.id);
		assert.equal(back.status, "ready");
		assert.equal(back.retentionEndsAt, null);
	});

	it("refuses retention status without an end date", async () => {
		const { tenant } = await student();
		await assert.rejects(t.db.query("update tenants set status = 'retention' where id = $1", [tenant.id]));
	});

	it("deleteTenantAndAccount removes every row of the tenant, but keeps trial claims and Stripe event IDs", async () => {
		const id = clerkId();
		const { account, tenant } = await dbm.createStudentAccount(t.db, { clerkUserId: id, age18ConfirmedAt: AGE });
		await dbm.grantRole(t.db, { accountId: account.id, role: "staff" });
		await dbm.grantConsent(t.db, { tenantId: tenant.id, kind: "session_text_opt_in" });
		await dbm.recordModelUsage(t.db, {
			tenantId: tenant.id,
			model: "claude-opus-5-5",
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.5,
		});
		await dbm.recordSearch(t.db, { tenantId: tenant.id, feeUsd: 0.008 });
		await dbm.openAlert(t.db, { tenantId: tenant.id, kind: "cost_alert", thresholdUsd: 60, windowCostUsd: 60.5 });
		await dbm.pauseTenant(t.db, { tenantId: tenant.id, reason: "autopause" });
		await dbm.upsertSubscription(t.db, { stripeSubscriptionId: "sub_del", tenantId: tenant.id, status: "canceled", eventCreatedAt: new Date() });
		await dbm.upsertInvoice(t.db, { stripeInvoiceId: "in_del", tenantId: tenant.id, status: "paid", amountPaidCents: 6900 });
		await dbm.processStripeEventOnce(t.db, { id: "evt_del", type: "invoice.paid", createdAt: new Date() }, async () => {});
		const emailHash = dbm.hashEmailForTrial("deleted@example.com", "k");
		await dbm.claimTrial(t.db, { emailHash, cardFingerprint: "fp_del" });
		await dbm.addActiveStudyTime(t.db, { tenantId: tenant.id, seconds: 30, maxGapSeconds: 300 });
		await dbm.updateReportSettings(t.db, tenant.id, { sessionReportEnabled: true, reportEmail: "deleted@example.com" });
		await dbm.claimReportSend(t.db, { tenantId: tenant.id, kind: "weekly", weekStart: "2026-11-02" });
		await dbm.saveTopicLabel(t.db, { tenantId: tenant.id, chatId: "c", topic: "Cooking", isAviation: false, model: "claude-haiku-5-5" });

		assert.equal(await dbm.deleteTenantAndAccount(t.db, tenant.id), true);
		assert.equal(await dbm.getAccountByClerkUserId(t.db, id), null);
		for (const table of [
			"tenants",
			"consents",
			"model_usage",
			"search_usage",
			"alerts",
			"pauses",
			"subscriptions",
			"invoices",
			"study_time",
			"report_settings",
			"report_sends",
			"topic_labels",
		]) {
			const col = table === "tenants" ? "id" : "tenant_id";
			const rows = await t.db.query(`select 1 from ${table} where ${col} = $1`, [tenant.id]);
			assert.equal(rows.length, 0, `${table} kept a row after delete`);
		}
		assert.equal((await t.db.query("select 1 from account_roles where account_id = $1", [account.id])).length, 0);
		assert.equal(await dbm.isTrialUsed(t.db, { emailHash }), true);
		assert.equal(await dbm.isTrialUsed(t.db, { cardFingerprint: "fp_del" }), true);
		assert.equal((await t.db.query("select 1 from stripe_events where id = 'evt_del'")).length, 1);
		assert.equal(await dbm.deleteTenantAndAccount(t.db, tenant.id), false);
	});
});

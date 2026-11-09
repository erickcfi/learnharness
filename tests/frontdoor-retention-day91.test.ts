/**
 * P1-08 (C1 req 6, D25; trial record decision 2026-11-08): retention and
 * the day-91 delete, with the clock mocked.
 *
 * C1 acceptance test: a canceled tenant's data exists and exports on day
 * 89, and is gone on day 91. After the delete, only the trial record (and
 * Stripe event ids, which hold no personal data) is left.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import { readTenantAccess } from "../frontdoor/pause/access.ts";
import { createRetention, nightlyRoot } from "../frontdoor/retention/lifecycle.ts";
import { startJobs } from "../frontdoor/retention/schedule.ts";
import { tenantAuthFile, tenantDir } from "../frontdoor/tenants/paths.ts";
import { provisionTenant } from "../frontdoor/tenants/provisioning.ts";

const DAY = 24 * 60 * 60 * 1000;
const ENDED = new Date("2026-11-10T00:00:00Z");
const AGE = new Date("2026-10-01T00:00:00Z");
const EMAIL_HASH = "a".repeat(64);

let t: TestDb;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fd-day91-"));
let n = 0;

before(async () => {
	t = await createTestDb();
});
after(async () => {
	await t.close();
	fs.rmSync(work, { recursive: true, force: true });
});

/** A student with a folder, a key file, a nightly copy, and a row in every tenant table. */
async function fullStudent(volume: string) {
	const clerkUserId = `user_day91_${++n}`;
	const { account, tenant } = await dbm.createStudentAccount(t.db, { clerkUserId, age18ConfirmedAt: AGE });
	provisionTenant({ volumeDir: volume, tenantId: tenant.id });
	const dir = tenantDir(volume, tenant.id);
	fs.mkdirSync(path.join(dir, "chats"), { recursive: true });
	fs.writeFileSync(path.join(dir, "chats", "chat_1.json"), '{"title":"METAR"}');
	const night = path.join(nightlyRoot(volume), "2026-11-09");
	fs.mkdirSync(path.join(night, tenant.id), { recursive: true });
	fs.writeFileSync(path.join(night, tenant.id, "settings.json"), "{}");
	fs.writeFileSync(path.join(night, `${tenant.id}.manifest.json`), "{}");

	const q = (sql: string, params: unknown[]) => t.db.query(sql, params);
	const id = tenant.id;
	await q("insert into model_usage (tenant_id, model, cost_usd, request_id) values ($1, 'claude-opus-5-5', 1.5, $2)", [id, `req_${id}`]);
	await q("insert into search_usage (tenant_id, fee_usd) values ($1, 0.008)", [id]);
	await q("insert into alerts (tenant_id, kind, threshold_usd, window_cost_usd) values ($1, 'cost_alert', 60, 61)", [id]);
	await q("insert into pauses (tenant_id, reason) values ($1, 'autopause')", [id]);
	await q("insert into subscriptions (stripe_subscription_id, tenant_id, status, last_event_created_at) values ($1, $2, 'canceled', now())", [`sub_${id}`, id]);
	await q("insert into invoices (stripe_invoice_id, tenant_id, status, amount_paid_cents) values ($1, $2, 'paid', 6900)", [`in_${id}`, id]);
	await q("insert into study_time (tenant_id, chat_id, started_at, last_active_at, active_seconds) values ($1, 'chat_1', now(), now(), 60)", [id]);
	await q("insert into report_settings (tenant_id) values ($1)", [id]);
	await q("insert into report_sends (tenant_id, kind, week_start) values ($1, 'weekly', '2026-11-02')", [id]);
	await q("insert into topic_labels (tenant_id, chat_id, topic, is_aviation, model) values ($1, 'chat_1', 'METAR', true, 'claude-haiku-5-5')", [id]);
	await q("insert into consents (tenant_id, kind) values ($1, 'session_text_opt_in')", [id]);
	await dbm.setStripeCustomerId(t.db, id, `cus_${id}`);
	return { account, tenant, clerkUserId, dir, night };
}

/** Every public table with a tenant_id column (not the view). */
async function tenantTables(): Promise<string[]> {
	const rows = await t.db.query<{ table_name: string }>(
		`select c.table_name from information_schema.columns c join information_schema.tables tb on tb.table_name = c.table_name and tb.table_schema = c.table_schema
		 where c.table_schema = 'public' and c.column_name = 'tenant_id' and tb.table_type = 'BASE TABLE' order by 1`,
	);
	return rows.map((r) => r.table_name);
}

async function rowsFor(tenantId: string): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	for (const table of await tenantTables()) {
		const [r] = await t.db.query<{ n: unknown }>(`select count(*) as n from ${table} where tenant_id = $1`, [tenantId]);
		out[table] = Number(r!.n);
	}
	return out;
}

describe("retention and the day-91 delete (C1 req 6, D25)", () => {
	it("keeps a canceled tenant on day 89 and deletes it on day 91, leaving only the trial record", async () => {
		const volume = path.join(work, "v1");
		const s = await fullStudent(volume);
		const other = await fullStudent(volume);
		await dbm.claimTrial(t.db, { emailHash: EMAIL_HASH, cardFingerprint: "fp_day91_card" });
		await t.db.query("insert into stripe_events (id, type, stripe_created_at) values ('evt_day91', 'customer.subscription.deleted', now())");

		let clock = new Date(ENDED.getTime() + 60_000);
		const logs: string[] = [];
		const stopped: string[] = [];
		const retention = createRetention({ db: t.db, volumeDir: volume, now: () => clock, stopTenant: async (id) => void stopped.push(id), log: (l) => logs.push(l) });

		const tenant = await retention.startRetention(s.tenant.id, ENDED);
		assert.equal(tenant.status, "retention");
		assert.equal(tenant.retentionEndsAt?.getTime(), ENDED.getTime() + 90 * DAY);
		const again = await retention.startRetention(s.tenant.id, ENDED);
		assert.equal(again.retentionEndsAt?.getTime(), tenant.retentionEndsAt?.getTime(), "a repeated Stripe event changes nothing");

		// Day 89: everything is still there, and the student may export.
		clock = new Date(ENDED.getTime() + 89 * DAY);
		assert.deepEqual(await retention.runDay91(), { due: 0, deleted: 0, failed: 0, deletedIds: [], loginsPending: 0 });
		assert.ok(fs.existsSync(path.join(s.dir, "chats", "chat_1.json")));
		assert.ok(Object.values(await rowsFor(s.tenant.id)).every((count) => count === 1), JSON.stringify(await rowsFor(s.tenant.id)));
		const day89 = await readTenantAccess(t.db, s.tenant.id, clock);
		assert.deepEqual(day89, { state: "retention", retentionEndsAt: tenant.retentionEndsAt, expired: false });

		// Day 91: gone.
		clock = new Date(ENDED.getTime() + 91 * DAY);
		assert.equal((await readTenantAccess(t.db, s.tenant.id, clock)).state, "retention", "before the job runs it reads as an expired retention");
		const result = await retention.runDay91();
		assert.deepEqual(result, { due: 1, deleted: 1, failed: 0, deletedIds: [s.tenant.id], loginsPending: 0 });
		assert.deepEqual(stopped, [s.tenant.id, s.tenant.id], "its server is stopped first, and again after the rows are gone");
		assert.equal(fs.existsSync(s.dir), false, "tenant folder deleted");
		assert.equal(fs.existsSync(tenantAuthFile(volume, s.tenant.id)), false, "key file deleted");
		assert.equal(fs.existsSync(path.join(s.night, s.tenant.id)), false, "nightly copy deleted");
		assert.equal(fs.existsSync(path.join(s.night, `${s.tenant.id}.manifest.json`)), false, "nightly manifest deleted");
		assert.ok(Object.values(await rowsFor(s.tenant.id)).every((count) => count === 0), JSON.stringify(await rowsFor(s.tenant.id)));
		assert.equal(await dbm.getAccountByClerkUserId(t.db, s.clerkUserId), null, "account row deleted");
		assert.equal(await dbm.getTenant(t.db, s.tenant.id), null);
		assert.equal((await readTenantAccess(t.db, s.tenant.id, clock)).state, "gone");

		// Only the trial record (and Stripe event ids) is left.
		const claims = await t.db.query<{ email_hash: string; card_fingerprint: string }>("select email_hash, card_fingerprint from trial_claims");
		assert.deepEqual(claims, [{ email_hash: EMAIL_HASH, card_fingerprint: "fp_day91_card" }]);
		assert.equal(await dbm.isTrialUsed(t.db, { emailHash: EMAIL_HASH }), true, "a repeat trial is still blocked");
		assert.equal((await t.db.query("select id from stripe_events")).length, 1);

		// The other student is untouched.
		assert.ok(fs.existsSync(path.join(other.dir, "chats", "chat_1.json")));
		assert.ok(fs.existsSync(path.join(other.night, other.tenant.id)));
		assert.ok(Object.values(await rowsFor(other.tenant.id)).every((count) => count === 1));

		// Safe to re-run.
		assert.deepEqual(await retention.runDay91(), { due: 0, deleted: 0, failed: 0, deletedIds: [], loginsPending: 0 });

		// Logs: ids and counts only.
		assert.ok(logs.some((l) => l.includes(s.tenant.id) && l.startsWith("day-91: deleted tenant")));
		for (const line of logs) {
			assert.ok(!line.includes(s.clerkUserId) && !line.includes("@") && !line.includes("METAR"), line);
		}
	});

	it("deletes in the order folder, rows, Clerk user; a failed Clerk delete is tried again by the next run", async () => {
		const volume = path.join(work, "v2");
		const s = await fullStudent(volume);
		const clock = new Date(ENDED.getTime() + 91 * DAY);
		let clerkUp = false;
		const order: string[] = [];
		const logs: string[] = [];
		const retention = createRetention({
			db: t.db,
			volumeDir: volume,
			now: () => clock,
			stopTenant: async () => void order.push(fs.existsSync(s.dir) ? "stop (folder there)" : "stop (folder gone)"),
			deleteLogin: async (clerkUserId) => {
				order.push((await dbm.getTenant(t.db, s.tenant.id)) ? "clerk (rows there)" : "clerk (rows gone)");
				if (!clerkUp) throw Object.assign(new Error("clerk down"), { code: "ECONNREFUSED" });
				order.push(`clerk deleted ${clerkUserId === s.clerkUserId}`);
			},
			log: (l) => logs.push(l),
		});
		await retention.startRetention(s.tenant.id, ENDED);

		const first = await retention.runDay91();
		assert.deepEqual(first, { due: 1, deleted: 1, failed: 0, deletedIds: [s.tenant.id], loginsPending: 1 });
		assert.deepEqual(order, ["stop (folder there)", "stop (folder gone)", "clerk (rows gone)"], "folder, then rows, then the Clerk user");
		assert.equal(fs.existsSync(s.dir), false);
		assert.equal(await dbm.getTenant(t.db, s.tenant.id), null, "the rows are gone even though Clerk was down");
		const pendingFile = path.join(volume, "retention", "pending-login-deletes.json");
		assert.equal(fs.statSync(pendingFile).mode & 0o777, 0o600, "the pending list is owner-only");
		assert.ok(logs.some((l) => l.includes(s.tenant.id) && l.includes("ECONNREFUSED")));
		assert.ok(logs.every((l) => !l.includes(s.clerkUserId)), "the log names the tenant, not the Clerk user");

		clerkUp = true;
		const second = await retention.runDay91();
		assert.deepEqual(second, { due: 0, deleted: 0, failed: 0, deletedIds: [], loginsPending: 0 });
		assert.equal(order.at(-1), "clerk deleted true", "the next run deletes the Clerk user");
		assert.equal(fs.existsSync(pendingFile), false, "the pending list is gone once empty");
	});

	it("endRetention puts a returning student back in service; a ready tenant is left as it is", async () => {
		const volume = path.join(work, "v3");
		const s = await fullStudent(volume);
		const retention = createRetention({ db: t.db, volumeDir: volume, log: () => {} });
		await dbm.markTenantReady(t.db, s.tenant.id);
		assert.equal((await retention.endRetention(s.tenant.id)).status, "ready");
		await retention.startRetention(s.tenant.id, ENDED);
		const back = await retention.endRetention(s.tenant.id);
		assert.equal(back.status, "ready");
		assert.equal(back.retentionEndsAt, null);
		await assert.rejects(retention.startRetention("not-a-uuid", ENDED), /tenant id/);
	});
});

describe("the job timer", () => {
	it("runs each job on runNow, never twice at once, and logs a failure without stopping", async () => {
		let runs = 0;
		let release: () => void = () => {};
		const logs: string[] = [];
		const jobs = startJobs(
			[
				{ name: "slow", run: () => new Promise<void>((r) => { runs += 1; release = r; }) },
				{ name: "broken", run: async () => { throw Object.assign(new Error("x"), { code: "EIO" }); } },
			],
			{ firstTickMs: 60_000, log: (l) => logs.push(l) },
		);
		const a = jobs.runNow();
		const b = jobs.runNow();
		await new Promise((r) => setImmediate(r));
		assert.equal(runs, 1, "a running job is not started again");
		release();
		await Promise.all([a, b]);
		assert.ok(logs.some((l) => l.includes("broken") && l.includes("EIO")));
		await jobs.stop();
	});
});

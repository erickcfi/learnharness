/**
 * The Owner's own account (2026-11-11). An account with the owner role:
 *  - passes the trial gate and the plan-ended screen with no subscription;
 *  - is never deleted or emptied by the day-91 job;
 *  - is still metered: model and search cost is recorded, and the $60 alert
 *    and the $89 autopause still apply.
 * Staff is not exempt. Each path is checked for an owner, a staff account
 * and a plain student, on the real migrations (PGlite) and the real gateway.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { accessFor, planAccessFor } from "../frontdoor/billing/access.ts";
import type { BillingViewOn } from "../frontdoor/billing/view.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { createMemoryMeteringStore } from "../frontdoor/metering/store.ts";
import { createSupabaseMeteringStore } from "../frontdoor/metering/supabase-store.ts";
import { createAccessReader, readTenantAccess } from "../frontdoor/pause/access.ts";
import { createTenantGate } from "../frontdoor/pause/gate.ts";
import { createCostWatch } from "../frontdoor/pause/limits.ts";
import { withPauseRules } from "../frontdoor/pause/meter.ts";
import { createRetention } from "../frontdoor/retention/lifecycle.ts";
import { tenantDir } from "../frontdoor/tenants/paths.ts";
import { provisionTenant } from "../frontdoor/tenants/provisioning.ts";
import { type Harness, startHarness, type Student } from "./frontdoor-billing-harness.ts";

type Kind = "owner" | "staff" | "student";
const KINDS: readonly Kind[] = ["owner", "staff", "student"];
const DAY = 24 * 60 * 60 * 1000;
const PAGE = { "sec-fetch-dest": "document", accept: "text/html" };

let h: Harness;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fd-owner-"));
before(async () => {
	h = await startHarness();
});
after(async () => {
	await h.close();
	fs.rmSync(work, { recursive: true, force: true });
});

/** A signed-up account with its tenant, holding the role for its kind (none for a student). */
async function account(kind: Kind, name: string): Promise<Student & { accountId: string }> {
	const s = await h.student(`${kind}-${name}`);
	const acc = await dbm.getAccountByClerkUserId(h.db, s.userId);
	assert.ok(acc);
	if (kind !== "student") await dbm.grantRole(h.db, { accountId: acc.id, role: kind });
	return { ...s, accountId: acc.id };
}

const turn = (s: Student) => h.request("/api/chat", { student: s, body: JSON.stringify({ chatId: "c1" }), headers: { "content-type": "application/json" } });

/** One request through the pause and plan-ended gate, reading access from the database. 299 means it passed. */
async function viaGate(tenantId: string, method: string, pathname: string, headers: Record<string, string> = {}) {
	const data = { exportZip: async () => ({ fileName: "export.zip", body: Buffer.from("zip") }), recordHtml: async () => "<!doctype html><p>record</p>" };
	const gate = createTenantGate({ access: createAccessReader({ db: h.db, ttlMs: 0 }), data, log: () => {} });
	const server = createServer((req, res) => {
		void gate
			.handle(req, res, { tenantId, userId: "user_gate", pathname, setCookie: [], signOut: () => res.writeHead(401).end() })
			.then((answered) => {
				if (!answered) res.writeHead(299).end("passed");
			});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	try {
		const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${pathname}`, { method, headers, redirect: "manual" });
		return { status: res.status, body: await res.text() };
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
	}
}

describe("the owner check reads the role from the database", () => {
	it("is true for an owner only, follows a grant and a revoke, and ignores staff", async () => {
		const owner = await account("owner", "check");
		const staff = await account("staff", "check");
		const student = await account("student", "check");
		assert.equal(await dbm.isOwnerTenant(h.db, owner.tenantId), true);
		assert.equal(await dbm.isOwnerTenant(h.db, staff.tenantId), false);
		assert.equal(await dbm.isOwnerTenant(h.db, student.tenantId), false);

		await dbm.grantRole(h.db, { accountId: staff.accountId, role: "owner" });
		assert.equal(await dbm.isOwnerTenant(h.db, staff.tenantId), true, "staff who is also the Owner counts as the Owner");
		await dbm.revokeRole(h.db, staff.accountId, "owner");
		assert.equal(await dbm.isOwnerTenant(h.db, staff.tenantId), false, "taking the role away ends the exemption");
		assert.equal(await dbm.isOwnerTenant(h.db, "00000000-0000-4000-8000-000000000000"), false, "no such tenant");
	});
});

describe("the trial gate with no subscription", () => {
	it("owner: tutor pages, New chat and new turns all reach the tutor", async () => {
		const s = await account("owner", "gate");
		const hits = h.tenantHits.length;
		const page = await h.request("/chat/abc", { student: s });
		assert.equal(page.status, 200);
		assert.equal(page.text, "from tenant");
		assert.equal((await h.request("/chat/new", { student: s })).status, 200);
		assert.equal((await turn(s)).status, 200);
		assert.equal((await h.request("/api/activity/abort", { student: s, method: "POST", body: "{}" })).status, 200, "an API write");
		assert.equal(h.tenantHits.length - hits, 4, "every request reached the tutor");

		const access = await accessFor(h.db, s.tenantId, new Date());
		assert.deepEqual(access, { state: "open", owner: true, subscription: null, tester: false, usage: null });
		assert.equal((await planAccessFor(h.db, s.tenantId, new Date())).state, "no-plan", "the plan itself is unchanged");
		const view = (await h.request("/account/billing/state", { student: s })).json<BillingViewOn>();
		assert.equal(view.status, "none", "the plans screen still shows the real plan");
	});

	for (const kind of ["staff", "student"] as const) {
		it(`${kind}: pages go to the plans screen and new turns get 402`, async () => {
			const s = await account(kind, "gate");
			const page = await h.request("/chat/abc", { student: s });
			assert.equal(page.status, 302);
			assert.equal(page.location, "/account/plans");
			const refused = await turn(s);
			assert.equal(refused.status, 402);
			assert.match(refused.text, /^Choose a plan to start studying/);
			assert.equal((await h.request("/api/activity/abort", { student: s, method: "POST", body: "{}" })).status, 402, "an API write");
			assert.equal((await accessFor(h.db, s.tenantId, new Date())).state, "no-plan");
		});
	}
});

describe("the plan-ended screen (retention)", () => {
	for (const kind of KINDS) {
		it(`${kind}: ${kind === "owner" ? "never sees it; the tutor and the meter stay open" : "sees it; turns and API calls are refused"}`, async () => {
			const s = await account(kind, "ended");
			await dbm.startRetention(h.db, s.tenantId, new Date(Date.now() - DAY));
			const access = await readTenantAccess(h.db, s.tenantId);
			const screen = await viaGate(s.tenantId, "GET", "/", PAGE);
			const api = await viaGate(s.tenantId, "GET", "/api/chats");
			const meter = withPauseRules(createMemoryMeteringStore(), { access: createAccessReader({ db: h.db, ttlMs: 0 }) });
			const billing = await accessFor(h.db, s.tenantId, new Date());
			if (kind === "owner") {
				assert.deepEqual(access, { state: "open" });
				assert.equal(screen.status, 299, "the page passes to the tutor");
				assert.equal(api.status, 299);
				assert.equal(await meter.isPaused(s.tenantId), false, "the meter does not refuse it");
				assert.equal(billing.state, "open");
				assert.equal((await turn(s)).status, 200);
			} else {
				assert.equal(access.state, "retention");
				assert.equal(screen.status, 200);
				assert.ok(screen.body.includes("Your plan has ended"), screen.body.slice(0, 200));
				assert.equal(api.status, 403);
				assert.equal(await meter.isPaused(s.tenantId), true);
				assert.equal(billing.state, "ended");
				assert.equal((await turn(s)).status, 402);
			}
		});
	}

	it("after the 90 days: the owner still exports and studies; staff and a student get 410", async () => {
		for (const kind of KINDS) {
			const s = await account(kind, "expired");
			await dbm.startRetention(h.db, s.tenantId, new Date(Date.now() - 100 * DAY));
			const access = await readTenantAccess(h.db, s.tenantId);
			const exported = await viaGate(s.tenantId, "GET", "/account/export");
			if (kind === "owner") {
				assert.deepEqual(access, { state: "open" });
				assert.equal(exported.status, 200);
				assert.equal((await viaGate(s.tenantId, "GET", "/", PAGE)).status, 299);
			} else {
				assert.equal(access.state === "retention" && access.expired, true, kind);
				assert.equal(exported.status, 410, kind);
			}
		}
	});
});

describe("the day-91 job", () => {
	it("deletes the staff and student tenants and keeps the Owner's, with its folder and rows", async () => {
		const volume = path.join(work, "day91");
		const ended = new Date("2026-01-05T00:00:00Z");
		const made = new Map<Kind, Student & { accountId: string }>();
		for (const kind of KINDS) {
			const s = await account(kind, "day91");
			provisionTenant({ volumeDir: volume, tenantId: s.tenantId });
			fs.mkdirSync(path.join(tenantDir(volume, s.tenantId), "chats"), { recursive: true });
			fs.writeFileSync(path.join(tenantDir(volume, s.tenantId), "chats", "chat_1.json"), "{}");
			await dbm.recordSearch(h.db, { tenantId: s.tenantId });
			await dbm.startRetention(h.db, s.tenantId, ended);
			made.set(kind, s);
		}
		const owner = made.get("owner")!;
		const logs: string[] = [];
		const retention = createRetention({ db: h.db, volumeDir: volume, now: () => new Date(ended.getTime() + 91 * DAY), log: (l) => logs.push(l) });

		const result = await retention.runDay91();
		assert.deepEqual(new Set(result.deletedIds), new Set([made.get("staff")!.tenantId, made.get("student")!.tenantId]));
		assert.equal(result.failed, 0);
		for (const kind of ["staff", "student"] as const) {
			const s = made.get(kind)!;
			assert.equal(await dbm.getTenant(h.db, s.tenantId), null, `${kind} tenant deleted`);
			assert.equal(fs.existsSync(tenantDir(volume, s.tenantId)), false, `${kind} folder deleted`);
		}
		assert.equal((await dbm.getTenant(h.db, owner.tenantId))?.status, "retention", "the Owner's tenant row stays");
		assert.ok(await dbm.getAccountByClerkUserId(h.db, owner.userId), "the Owner's account stays");
		assert.ok(fs.existsSync(path.join(tenantDir(volume, owner.tenantId), "chats", "chat_1.json")), "the Owner's folder is not emptied");
		assert.equal((await h.db.query("select 1 from search_usage where tenant_id = $1", [owner.tenantId])).length, 1, "the Owner's usage rows stay");
		assert.ok(logs.includes(`day-91: tenant ${owner.tenantId} belongs to the Owner; kept`), logs.join("\n"));

		const again = await retention.runDay91();
		assert.deepEqual(again.deletedIds, [], "the next run keeps it too");
		assert.ok(await dbm.getTenant(h.db, owner.tenantId));
	});
});

describe("metering still applies", () => {
	for (const kind of KINDS) {
		it(`${kind}: model and search cost is recorded, $60 opens the cost alert and $89 pauses`, async () => {
			const s = await account(kind, "meter");
			const watch = createCostWatch({ db: h.db, log: () => {} });
			const meter = withPauseRules(createSupabaseMeteringStore(h.db, { log: () => {} }), { watch, access: createAccessReader({ db: h.db, ttlMs: 0 }) });
			const call = (dollars: number, n: number) =>
				meter.recordCall({ tenantId: s.tenantId, at: new Date(), model: "claude-opus-5-5", dollars, requestId: `req_${kind}_meter_${n}`, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 });

			await call(61, 1);
			await meter.recordSearch({ tenantId: s.tenantId, at: new Date() });
			await watch.idle();
			assert.equal((await h.db.query("select 1 from model_usage where tenant_id = $1", [s.tenantId])).length, 1, "model call recorded");
			assert.equal((await h.db.query("select 1 from search_usage where tenant_id = $1", [s.tenantId])).length, 1, "search recorded");
			const alerts = () => h.db.query<{ kind: string }>("select kind from alerts where tenant_id = $1 order by id", [s.tenantId]);
			assert.deepEqual((await alerts()).map((a) => a.kind), ["cost_alert"], "the $60 alert");
			assert.equal(await meter.isPaused(s.tenantId), false);

			await call(28, 2);
			await watch.idle();
			assert.deepEqual((await alerts()).map((a) => a.kind), ["cost_alert", "autopause"], "the $89 autopause");
			assert.equal(await dbm.isPaused(h.db, s.tenantId), true);
			assert.equal(await meter.isPaused(s.tenantId), true, "the meter refuses the next call");
			assert.equal((await readTenantAccess(h.db, s.tenantId)).state, "paused");
			const screen = await viaGate(s.tenantId, "GET", "/", PAGE);
			assert.ok(screen.body.includes("Your tutor is paused"), "the pause screen shows");
		});
	}
});

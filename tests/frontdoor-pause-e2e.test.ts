/**
 * P2-05 and P1-08 end to end, through the whole wired front door (database
 * on PGlite with the real migrations, the meter, a fake Anthropic, a
 * stand-in tenant server). C3 acceptance test: crossing the alert
 * threshold creates one alert, crossing the autopause threshold pauses the
 * tenant, a paused tenant's turn is refused, and unpausing restores access
 * (and holds, as decided). C1 req 6: a plan that ended keeps the data for
 * export, then the day-91 job deletes it.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import type { ClerkAuthResult } from "../frontdoor/gateway/auth.ts";
import { AGE_COOKIE, SESSION_COOKIE } from "../frontdoor/gateway/session.ts";
import { makePassKey } from "../frontdoor/metering/pass-key.ts";
import { listPrice } from "../frontdoor/metering/price.ts";
import { PAUSED_MESSAGE as METER_PAUSED_MESSAGE } from "../frontdoor/metering/proxy.ts";
import { API_MESSAGES, PAUSED_MESSAGE } from "../frontdoor/pause/copy.ts";
import { RECORD_LABEL } from "../frontdoor/records/index.ts";
import { tenantDir } from "../frontdoor/tenants/paths.ts";
import { blockExternalFetch, REAL_ANTHROPIC_KEY, startFakeAnthropic, type FakeAnthropic } from "./frontdoor-metering-fakes.ts";
import { readZip } from "./frontdoor-retention-helpers.ts";

blockExternalFetch();

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fd-pause-e2e-"));
const volume = path.join(work, "volume");
const PASS_KEY_SECRET = "pause-e2e-pass-key-secret-0123456789abcdef";
const ENV: Record<string, string> = {
	NODE_ENV: "test",
	PATH: process.env.PATH ?? "",
	FRONTDOOR_SESSION_SECRET: "pause-e2e-session-secret-0123456789abcdefgh",
	CLERK_SECRET_KEY: "sk_test_pause_e2e",
	NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_pause_e2e",
	FRONTDOOR_PASS_KEY_SECRET: PASS_KEY_SECRET,
	ANTHROPIC_API_KEY: REAL_ANTHROPIC_KEY,
	SUPABASE_DB_URL: "postgres://u:p@127.0.0.1:9/never_dialed",
	FRONTDOOR_VOLUME: volume,
	FRONTDOOR_TENANT_SERVER: path.join(import.meta.dirname, "frontdoor-pause-tenant.ts"),
	FRONTDOOR_LISTEN_HOST: "127.0.0.1",
	PORT: "0",
};
const MODEL = "claude-opus-5-5";
const USAGE = { input: 100_000, output: 20_000 };
const CALL_USD = listPrice(MODEL, { inputTokens: USAGE.input, outputTokens: USAGE.output, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 }) as number;
const cents = (usd: number) => Math.ceil(usd * 100) / 100;
const DAY = 24 * 60 * 60 * 1000;

let t: TestDb;
let anthropic: FakeAnthropic;
let frontDoor: Awaited<ReturnType<typeof import("../frontdoor/wiring/front-door.ts").startFrontDoor>>;
let clerkResult: ClerkAuthResult = { status: "signed-out" };
const logs: string[] = [];

before(async () => {
	assert.ok(CALL_USD > 0.1, `one fake call should cost something (got ${CALL_USD})`);
	t = await createTestDb();
	anthropic = await startFakeAnthropic(() => ({ usage: USAGE, text: "Paused?" }));
	const { startFrontDoor } = await import("../frontdoor/wiring/front-door.ts");
	frontDoor = await startFrontDoor({
		env: ENV,
		frontDoorApp: (_req, res) => res.end("front door page"),
		clerk: { authenticate: async () => clerkResult, isSessionActive: async () => true },
		db: t.db,
		upstream: { anthropicBaseUrl: anthropic.url },
		log: (line) => logs.push(line),
	});
	// Thresholds the fake calls cross: 1 call is under the alert, 2 reach it, 3 reach autopause.
	await dbm.updateOwnerSettings(t.db, { alertUsd: cents(CALL_USD * 1.5), autopauseUsd: cents(CALL_USD * 2.5) });
});

after(async () => {
	await frontDoor?.close();
	await anthropic?.close();
	await t?.close();
	fs.rmSync(work, { recursive: true, force: true });
});

const cookieValue = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0];

async function signIn(userId: string): Promise<string> {
	const age = await fetch(`${frontDoor.url}/account/age`, {
		method: "POST",
		redirect: "manual",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: "over18=yes&next=%2Faccount%2Fsign-up",
	});
	clerkResult = { status: "signed-in", userId, sessionId: `sess_${userId}` };
	const start = await fetch(`${frontDoor.url}/account/start`, { redirect: "manual", headers: { Cookie: cookieValue(age, AGE_COOKIE) ?? "" } });
	assert.equal(start.status, 302, logs.join(" | "));
	return cookieValue(start, SESSION_COOKIE) ?? "";
}

const page = (cookie: string, pathname: string, extra: Record<string, string> = {}) =>
	fetch(`${frontDoor.url}${pathname}`, { redirect: "manual", headers: { Cookie: cookie, Accept: "text/html,application/xhtml+xml", "Sec-Fetch-Dest": "document", ...extra } });
const api = (cookie: string, pathname: string, method = "GET") => fetch(`${frontDoor.url}${pathname}`, { method, redirect: "manual", headers: { Cookie: cookie, Accept: "application/json" } });

async function turn(cookie: string): Promise<{ status: number; body: string }> {
	const res = await api(cookie, "/api/wiring/raw-call", "POST");
	assert.equal(res.status, 200, await res.clone().text());
	const result = (await res.json()) as { status: number; body: string };
	await frontDoor.dataSafety!.watch.idle();
	return result;
}

describe("pause and data safety, end to end", () => {
	let cookie = "";
	let tenantId = "";
	let ownerId = "";

	it("signs a student in", async () => {
		cookie = await signIn("user_pause_e2e");
		const tenant = await dbm.getTenantByClerkUserId(t.db, "user_pause_e2e");
		assert.ok(tenant);
		tenantId = tenant.id;
		const owner = await dbm.createAccount(t.db, { clerkUserId: "owner_pause_e2e", age18ConfirmedAt: new Date() });
		await dbm.grantRole(t.db, { accountId: owner.id, role: "owner" });
		ownerId = owner.id;
		assert.ok(frontDoor.dataSafety, "with a database, the front door has the W2-7 services");
	});

	it("an alert at the alert threshold, autopause at the autopause threshold (C3 req 5)", async () => {
		assert.equal((await turn(cookie)).status, 200);
		assert.equal((await dbm.listAlerts(t.db, tenantId)).length, 0, "one call is under the alert");

		assert.equal((await turn(cookie)).status, 200);
		const alerts = await dbm.listAlerts(t.db, tenantId);
		assert.deepEqual(alerts.map((a) => a.kind), ["cost_alert"]);
		assert.equal(await dbm.isPaused(t.db, tenantId), false);

		assert.equal((await turn(cookie)).status, 200, "the call that crosses autopause still completes");
		assert.equal(await dbm.isPaused(t.db, tenantId), true);
		assert.equal((await dbm.getOpenPause(t.db, tenantId))?.reason, "autopause");
		assert.deepEqual((await dbm.listAlerts(t.db, tenantId)).map((a) => a.kind).sort(), ["autopause", "cost_alert"]);
		assert.ok(logs.some((l) => l.startsWith("alert: autopause for tenant") && l.includes(tenantId)));
	});

	it("the meter refuses the paused tenant's next turn with the pause message (C3 req 6)", async () => {
		const before = anthropic.received.length;
		const refused = await turn(cookie);
		assert.equal(refused.status, 403);
		assert.equal((JSON.parse(refused.body) as { error: { message: string } }).error.message, METER_PAUSED_MESSAGE);
		assert.equal(anthropic.received.length, before, "nothing reached Anthropic");
		assert.equal(PAUSED_MESSAGE, METER_PAUSED_MESSAGE, "the screen and the meter say the same thing");
	});

	it("the student sees the pause screen instead of the tutor, and can still read, export and print (D16)", async () => {
		for (const pathname of ["/", "/chat/chat_a1"]) {
			const res = await page(cookie, pathname);
			assert.equal(res.status, 200);
			const html = await res.text();
			assert.ok(html.includes("Your tutor is paused"), pathname);
			assert.ok(html.includes(PAUSED_MESSAGE));
			assert.ok(html.includes("info@flynorthaero.com"));
			assert.ok(html.includes('href="/account/export"') && html.includes('href="/account/record"'));
			assert.ok(!html.includes("tutor page"));
			assert.ok(!/clerk/i.test(html), "no Clerk script on the pause screen");
		}
		const rsc = await fetch(`${frontDoor.url}/chat/chat_a1`, { headers: { Cookie: cookie, RSC: "1", Accept: "text/x-component" } });
		assert.ok((await rsc.text()).includes("Your tutor is paused"), "a client-side navigation gets the screen too");

		const read = await api(cookie, "/api/chats");
		assert.equal(read.status, 200, "an open tab can still read its chats");

		const zip = await fetch(`${frontDoor.url}/account/export?tz=America/Denver`, { headers: { Cookie: cookie } });
		assert.equal(zip.status, 200);
		assert.equal(zip.headers.get("content-type"), "application/zip");
		assert.match(zip.headers.get("content-disposition") ?? "", /attachment; filename="ground-tutor-data-\d{4}-\d{2}-\d{2}\.zip"/);
		const files = readZip(Buffer.from(await zip.arrayBuffer()));
		assert.ok(files.has("README.txt") && files.has("study-record.html") && files.has("knowledge-graph.json") && files.has("imported-notes.json"));
		assert.equal([...files.keys()].filter((n) => n.startsWith("sessions/")).length, 2);

		const record = await fetch(`${frontDoor.url}/account/record`, { headers: { Cookie: cookie } });
		assert.equal(record.status, 200);
		assert.ok((await record.text()).includes(RECORD_LABEL));

		const signedOut = await fetch(`${frontDoor.url}/account/export`, { redirect: "manual", headers: { Accept: "text/html" } });
		assert.equal(signedOut.status, 302, "the export needs the login");
		assert.match(signedOut.headers.get("location") ?? "", /^\/account\/sign-in\?next=%2Faccount%2Fexport/);
		assert.ok(logs.every((l) => !l.includes("METAR") && !l.includes("@")), "no session text or email in the logs");
	});

	it("unpausing lets calls through at once, and the unpause holds (master decision)", async () => {
		assert.equal(await frontDoor.dataSafety!.controls.unpauseTenant(tenantId, ownerId), true);
		const res = await page(cookie, "/chat/chat_a1");
		assert.ok((await res.text()).includes("tutor page"), "the tutor is back");

		assert.equal((await turn(cookie)).status, 200, "the next call passes");
		assert.equal(await dbm.isPaused(t.db, tenantId), false, "still over the threshold in 30 days, but not paused again");
		assert.equal((await turn(cookie)).status, 200);
		assert.equal((await turn(cookie)).status, 200, "the call that reaches a fresh autopause amount completes");
		assert.equal(await dbm.isPaused(t.db, tenantId), true, "a fresh autopause amount after the unpause pauses again");
		await frontDoor.dataSafety!.controls.unpauseTenant(tenantId, ownerId);
	});

	it("after the plan ends: the plan-ended screen, no tutor writes or model calls, export still works (C1 req 6)", async () => {
		const retention = frontDoor.dataSafety!.retention();
		const endedAt = new Date(Date.now() - DAY);
		const tenant = await retention.startRetention(tenantId, endedAt);

		const screen = await page(cookie, "/");
		const html = await screen.text();
		assert.ok(html.includes("Your plan has ended"));
		assert.ok(html.includes("We keep your data until"));
		assert.ok(html.includes('href="/account/export"'));

		for (const [pathname, method] of [["/api/chats", "POST"], ["/api/chats", "GET"]] as const) {
			const res = await api(cookie, pathname, method);
			assert.equal(res.status, 403, `${method} ${pathname}`);
			assert.deepEqual(await res.json(), { error: API_MESSAGES.retention });
		}

		// The tenant's own server cannot spend either: the meter refuses its pass key.
		const meterCall = await fetch(`${frontDoor.meterUrl}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": makePassKey(PASS_KEY_SECRET, tenantId), "anthropic-version": "2023-06-01" },
			body: JSON.stringify({ model: MODEL, max_tokens: 8, messages: [{ role: "user", content: "x" }] }),
		});
		assert.equal(meterCall.status, 403);

		const zip = await fetch(`${frontDoor.url}/account/export`, { headers: { Cookie: cookie } });
		assert.equal(zip.status, 200, "exports during retention");
		assert.ok(readZip(Buffer.from(await zip.arrayBuffer())).has("README.txt"));
		assert.ok(tenant.retentionEndsAt && tenant.retentionEndsAt.getTime() > Date.now());
	});

	it("on day 91 the job deletes the tenant, and the student is signed out", async () => {
		const retention = frontDoor.dataSafety!.retention();
		await retention.startRetention(tenantId, new Date(Date.now() - 91 * DAY));
		const expired = await fetch(`${frontDoor.url}/account/export`, { headers: { Cookie: cookie } });
		assert.equal(expired.status, 410, "no export once the 90 days are over");
		assert.ok((await (await page(cookie, "/")).text()).includes("being deleted"));

		const result = await retention.runDay91();
		assert.deepEqual(result.deletedIds, [tenantId]);
		assert.equal(fs.existsSync(tenantDir(volume, tenantId)), false);
		assert.equal(await dbm.getTenant(t.db, tenantId), null);

		const gonePage = await page(cookie, "/");
		assert.equal(gonePage.status, 302);
		assert.match(gonePage.headers.get("location") ?? "", /^\/account\/sign-in/);
		assert.match(cookieValue(gonePage, SESSION_COOKIE) ?? "x", /^fd_session=$/, "the login cookie is cleared");
		assert.equal((await api(cookie, "/api/chats")).status, 401);
		assert.equal(fs.existsSync(tenantDir(volume, tenantId)), false, "nothing started the deleted tenant's server again");
	});
});

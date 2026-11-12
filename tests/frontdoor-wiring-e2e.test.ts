/**
 * The whole front door, wired (W1-6; PRD section 8 "security set", C1, C3,
 * C5). One test run starts the front door the way server.ts does, with
 * every Wave 1 piece plugged in:
 *  - the database (PGlite with the real migrations) behind the accounts and
 *    the meter;
 *  - lockdown: production safety, the log filter in each tenant, the
 *    library-only File access in settings.json, LH_LIBRARY_DIR;
 *  - metering: the meter on 127.0.0.1, each tenant's pass key, a fake
 *    Anthropic and a fake Tavily on 127.0.0.1.
 * Only Clerk and the front door's own Next.js pages are stand-ins. The
 * tenant server is a stand-in too (tests/frontdoor-wiring-tenant.ts), but
 * its model call and search run upstream's own code.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import * as dbm from "../frontdoor/db/index.ts";
import type { ClerkAuthResult } from "../frontdoor/gateway/auth.ts";
import { AGE_COOKIE, SESSION_COOKIE } from "../frontdoor/gateway/session.ts";
import { makePassKey } from "../frontdoor/metering/pass-key.ts";
import { applyFileAccessTemplate, libraryDir } from "../frontdoor/settings-template/file-access.ts";
import { tenantDir } from "../frontdoor/tenants/paths.ts";
import { blockExternalFetch, REAL_ANTHROPIC_KEY, REAL_TAVILY_KEY, startFakeAnthropic, startFakeTavily, type FakeAnthropic, type FakeServer } from "./frontdoor-metering-fakes.ts";

blockExternalFetch();

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fd-wiring-e2e-"));
const volume = path.join(work, "volume");
const TENANT_SCRIPT = path.join(import.meta.dirname, "frontdoor-wiring-tenant.ts");

const PASS_KEY_SECRET = "e2e-pass-key-secret-0123456789abcdefghijkl";
const SESSION_SECRET = "e2e-session-secret-0123456789abcdefghijklm";
const CLERK_SECRET = "sk_test_e2e_clerk_secret_must_not_leak";
const SUPABASE_URL = "postgres://e2e-user:e2e-password-must-not-leak@127.0.0.1:9/never_dialed";
const STRIPE_SECRET = "sk_test_e2e_stripe_must_not_leak";

/** The front door's environment, as Railway would give it. */
const ENV: Record<string, string> = {
	NODE_ENV: "test",
	PATH: process.env.PATH ?? "",
	FRONTDOOR_SESSION_SECRET: SESSION_SECRET,
	CLERK_SECRET_KEY: CLERK_SECRET,
	NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_e2e",
	FRONTDOOR_PASS_KEY_SECRET: PASS_KEY_SECRET,
	ANTHROPIC_API_KEY: REAL_ANTHROPIC_KEY,
	TAVILY_API_KEY: REAL_TAVILY_KEY,
	SUPABASE_DB_URL: SUPABASE_URL,
	STRIPE_SECRET_KEY: STRIPE_SECRET,
	FRONTDOOR_VOLUME: volume,
	FRONTDOOR_TENANT_SERVER: TENANT_SCRIPT,
	FRONTDOOR_LISTEN_HOST: "127.0.0.1",
	PORT: "0",
};
/** No value of these may reach a tenant server. */
const SECRET_VALUES = [PASS_KEY_SECRET, SESSION_SECRET, CLERK_SECRET, SUPABASE_URL, STRIPE_SECRET, REAL_ANTHROPIC_KEY, REAL_TAVILY_KEY];
const SECRET_NAMES = ["FRONTDOOR_PASS_KEY_SECRET", "FRONTDOOR_SESSION_SECRET", "CLERK_SECRET_KEY", "SUPABASE_DB_URL", "STRIPE_SECRET_KEY"];

const USAGE = { input: 1200, output: 340, cacheRead: 500, cacheWrite: 100, cacheWrite1h: 40 };

let t: TestDb;
let anthropic: FakeAnthropic;
let tavily: FakeServer;
let frontDoor: Awaited<ReturnType<typeof import("../frontdoor/wiring/front-door.ts").startFrontDoor>>;
let clerkResult: ClerkAuthResult = { status: "signed-out" };
const logs: string[] = [];

before(async () => {
	t = await createTestDb();
	anthropic = await startFakeAnthropic(() => ({ usage: USAGE, text: "Wired." }));
	tavily = await startFakeTavily();
	const { startFrontDoor } = await import("../frontdoor/wiring/front-door.ts");
	frontDoor = await startFrontDoor({
		env: ENV,
		frontDoorApp: (_req, res) => res.end("front door page"),
		clerk: { authenticate: async () => clerkResult, isSessionActive: async () => true },
		db: t.db,
		upstream: { anthropicBaseUrl: anthropic.url, tavilyBaseUrl: tavily.url },
		// W2-6: the stand-in tenant's own routes are not upstream's, so the
		// route table must be told about them (an unlisted /api path gets 403).
		extraTestRoutes: [{ path: "/api/wiring/[action]", methods: ["POST"], access: "allowed", reason: "Test stand-in only." }],
		log: (line) => logs.push(line),
	});
});

after(async () => {
	await frontDoor?.close();
	await anthropic?.close();
	await tavily?.close();
	await t?.close();
	fs.rmSync(work, { recursive: true, force: true });
});

const cookieValue = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0];

/** The whole sign-in: the 18+ box, then Clerk's return to /account/start. */
async function signIn(userId: string, sessionId: string): Promise<string> {
	const age = await fetch(`${frontDoor.url}/account/age`, {
		method: "POST",
		redirect: "manual",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: "over18=yes&next=%2Faccount%2Fsign-up",
	});
	assert.equal(age.status, 303);
	const ageCookie = cookieValue(age, AGE_COOKIE);
	assert.ok(ageCookie, "the 18+ tick is saved in its cookie");

	clerkResult = { status: "signed-in", userId, sessionId };
	const start = await fetch(`${frontDoor.url}/account/start`, { redirect: "manual", headers: { Cookie: ageCookie } });
	assert.equal(start.status, 302, `sign-in finished (logs: ${logs.join(" | ")})`);
	const session = cookieValue(start, SESSION_COOKIE);
	assert.ok(session, "the front door's login cookie is set");
	return session;
}

async function tenantGet<T>(cookie: string, pathname: string): Promise<T> {
	const res = await fetch(`${frontDoor.url}${pathname}`, { headers: { Cookie: cookie } });
	assert.equal(res.status, 200);
	return (await res.json()) as T;
}

async function tenantPost<T>(cookie: string, pathname: string): Promise<T> {
	const res = await fetch(`${frontDoor.url}${pathname}`, { method: "POST", headers: { Cookie: cookie } });
	assert.equal(res.status, 200, await res.clone().text());
	return (await res.json()) as T;
}

async function waitFor<T>(read: () => Promise<T | null>, label: string, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value !== null) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

interface TenantEnv {
	pid: number;
	env: Record<string, string>;
	logFilter: boolean;
}

describe("the wired front door", () => {
	let alice = { cookie: "", tenantId: "" };

	it("a first login provisions a tenant in the database, with library-only file access", async () => {
		alice.cookie = await signIn("user_alice", "sess_alice_1");
		const tenant = await dbm.getTenantByClerkUserId(t.db, "user_alice");
		assert.ok(tenant, "the database made the tenant");
		alice.tenantId = tenant.id;
		assert.equal(tenant.status, "ready", "markTenantReady ran after provisioning");

		const settings = JSON.parse(fs.readFileSync(path.join(tenantDir(volume, tenant.id), "settings.json"), "utf8")) as { agent?: { fileAccess?: unknown } };
		const expected = applyFileAccessTemplate({}, libraryDir(volume)) as { agent: { fileAccess: unknown } };
		assert.deepEqual(settings.agent?.fileAccess, expected.agent.fileAccess);
		assert.deepEqual(settings.agent?.fileAccess, { restricted: true, folders: [path.join(volume, "library")] });
		assert.ok(fs.statSync(libraryDir(volume)).isDirectory(), "the library folder exists");
	});

	it("the tenant's server gets the library path, its pass key and the log filter, and no front door secret", async () => {
		const { env, logFilter } = await tenantGet<TenantEnv>(alice.cookie, "/env");
		assert.equal(env.LH_LIBRARY_DIR, libraryDir(volume));
		const passKey = makePassKey(PASS_KEY_SECRET, alice.tenantId);
		assert.equal(env.ANTHROPIC_API_KEY, passKey);
		assert.equal(env.TAVILY_API_KEY, passKey);
		assert.match(env.LH_ANTHROPIC_BASE_URL ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
		assert.equal(env.LH_TAVILY_BASE_URL, `${env.LH_ANTHROPIC_BASE_URL}/tavily`);
		assert.equal(env.ANTHROPIC_AUTH_TOKEN, "");
		assert.equal(logFilter, true, "the tenant runs with the log filter loaded");
		assert.equal(env.LH_LOG_MARK, undefined, "the log filter read its line mark at start and removed it");
		for (const name of SECRET_NAMES) assert.equal(env[name], undefined, `${name} must not reach a tenant`);
		const values = Object.values(env);
		for (const secret of SECRET_VALUES) assert.ok(!values.some((v) => v.includes(secret)), "no secret value reaches a tenant");
	});

	it("the tenant's errors reach the front door's log filtered, and its routine output does not", async () => {
		await tenantPost(alice.cookie, "/api/wiring/print");
		const prefix = `[tenant ${alice.tenantId}] `;
		const frame = `${prefix}    at print (/app/tenant.js:60:17)`;
		await waitFor(async () => (logs.includes(frame) ? true : null), "the tenant's error lines");
		const lines = logs.filter((l) => l.startsWith(prefix));
		// The texts tests/frontdoor-wiring-tenant.ts prints, for their lengths.
		const message = "Explain the METAR for KSFO to pilot@example.com";
		const rawLine = 'Error: tenant failure for pilot@example.com: "Explain the METAR for KSFO"';
		// Through the tenant's log filter: the code's own text, the error's type, its message hidden.
		assert.ok(lines.includes(`${prefix}[wiring] tenant failure: Error: [message hidden, ${message.length} chars]`), lines.join("\n"));
		// Straight to stderr, past the filter: a line of text is hidden, a stack frame passes.
		assert.ok(lines.includes(`${prefix}[line hidden, ${rawLine.length} chars]`), lines.join("\n"));
		assert.ok(!logs.some((l) => l.includes("pilot@example.com") || l.includes("Explain the METAR") || l.includes("tenant failure for")), "no email or session text");
		assert.ok(!logs.some((l) => l.includes("stdout routine line")), "stdout is dropped");
	});

	it("a model call from the tenant goes through the meter and lands as a usage row for that tenant", async () => {
		const before = anthropic.received.length;
		const result = await tenantPost<{ stopReason: string; errorMessage?: string }>(alice.cookie, "/api/wiring/call");
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(anthropic.received.length, before + 1);
		assert.equal(anthropic.received.at(-1)?.headers["x-api-key"], REAL_ANTHROPIC_KEY, "the meter swapped in the real key");

		const rows = await waitFor(async () => {
			const usage = await dbm.listModelUsage(t.db, alice.tenantId);
			return usage.length > 0 ? usage : null;
		}, "the usage row");
		assert.equal(rows.length, 1);
		const row = rows[0];
		assert.ok(row);
		assert.equal(row.model, "claude-opus-5-5");
		assert.equal(row.inputTokens, USAGE.input);
		assert.equal(row.outputTokens, USAGE.output);
		assert.equal(row.cacheReadTokens, USAGE.cacheRead);
		assert.equal(row.cacheWriteTokens, USAGE.cacheWrite);
		assert.equal(row.cacheWrite1hTokens, USAGE.cacheWrite1h);
		assert.ok(row.costUsd !== null && row.costUsd > 0, "priced at list price");
	});

	it("a search from the tenant is counted for that tenant", async () => {
		const result = await tenantPost<{ hits: unknown[] }>(alice.cookie, "/api/wiring/search");
		assert.equal(result.hits.length, 1);
		assert.equal(tavily.received.at(-1)?.headers.authorization, `Bearer ${REAL_TAVILY_KEY}`);
		await waitFor(async () => ((await dbm.searchUsageSince(t.db, alice.tenantId, new Date(0))).count === 1 ? true : null), "the search row");
	});

	it("each tenant's calls land on its own rows", async () => {
		const bobCookie = await signIn("user_bob", "sess_bob_1");
		const bob = await dbm.getTenantByClerkUserId(t.db, "user_bob");
		assert.ok(bob);
		assert.notEqual(bob.id, alice.tenantId);
		const result = await tenantPost<{ stopReason: string; errorMessage?: string }>(bobCookie, "/api/wiring/call");
		assert.equal(result.stopReason, "stop", result.errorMessage);
		await waitFor(async () => ((await dbm.listModelUsage(t.db, bob.id)).length === 1 ? true : null), "bob's usage row");
		assert.equal((await dbm.listModelUsage(t.db, alice.tenantId)).length, 1, "alice's rows are unchanged");
	});

	it("a paused tenant is refused with the pause notice, and unpausing restores access", async () => {
		await dbm.pauseTenant(t.db, { tenantId: alice.tenantId, reason: "owner" });
		const refused = await tenantPost<{ status: number; body: string }>(alice.cookie, "/api/wiring/raw-call");
		assert.equal(refused.status, 403);
		assert.match(refused.body, /paused for a fair-use review/);

		await dbm.unpauseTenant(t.db, { tenantId: alice.tenantId });
		const allowed = await tenantPost<{ status: number; body: string }>(alice.cookie, "/api/wiring/raw-call");
		assert.equal(allowed.status, 200, allowed.body);
	});

	it("a second login reuses the same tenant and its running server", async () => {
		const first = await tenantGet<TenantEnv>(alice.cookie, "/env");
		const cookie = await signIn("user_alice", "sess_alice_2");
		const again = await dbm.getTenantByClerkUserId(t.db, "user_alice");
		assert.equal(again?.id, alice.tenantId);
		const second = await tenantGet<TenantEnv>(cookie, "/env");
		assert.equal(second.pid, first.pid, "the same tenant server");
		const rows = await t.db.query("select t.id from tenants t join accounts a on a.id = t.account_id where a.clerk_user_id = $1", ["user_alice"]);
		assert.equal(rows.length, 1, "one tenant row");
	});
});

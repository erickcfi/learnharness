/**
 * The C1 isolation suite (W2-6, card P1-05; PRD C1 acceptance tests, C3
 * requirements 1 to 3). Two real tenant processes behind the real front door:
 * startFrontDoor() with its supervisor, meter, route table and settings
 * template, PGlite for the database, fakes for Clerk, Anthropic and Tavily.
 * Each tenant runs upstream's own route handlers and proxy.ts against its own
 * data folder (tests/helpers/frontdoor-isolation-tenant.ts).
 *
 *  - Wall A: a tenant server refuses any request, on any path, without its
 *    own secret; another tenant's secret does not open it.
 *  - Every route in app/api: student A, asking with student B's ids, gets
 *    nothing of B's and changes nothing of B's. Streams too.
 *  - Agent tools run inside tenant A cannot reach tenant B, the meter or the
 *    metadata address (wall B), and its file tools cannot read B's folder.
 *  - A background job A starts writes only inside A's folder, and its model
 *    cost lands on A.
 *  - The model lock: the routes are refused, new sessions take the Owner's
 *    model, the UI's agent writes pass, and a drifted settings.json is put
 *    back at the next start.
 *  - Without a login, every route gets 401.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import type { ClerkAuthResult } from "../frontdoor/gateway/auth.ts";
import { STUDENT_ROUTES } from "../frontdoor/gateway/route-policy.ts";
import { AGE_COOKIE, SESSION_COOKIE } from "../frontdoor/gateway/session.ts";
import { BLOCKED_ADDRESS_MESSAGE } from "../frontdoor/isolation/safe-fetch.ts";
import { fileAccessTemplate, libraryDir } from "../frontdoor/settings-template/file-access.ts";
import { tenantAuthFile, tenantDir } from "../frontdoor/tenants/paths.ts";
import { OWNER_MODELS } from "../frontdoor/tenants/settings-template.ts";
import type { TenantEndpoint } from "../frontdoor/tenants/supervisor.ts";
import { blockExternalFetch, REAL_ANTHROPIC_KEY, REAL_TAVILY_KEY, startFakeAnthropic, startFakeTavily, type FakeAnthropic, type FakeServer } from "./frontdoor-metering-fakes.ts";

blockExternalFetch();

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fd-isolation-"));
const volume = path.join(work, "volume");
const HARNESS = path.join(import.meta.dirname, "helpers", "frontdoor-isolation-tenant.ts");
const BOB_TOPIC = "BRAVO-ONLY-TOPIC";

const ENV: Record<string, string> = {
	NODE_ENV: "test",
	PATH: process.env.PATH ?? "",
	FRONTDOOR_SESSION_SECRET: "isolation-session-secret-0123456789abcdefghij",
	CLERK_SECRET_KEY: "sk_test_isolation_clerk",
	NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_isolation",
	FRONTDOOR_PASS_KEY_SECRET: "isolation-pass-key-secret-0123456789abcdefgh",
	ANTHROPIC_API_KEY: REAL_ANTHROPIC_KEY,
	TAVILY_API_KEY: REAL_TAVILY_KEY,
	FRONTDOOR_VOLUME: volume,
	FRONTDOOR_TENANT_SERVER: HARNESS,
	FRONTDOOR_LISTEN_HOST: "127.0.0.1",
	PORT: "0",
};

let t: TestDb;
let anthropic: FakeAnthropic;
let tavily: FakeServer;
let frontDoor: Awaited<ReturnType<typeof import("../frontdoor/wiring/front-door.ts").startFrontDoor>>;
let clerkResult: ClerkAuthResult = { status: "signed-out" };
const logs: string[] = [];

interface Student {
	cookie: string;
	tenantId: string;
	dir: string;
}
const alice = {} as Student;
const bob = {} as Student;
let bobChatId = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cookieValue = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0];

async function signIn(userId: string): Promise<Student> {
	const age = await fetch(`${frontDoor.url}/account/age`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "over18=yes&next=%2Faccount%2Fsign-up" });
	const ageCookie = cookieValue(age, AGE_COOKIE) ?? "";
	clerkResult = { status: "signed-in", userId, sessionId: `sess_${userId}` };
	const start = await fetch(`${frontDoor.url}/account/start`, { redirect: "manual", headers: { Cookie: ageCookie } });
	assert.equal(start.status, 302, `sign-in finished (logs: ${logs.join(" | ")})`);
	const cookie = cookieValue(start, SESSION_COOKIE) ?? "";
	const tenant = await dbm.getTenantByClerkUserId(t.db, userId);
	assert.ok(tenant);
	return { cookie, tenantId: tenant.id, dir: tenantDir(volume, tenant.id) };
}

/** Reads what arrives within `ms`, then lets go (streams never end on their own). */
async function readSome(res: Response, ms = 1500): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + ms;
	try {
		for (;;) {
			const left = deadline - Date.now();
			if (left <= 0) break;
			const chunk = await Promise.race([reader.read(), sleep(left).then(() => null)]);
			if (!chunk || chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return text;
}

const viaFrontDoor = (student: Student, pathname: string, init: RequestInit = {}) =>
	fetch(`${frontDoor.url}${pathname}`, { redirect: "manual", ...init, headers: { Cookie: student.cookie, ...(init.headers as Record<string, string> | undefined) } });

const direct = (endpoint: TenantEndpoint, pathname: string, init: RequestInit = {}, headers: Record<string, string> = endpoint.headers) =>
	fetch(`${endpoint.url}${pathname}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });

async function harnessState(student: Student): Promise<{ hits: number; pid: number; hosted: string; tmpdir: string; secretLength: number }> {
	const ep = await frontDoor.tenantEndpoint(student.tenantId);
	return (await (await direct(ep, "/__harness/state")).json()) as never;
}

async function runTool(student: Student, tool: string, input: Record<string, unknown>): Promise<string> {
	const ep = await frontDoor.tenantEndpoint(student.tenantId);
	const res = await direct(ep, "/__harness/tool", { method: "POST", body: JSON.stringify({ tool, input }), headers: { "Content-Type": "application/json" } });
	return ((await res.json()) as { output: string }).output;
}

function snapshot(root: string, skip: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (full === skip) continue;
			if (entry.isDirectory()) walk(full);
			else {
				const stat = fs.statSync(full);
				out.set(path.relative(root, full), `${stat.size}:${stat.mtimeMs}`);
			}
		}
	};
	walk(root);
	return out;
}

const settingsOf = (student: Student) => JSON.parse(fs.readFileSync(path.join(student.dir, "settings.json"), "utf8")) as Record<string, unknown> & { agent?: Record<string, unknown> };

before(async () => {
	t = await createTestDb();
	anthropic = await startFakeAnthropic(() => ({ usage: { input: 900, output: 120, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, text: "No facts in this note." }));
	tavily = await startFakeTavily();
	fs.mkdirSync(path.join(libraryDir(volume), "faa"), { recursive: true });
	fs.writeFileSync(path.join(libraryDir(volume), "faa", "metar.md"), "LIBRARY-MARKER: how to read a METAR\n");
	const { startFrontDoor } = await import("../frontdoor/wiring/front-door.ts");
	frontDoor = await startFrontDoor({
		env: ENV,
		frontDoorApp: (_req, res) => res.end("front door page"),
		clerk: { authenticate: async () => clerkResult, isSessionActive: async () => true },
		db: t.db,
		upstream: { anthropicBaseUrl: anthropic.url, tavilyBaseUrl: tavily.url },
		log: (line) => logs.push(line),
	});
	Object.assign(alice, await signIn("user_alice"));
	Object.assign(bob, await signIn("user_bob"));
	const created = await viaFrontDoor(bob, "/api/chats", { method: "POST", body: JSON.stringify({ title: BOB_TOPIC }), headers: { "Content-Type": "application/json" } });
	assert.equal(created.status, 200, await created.clone().text());
	bobChatId = ((await created.json()) as { id: string }).id;
});

after(async () => {
	await frontDoor?.close();
	await anthropic?.close();
	await tavily?.close();
	await t?.close();
	fs.rmSync(work, { recursive: true, force: true });
});

describe("wall A: a tenant server refuses any request without its own secret", () => {
	const PATHS = ["/", "/chat/new", "/settings", "/api/chats", "/api/settings", "/api/keys", "/_next/static/chunks/main.js", "/__harness/state"];

	it("runs each tenant in hosted mode with its own 64-character secret and temp folder", async () => {
		const a = await harnessState(alice);
		const b = await harnessState(bob);
		assert.equal(a.hosted, "1");
		assert.equal(a.secretLength, 64);
		assert.equal(a.tmpdir, path.join(alice.dir, ".tmp"));
		assert.equal(b.tmpdir, path.join(bob.dir, ".tmp"));
		assert.notEqual(a.pid, b.pid);
		const [ea, eb] = [await frontDoor.tenantEndpoint(alice.tenantId), await frontDoor.tenantEndpoint(bob.tenantId)];
		assert.notEqual(ea.headers["x-learnharness-desktop"], eb.headers["x-learnharness-desktop"]);
	});

	it("refuses every path with no secret, and with the other tenant's secret", async () => {
		const ea = await frontDoor.tenantEndpoint(alice.tenantId);
		const eb = await frontDoor.tenantEndpoint(bob.tenantId);
		const failures: string[] = [];
		for (const p of PATHS) {
			for (const [label, headers] of [["none", {}], ["alice's", ea.headers], ["forged", { "x-learnharness-desktop": "x".repeat(64) }]] as const) {
				const res = await direct(eb, p, {}, headers);
				if (res.status !== 403) failures.push(`${p} with ${label} secret → ${res.status}`);
				await res.body?.cancel();
			}
			for (const method of ["POST", "PUT", "DELETE"]) {
				const res = await direct(eb, p, { method, body: "{}" }, {});
				if (res.status !== 403) failures.push(`${method} ${p} with no secret → ${res.status}`);
				await res.body?.cancel();
			}
		}
		assert.deepEqual(failures, []);
	});

	it("answers with its own secret", async () => {
		const eb = await frontDoor.tenantEndpoint(bob.tenantId);
		const res = await direct(eb, "/api/chats");
		assert.equal(res.status, 200);
		assert.ok((await res.text()).includes(BOB_TOPIC));
	});
});

describe("every API route: student A cannot see or change student B's data", () => {
	const fill = (route: string) => route.replace("[snapshotId]", "snap_1").replace("[...segment]", "teacher/base.md").replace("[section]", "appearance").replace("[id]", bobChatId);

	it("asking with B's ids returns nothing of B's, on every allowed route and method", async () => {
		const leaks: string[] = [];
		const broken: string[] = [];
		const seen: string[] = [];
		const body = JSON.stringify({ chatId: bobChatId, id: bobChatId, title: "hijacked", input: { text: "hello" }, messageId: "m1", fileAccess: fileAccessTemplate(libraryDir(volume)) });
		for (const rule of STUDENT_ROUTES) {
			if (rule.access === "blocked") continue;
			for (const method of rule.methods) {
				let pathname = fill(rule.path);
				if (rule.path === "/api/jobs") pathname = `/api/jobs?chatId=${bobChatId}`;
				const res = await viaFrontDoor(alice, pathname, { method, ...(method === "GET" ? {} : { body, headers: { "Content-Type": "application/json" } }) });
				const stream = (res.headers.get("content-type") ?? "").includes("text/event-stream");
				const text = await readSome(res, stream ? 600 : 5000);
				seen.push(`${method} ${pathname} → ${res.status}`);
				// The route really ran in A's server: an answer from upstream, not a front door refusal or a crash.
				if (res.status >= 500 || res.status === 401 || res.status === 403) broken.push(`${method} ${pathname} → ${res.status} ${text.slice(0, 120)}`);
				if (text.includes(BOB_TOPIC)) leaks.push(`${method} ${pathname} → ${res.status}`);
			}
		}
		assert.deepEqual(broken, [], seen.join("\n"));
		assert.deepEqual(leaks, []);
		// Spot checks that A's own server answered "not yours" (not found), not an empty success.
		for (const p of [`/api/chats/${bobChatId}`, `/api/chats/${bobChatId}/markdown`]) assert.equal((await viaFrontDoor(alice, p)).status, 404, p);
	});

	it("B's session is still there, unchanged", async () => {
		const res = await viaFrontDoor(bob, `/api/chats/${bobChatId}`);
		assert.equal(res.status, 200);
		const chat = (await res.json()) as { title?: string; chat?: { title?: string } };
		assert.equal(chat.title ?? chat.chat?.title, BOB_TOPIC);
		const list = await (await viaFrontDoor(bob, "/api/chats")).text();
		assert.ok(list.includes(bobChatId));
	});

	it("A's own lists never show B's sessions", async () => {
		for (const p of ["/api/chats", "/api/graph", "/api/graph/sources", "/api/activity", "/api/graph/status"]) {
			const text = await (await viaFrontDoor(alice, p)).text();
			assert.ok(!text.includes(BOB_TOPIC) && !text.includes(bobChatId), p);
		}
	});

	it("A's notification stream carries nothing of B's while B works", async () => {
		const opened = Date.now();
		const stream = await viaFrontDoor(alice, "/api/events");
		assert.equal(stream.status, 200);
		assert.ok(Date.now() - opened < 5000, "the stream opens at once, not at its first frame");
		let text = "";
		const reader = stream.body!.getReader();
		const decoder = new TextDecoder();
		const pump = (async () => {
			for (;;) {
				const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
				if (chunk.done) return;
				text += decoder.decode(chunk.value, { stream: true });
			}
		})();
		const post = (student: Student, title: string) => viaFrontDoor(student, "/api/chats", { method: "POST", body: JSON.stringify({ title }), headers: { "Content-Type": "application/json" } });
		const events = () => (text.match(/event: chats-changed/g) ?? []).length;
		try {
			await sleep(200);
			assert.equal((await post(bob, `${BOB_TOPIC} two`)).status, 200);
			await sleep(700);
			assert.equal(events(), 0, `B's new session sent nothing to A's stream: ${JSON.stringify(text)}`);
			assert.equal((await post(alice, "Alice's own new session")).status, 200);
			const deadline = Date.now() + 3000;
			while (events() === 0 && Date.now() < deadline) await sleep(50);
			assert.equal(events(), 1, "A's own new session did reach A's stream (so the stream works)");
			assert.ok(!text.includes(BOB_TOPIC));
		} finally {
			await reader.cancel().catch(() => {});
			await pump;
		}
	});
});

describe("agent tools inside tenant A (wall B and file access)", () => {
	it("web_fetch cannot reach B's server, the meter, localhost or the metadata address, and B sees no request", async () => {
		const eb = await frontDoor.tenantEndpoint(bob.tenantId);
		const before = (await harnessState(bob)).hits;
		const anthropicBefore = anthropic.received.length;
		for (const url of [`${eb.url}/api/chats`, `http://localhost:${eb.port}/`, `http://[::1]:${eb.port}/`, `http://[::ffff:127.0.0.1]:${eb.port}/`, `${frontDoor.meterUrl}/v1/messages`, "http://169.254.169.254/latest/meta-data/"]) {
			const out = await runTool(alice, "web_fetch", { url });
			assert.ok(out.includes(BLOCKED_ADDRESS_MESSAGE), `${url}: ${out.slice(0, 200)}`);
		}
		const out = await runTool(alice, "web_fetch_pdf", { url: `${eb.url}/paper.pdf` });
		assert.ok(out.includes(BLOCKED_ADDRESS_MESSAGE), out.slice(0, 200));
		assert.equal((await harnessState(bob)).hits, before + 1, "only this test's own state reads reached B");
		assert.equal(anthropic.received.length, anthropicBefore);
	});

	it("file tools cannot read B's folder, B's key file, or system files, but can read the library", async () => {
		for (const p of [path.join(bob.dir, "settings.json"), path.join(alice.dir, "..", bob.tenantId, "settings.json"), tenantAuthFile(volume, bob.tenantId), tenantAuthFile(volume, alice.tenantId), "/etc/passwd"]) {
			const out = await runTool(alice, "read", { path: p });
			assert.match(out, /Access denied|threw/, `${p}: ${out.slice(0, 160)}`);
			assert.ok(!out.includes(BOB_TOPIC));
		}
		assert.match(await runTool(alice, "ls", { path: bob.dir }), /Access denied|threw/);
		assert.match(await runTool(alice, "read", { path: path.join(libraryDir(volume), "faa", "metar.md") }), /LIBRARY-MARKER/);
	});
});

describe("a background job that A starts", () => {
	it("writes only inside A's folder, and its model cost lands on A", async () => {
		const before = snapshot(volume, alice.dir);
		const bobRows = (await dbm.listModelUsage(t.db, bob.tenantId)).length;
		const aliceRows = (await dbm.listModelUsage(t.db, alice.tenantId)).length;
		const form = new FormData();
		form.append("files", new File(["# Alice's own notes\n\nAltimeter settings come from the METAR.\n"], "alice-notes.md"));
		const res = await viaFrontDoor(alice, "/api/graph/import", { method: "POST", body: form });
		assert.equal(res.status, 200, await res.clone().text());
		await res.text();
		// Usage rows are written after the call ends; wait for A's.
		const deadline = Date.now() + 10_000;
		while ((await dbm.listModelUsage(t.db, alice.tenantId)).length === aliceRows && Date.now() < deadline) await sleep(50);
		assert.ok((await dbm.listModelUsage(t.db, alice.tenantId)).length > aliceRows, "the import's model calls are A's");
		assert.equal((await dbm.listModelUsage(t.db, bob.tenantId)).length, bobRows, "none are B's");
		assert.deepEqual([...snapshot(volume, alice.dir)].filter(([k, v]) => before.get(k) !== v), [], "nothing outside A's folder changed");
		assert.deepEqual([...before.keys()].filter((k) => !snapshot(volume, alice.dir).has(k)), [], "nothing outside A's folder was removed");
	});
});

describe("model lock and settings sync (P2-04)", () => {
	it("refuses model and thinking changes, and the Owner's models stay in settings.json", async () => {
		const strong = { model: { provider: "anthropic", id: "claude-haiku-5-5" }, thinkingLevel: "low" };
		for (const [p, body] of [
			["/api/settings/models", { strong, cheap: strong, vision: strong }],
			["/api/settings/chat", strong],
			[`/api/chats/${bobChatId}/settings`, strong],
		] as const) {
			const res = await viaFrontDoor(alice, p, { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
			assert.equal(res.status, 403, p);
		}
		assert.deepEqual(settingsOf(alice).models, OWNER_MODELS);
	});

	it("a new session takes the Owner's Strong model and thinking level", async () => {
		const made = await viaFrontDoor(alice, "/api/chats", { method: "POST", body: JSON.stringify({ title: "Alice METAR" }), headers: { "Content-Type": "application/json" } });
		const { id } = (await made.json()) as { id: string };
		const chat = (await (await viaFrontDoor(alice, `/api/chats/${id}`)).json()) as { settings?: { model?: { id: string }; thinkingLevel?: string } };
		assert.equal(chat.settings?.model?.id, "claude-opus-5-5");
		assert.equal(chat.settings?.thinkingLevel, "high");
	});

	it("the Settings screen's agent write passes; a File access change does not", async () => {
		const { settings } = (await (await viaFrontDoor(alice, "/api/settings")).json()) as { settings: { agent: Record<string, unknown> } };
		const toggled = { ...settings.agent, tools: { ...(settings.agent.tools as object | undefined), research: false } };
		const ok = await viaFrontDoor(alice, "/api/settings/agent", { method: "PUT", body: JSON.stringify(toggled), headers: { "Content-Type": "application/json" } });
		assert.equal(ok.status, 200, await ok.clone().text());
		assert.equal((settingsOf(alice).agent?.tools as Record<string, boolean>).research, false);
		const widened = { ...settings.agent, fileAccess: { restricted: false, folders: [] } };
		const refused = await viaFrontDoor(alice, "/api/settings/agent", { method: "PUT", body: JSON.stringify(widened), headers: { "Content-Type": "application/json" } });
		assert.equal(refused.status, 403);
		assert.deepEqual(settingsOf(alice).agent?.fileAccess, fileAccessTemplate(libraryDir(volume)));
	});

	it("a drifted settings.json is put back at the next start", async () => {
		const file = path.join(alice.dir, "settings.json");
		const drifted = settingsOf(alice);
		drifted.models = { strong: { model: { provider: "anthropic", id: "claude-haiku-5-5" }, thinkingLevel: "low" } };
		drifted.chat = { model: { provider: "anthropic", id: "claude-haiku-5-5" } };
		drifted.customProvider = { baseUrl: "http://127.0.0.1:9" };
		drifted.claudeCode = { enabled: true };
		drifted.agent = { ...drifted.agent, models: { researcher: { model: { provider: "anthropic", id: "claude-haiku-5-5" } } }, fileAccess: { restricted: false, folders: [] } };
		fs.writeFileSync(file, JSON.stringify(drifted));

		const { pid } = await harnessState(alice);
		process.kill(pid, "SIGKILL");
		const deadline = Date.now() + 30_000;
		let restarted: number | undefined;
		while (Date.now() < deadline) {
			try {
				const state = await harnessState(alice);
				if (state.pid !== pid) {
					restarted = state.pid;
					break;
				}
			} catch {
				/* the old port is gone until the supervisor notices */
			}
			await sleep(100);
		}
		assert.ok(restarted, "the tenant server started again");
		const back = settingsOf(alice);
		assert.deepEqual(back.models, OWNER_MODELS);
		for (const section of ["chat", "customProvider", "claudeCode"]) assert.equal(back[section], undefined, section);
		assert.equal(back.agent?.models, undefined);
		assert.deepEqual(back.agent?.fileAccess, fileAccessTemplate(libraryDir(volume)));
		assert.equal((back.agent?.tools as Record<string, boolean>).research, false, "the student's own tool switch is kept");
	});
});

describe("without a login", () => {
	it("every API route and method gets 401", async () => {
		const failures: string[] = [];
		for (const rule of STUDENT_ROUTES) {
			for (const method of rule.methods) {
				const res = await fetch(`${frontDoor.url}${rule.path.replace(/\[[^\]]+\]/g, "x1")}`, { method, redirect: "manual", body: method === "GET" ? undefined : "{}" });
				if (res.status !== 401) failures.push(`${method} ${rule.path} → ${res.status}`);
				await res.body?.cancel();
			}
		}
		assert.deepEqual(failures, []);
	});
});

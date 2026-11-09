/**
 * One LearnHarness server per tenant (PRD X1 jobs 2 to 4, C1 req 3, PD4).
 *
 * The supervisor starts a tenant's server on first login, keeps it running,
 * restarts it if it stops, and gives it only its own folder and none of the
 * front door's secrets. The stand-in tenant below speaks plain HTTP and SSE
 * the way upstream's standalone server does; the X5 spike already ran the
 * real one (docs/decisions/2026-11-08-x5-front-door-spike.md).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ClerkAuthResult } from "../frontdoor/gateway/auth.ts";
import { createGateway } from "../frontdoor/gateway/handler.ts";
import { AGE_COOKIE, SESSION_COOKIE, signAgeConfirmation } from "../frontdoor/gateway/session.ts";
import { InMemoryAccountStore } from "../frontdoor/tenants/accounts.ts";
import { tenantAuthFile, tenantDir } from "../frontdoor/tenants/paths.ts";
import { provisionTenant } from "../frontdoor/tenants/provisioning.ts";
import { TenantSupervisor, tenantServerEnv } from "../frontdoor/tenants/supervisor.ts";

const SECRET = new TextEncoder().encode("supervisor-test-secret-0123456789abcdefgh");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fd-supervisor-"));
const volume = path.join(work, "volume");
const FRAMES = 10;
const GAP_MS = 100;

/** Stand-in tenant: GET /env reports its environment, GET /api/events streams timed frames. */
const FAKE_TENANT = `
import { createServer } from "node:http";
createServer((req, res) => {
	if (req.url === "/env") {
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ pid: process.pid, cwd: process.cwd(), env: process.env }));
		return;
	}
	if (req.url === "/api/events") {
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
		let seq = 0;
		const timer = setInterval(() => {
			res.write("data: " + JSON.stringify({ seq, t: Date.now() }) + "\\n\\n");
			seq += 1;
			if (seq >= ${FRAMES}) { clearInterval(timer); res.end(); }
		}, ${GAP_MS});
		req.on("close", () => clearInterval(timer));
		return;
	}
	res.end("ok");
}).listen(Number(process.env.PORT), process.env.HOSTNAME);
`;
const serverScript = path.join(work, "server", "server.js");
fs.mkdirSync(path.dirname(serverScript), { recursive: true });
fs.writeFileSync(serverScript, FAKE_TENANT);

/** The front door's own environment, secrets included: none may reach a tenant. */
const FRONT_DOOR_ENV = {
	PATH: process.env.PATH,
	LANG: "en_US.UTF-8",
	CLERK_SECRET_KEY: "sk_test_must_not_leak",
	FRONTDOOR_SESSION_SECRET: "must-not-leak-must-not-leak-must-not-leak",
	ANTHROPIC_API_KEY: "sk-ant-must-not-leak",
	SUPABASE_SERVICE_ROLE_KEY: "must-not-leak",
	STRIPE_SECRET_KEY: "sk_test_must_not_leak",
	TAVILY_API_KEY: "tvly-must-not-leak",
	DEEPGRAM_API_KEY: "must-not-leak",
	LH_PROVIDER_EVENTS: "1",
	LH_BACKGROUND_CAPTURE: "1",
	LH_DESKTOP_SERVER: "1",
};
const SECRET_NAMES = [
	"CLERK_SECRET_KEY",
	"FRONTDOOR_SESSION_SECRET",
	"ANTHROPIC_API_KEY",
	"SUPABASE_SERVICE_ROLE_KEY",
	"STRIPE_SECRET_KEY",
	"TAVILY_API_KEY",
	"DEEPGRAM_API_KEY",
	"LH_PROVIDER_EVENTS",
	"LH_BACKGROUND_CAPTURE",
	"LH_DESKTOP_SERVER",
];

const supervisor = new TenantSupervisor({ serverScript, volumeDir: volume, baseEnv: FRONT_DOOR_ENV, startTimeoutMs: 10_000 });
const accounts = new InMemoryAccountStore();
let clerkResult: ClerkAuthResult = { status: "signed-out" };
let gateway: Server;
let base = "";

before(async () => {
	gateway = createServer(
		createGateway({
			accounts,
			clerk: { authenticate: async () => clerkResult, isSessionActive: async () => true },
			supervisor,
			provision: (tenantId) => {
				provisionTenant({ volumeDir: volume, tenantId });
			},
			sessionSecret: SECRET,
			secureCookies: false,
			trustForwardedHeaders: false,
			frontDoorApp: (_req, res) => res.end("front door page"),
		}),
	);
	await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise((r) => gateway.close(r));
	await supervisor.stopAll();
	fs.rmSync(work, { recursive: true, force: true });
});

/** Logs a new student in through /account/start; returns their login cookie and tenant. */
async function firstLogin(userId: string): Promise<{ cookie: string; tenantId: string }> {
	clerkResult = { status: "signed-in", userId, sessionId: `sess_${userId}` };
	const age = await signAgeConfirmation(Date.now(), SECRET);
	const res = await fetch(`${base}/account/start`, { redirect: "manual", headers: { Cookie: `${AGE_COOKIE}=${age}` } });
	assert.equal(res.status, 302);
	const session = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
	assert.ok(session, "the login cookie is set");
	const tenantId = (await accounts.get(userId))?.tenantId;
	assert.ok(tenantId);
	return { cookie: session.split(";")[0] ?? "", tenantId };
}

async function tenantEnv(cookie: string): Promise<{ pid: number; cwd: string; env: Record<string, string> }> {
	const res = await fetch(`${base}/env`, { headers: { Cookie: cookie } });
	assert.equal(res.status, 200);
	return (await res.json()) as { pid: number; cwd: string; env: Record<string, string> };
}

describe("tenant servers", () => {
	let alice = { cookie: "", tenantId: "" };

	it("starts the tenant's server on first login, with only its own folder", async () => {
		assert.equal(supervisor.isRunning("00000000-0000-4000-8000-000000000000"), false);
		alice = await firstLogin("user_alice");
		assert.equal(supervisor.isRunning(alice.tenantId), true, "running before the first page loads");

		const { env } = await tenantEnv(alice.cookie);
		assert.equal(env.LH_DATA_DIR, tenantDir(volume, alice.tenantId));
		assert.equal(env.LH_AUTH_FILE, tenantAuthFile(volume, alice.tenantId));
		assert.equal(env.HOME, tenantDir(volume, alice.tenantId));
		assert.equal(env.HOSTNAME, "127.0.0.1", "listens only inside the machine");
		assert.equal(env.NODE_ENV, "production");
		for (const name of SECRET_NAMES) assert.equal(env[name], undefined, `${name} must not reach a tenant`);
		assert.ok(fs.existsSync(path.join(tenantDir(volume, alice.tenantId), "settings.json")), "the folder was provisioned");
	});

	it("passes the tenant's stream through without buffering", async () => {
		const started = Date.now();
		const res = await fetch(`${base}/api/events`, { headers: { Cookie: alice.cookie, "Accept-Encoding": "gzip, deflate, br" } });
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "text/event-stream");
		const reader = res.body?.getReader();
		assert.ok(reader);
		const decoder = new TextDecoder();
		let buffer = "";
		const delays: number[] = [];
		const arrivals: number[] = [];
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			const now = Date.now();
			buffer += decoder.decode(value, { stream: true });
			let end: number;
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const data = JSON.parse(frame.replace(/^data: /, "")) as { t: number };
				delays.push(now - data.t);
				arrivals.push(now - started);
			}
		}
		assert.equal(delays.length, FRAMES);
		assert.ok(Math.max(...delays) < 150, `every frame arrives within 150 ms of being sent (worst ${Math.max(...delays)} ms)`);
		const spread = (arrivals.at(-1) ?? 0) - (arrivals[0] ?? 0);
		assert.ok(spread >= (FRAMES - 1) * GAP_MS * 0.7, `frames arrive spread out, not in one batch (spread ${spread} ms)`);
	});

	it("keeps the server running between requests (no idle stop)", async () => {
		const first = await tenantEnv(alice.cookie);
		const second = await tenantEnv(alice.cookie);
		assert.equal(second.pid, first.pid);
	});

	it("gives each tenant its own server and folder", async () => {
		const bob = await firstLogin("user_bob");
		assert.notEqual(bob.tenantId, alice.tenantId);
		const a = await tenantEnv(alice.cookie);
		const b = await tenantEnv(bob.cookie);
		assert.notEqual(a.pid, b.pid);
		assert.equal(b.env.LH_DATA_DIR, tenantDir(volume, bob.tenantId));
	});

	it("restarts a tenant's server that stopped, on its next request", async () => {
		const before = await tenantEnv(alice.cookie);
		process.kill(before.pid, "SIGKILL");
		for (let i = 0; i < 50 && supervisor.isRunning(alice.tenantId); i++) await new Promise((r) => setTimeout(r, 50));
		assert.equal(supervisor.isRunning(alice.tenantId), false);
		const afterRestart = await tenantEnv(alice.cookie);
		assert.notEqual(afterRestart.pid, before.pid);
	});

	it("starts one server when several first requests arrive at once", async () => {
		const tenantId = "11111111-1111-4111-8111-111111111111";
		provisionTenant({ volumeDir: volume, tenantId });
		const ports = await Promise.all([1, 2, 3, 4].map(() => supervisor.ensureRunning(tenantId)));
		assert.equal(new Set(ports).size, 1);
	});

	it("rejects a tenant ID that is not a UUID", async () => {
		await assert.rejects(supervisor.ensureRunning("../escape"), /tenant id/i);
	});

	it("loads a module into each tenant server before it starts (Node --import)", async () => {
		const preload = path.join(work, "preload.mjs");
		fs.writeFileSync(preload, 'process.env.FD_PRELOADED = "yes";\n');
		const withImport = new TenantSupervisor({ serverScript, volumeDir: volume, baseEnv: FRONT_DOOR_ENV, nodeArgs: ["--import", preload], startTimeoutMs: 10_000 });
		const tenantId = "44444444-4444-4444-8444-444444444444";
		provisionTenant({ volumeDir: volume, tenantId });
		const port = await withImport.ensureRunning(tenantId);
		const { env } = (await (await fetch(`http://127.0.0.1:${port}/env`)).json()) as { env: Record<string, string> };
		assert.equal(env.FD_PRELOADED, "yes");
		await withImport.stopAll();
	});

	it("fails clearly when the tenant server cannot start", async () => {
		const broken = new TenantSupervisor({ serverScript: path.join(work, "missing.js"), volumeDir: volume, baseEnv: FRONT_DOOR_ENV, startTimeoutMs: 3000 });
		await assert.rejects(broken.ensureRunning("22222222-2222-4222-8222-222222222222"), /exited|did not start/i);
		await broken.stopAll();
	});
});

describe("tenant server environment", () => {
	it("is built from a short allowlist, never the whole front door environment", () => {
		const env = tenantServerEnv({ serverScript, volumeDir: volume, baseEnv: FRONT_DOOR_ENV }, "33333333-3333-4333-8333-333333333333", 41234);
		assert.deepEqual(Object.keys(env).sort(), ["HOME", "HOSTNAME", "LANG", "LH_AUTH_FILE", "LH_DATA_DIR", "NEXT_TELEMETRY_DISABLED", "NODE_ENV", "PATH", "PORT"]);
		assert.equal(env.PORT, "41234");
	});

	it("adds the extra variables a later package plugs in", () => {
		const env = tenantServerEnv(
			{ serverScript, volumeDir: volume, baseEnv: FRONT_DOOR_ENV, extraEnv: (id) => ({ FRONTDOOR_TENANT_ID: id }) },
			"33333333-3333-4333-8333-333333333333",
			41234,
		);
		assert.equal(env.FRONTDOOR_TENANT_ID, "33333333-3333-4333-8333-333333333333");
	});
});

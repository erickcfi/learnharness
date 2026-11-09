/**
 * W2-6 at the gateway (P2-03, P2-04; PRD C1 and C3 acceptance tests): the
 * front door applies the route table to every logged-in request, sends the
 * tenant's own secret header, and checks the agent-section body.
 *
 *  - Without a login, every /api route and method gets 401 (C1).
 *  - With a login, every blocked route and method gets 403 with a JSON
 *    message, and never reaches the tenant (C3 "a student request to any
 *    route in section 4, fact 6, is refused").
 *  - Allowed requests reach the tenant with its secret, and a browser's own
 *    copy of that header never does.
 *  - The agent section passes only with the Owner's File access and no
 *    per-role models, byte for byte (C3 "a request to change the model or
 *    the thinking level is refused").
 */
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ClerkGateway } from "../frontdoor/gateway/auth.ts";
import { createGateway } from "../frontdoor/gateway/handler.ts";
import { MAX_CHECKED_BODY_BYTES, studentRoutePolicy } from "../frontdoor/gateway/route-guard.ts";
import { STUDENT_ROUTES } from "../frontdoor/gateway/route-policy.ts";
import { SESSION_COOKIE, signSession } from "../frontdoor/gateway/session.ts";
import { InMemoryAccountStore } from "../frontdoor/tenants/accounts.ts";

const SECRET = new TextEncoder().encode("isolation-gateway-test-secret-0123456789");
const TENANT_SECRET = "t".repeat(64);
const LIBRARY = "/data/library";
const FILE_ACCESS = { restricted: true, folders: [LIBRARY] };
const clock = Date.parse("2026-11-08T12:00:00Z");
const clerk: ClerkGateway = { authenticate: async () => ({ status: "signed-out" }), isSessionActive: async () => true };

const hits: { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
let tenant: Server;
let gateway: Server;
let base = "";
let cookie = "";

/** A request path for a table row: [id] → x1, [...name] → a/b.md. */
const samplePath = (route: string) => route.replace(/\[\.\.\.[^\]]+\]/g, "a/b.md").replace(/\[[^\]]+\]/g, "x1");

before(async () => {
	tenant = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ fromTenant: true }));
		});
	});
	await new Promise<void>((r) => tenant.listen(0, "127.0.0.1", r));
	const port = (tenant.address() as AddressInfo).port;

	const accounts = new InMemoryAccountStore();
	await accounts.confirmAge("user_a", new Date(clock));
	const tenantId = await accounts.assignTenant("user_a");
	gateway = createServer(
		createGateway({
			accounts,
			clerk,
			supervisor: {
				ensureRunning: async () => port,
				endpoint: async () => ({ port, headers: { "x-learnharness-desktop": TENANT_SECRET } }),
			},
			routePolicy: studentRoutePolicy({ fileAccess: FILE_ACCESS }),
			provision: async () => {},
			sessionSecret: SECRET,
			secureCookies: false,
			trustForwardedHeaders: false,
			frontDoorApp: (_req, res) => res.end("front door page"),
			now: () => clock,
		}),
	);
	await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
	cookie = `${SESSION_COOKIE}=${await signSession({ userId: "user_a", sessionId: "s1", tenantId, checkedAt: clock }, SECRET, clock)}`;
});

after(async () => {
	await new Promise((r) => gateway.close(r));
	await new Promise((r) => tenant.close(r));
});

beforeEach(() => {
	hits.length = 0;
});

const send = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { redirect: "manual", ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string> | undefined) } });

describe("without a login", () => {
	it("every route and method in the table gets 401, and nothing reaches the tenant", async () => {
		const failures: string[] = [];
		for (const rule of STUDENT_ROUTES) {
			for (const method of [...rule.methods, "OPTIONS"]) {
				const res = await fetch(`${base}${samplePath(rule.path)}`, { method, body: method === "GET" || method === "HEAD" ? undefined : "{}" });
				if (res.status !== 401) failures.push(`${method} ${rule.path} → ${res.status}`);
				await res.body?.cancel();
			}
		}
		assert.deepEqual(failures, []);
		assert.equal(hits.length, 0);
	});
});

describe("with a login", () => {
	it("every blocked route and method gets 403 with a JSON message, and nothing reaches the tenant", async () => {
		const failures: string[] = [];
		const blocked = STUDENT_ROUTES.filter((r) => r.access === "blocked");
		assert.ok(blocked.length >= 15);
		for (const rule of blocked) {
			for (const method of rule.methods) {
				const pathname = rule.path === "/api/settings/[section]" ? "/api/settings/notASection" : samplePath(rule.path);
				const res = await send(pathname, { method, body: method === "GET" ? undefined : "{}" });
				const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
				if (res.status !== 403 || typeof body?.error !== "string" || body.error !== rule.reason) failures.push(`${method} ${pathname} → ${res.status} ${JSON.stringify(body)}`);
			}
		}
		assert.deepEqual(failures, []);
		assert.equal(hits.length, 0);
	});

	it("an unlisted API path, a read-only write, and a page write get 403", async () => {
		for (const [method, pathname] of [
			["GET", "/api/brand-new-upstream-route"],
			["POST", "/api/settings"],
			["DELETE", "/api/models"],
			["POST", "/chat/new"],
			["OPTIONS", "/api/chats"],
		]) {
			const res = await send(pathname as string, { method });
			assert.equal(res.status, 403, `${method} ${pathname}`);
			await res.body?.cancel();
		}
		assert.equal(hits.length, 0);
	});

	it("a path with an empty segment or an encoded slash gets 400", async () => {
		const raw = (p: string) =>
			new Promise<number>((resolve, reject) => {
				const req = request(`${base}/`, { path: p, headers: { Cookie: cookie } }, (res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				});
				req.on("error", reject);
				req.end();
			});
		for (const p of ["//api/keys", "/api//keys", "/api/chats/x%2f..%2f..%2fkeys/markdown"]) assert.equal(await raw(p), 400, p);
		assert.equal(hits.length, 0);
	});

	it("every allowed route reaches the tenant with the tenant's secret, never the browser's copy", async () => {
		const allowed = STUDENT_ROUTES.filter((r) => r.access === "allowed" || r.access === "read-only");
		for (const rule of allowed) {
			const method = rule.access === "read-only" ? "GET" : (rule.methods[0] as string);
			const res = await send(samplePath(rule.path), { method, body: method === "GET" ? undefined : "{}", headers: { "X-LearnHarness-Desktop": "forged-by-the-browser" } });
			assert.equal(res.status, 200, `${method} ${rule.path}`);
			await res.body?.cancel();
		}
		assert.equal(hits.length, allowed.length);
		for (const hit of hits) assert.equal(hit.headers["x-learnharness-desktop"], TENANT_SECRET, hit.url);
	});

	it("pages reach the tenant on GET", async () => {
		for (const p of ["/", "/chat/new", "/chat/abc", "/settings", "/_next/static/chunks/main.js"]) {
			const res = await send(p);
			assert.equal(res.status, 200, p);
			await res.body?.cancel();
		}
		assert.equal(hits.length, 5);
	});
});

describe("the agent section (PUT /api/settings/agent)", () => {
	const put = (body: BodyInit, headers: Record<string, string> = {}) => send("/api/settings/agent", { method: "PUT", body, headers: { "Content-Type": "application/json", ...headers } });

	it("passes the UI's body with the Owner's File access, byte for byte", async () => {
		const body = JSON.stringify({ tools: { research: false }, graphTools: { enabled: true }, fileAccess: FILE_ACCESS });
		const res = await put(body);
		assert.equal(res.status, 200);
		assert.equal(hits.length, 1);
		assert.equal(hits[0]?.body.toString("utf8"), body);
		assert.equal(hits[0]?.headers["content-length"], String(Buffer.byteLength(body)));
		assert.equal(hits[0]?.headers["x-learnharness-desktop"], TENANT_SECRET);
	});

	it("refuses a per-role model override or a changed File access with 403", async () => {
		for (const body of [
			{ fileAccess: FILE_ACCESS, models: { researcher: { model: { provider: "anthropic", id: "claude-haiku-5-5" } } } },
			{ fileAccess: { restricted: false, folders: [LIBRARY] } },
			{ fileAccess: { restricted: true, folders: [LIBRARY, "/"] } },
			{ tools: { research: true } },
		]) {
			const res = await put(JSON.stringify(body));
			assert.equal(res.status, 403, JSON.stringify(body));
			assert.match(((await res.json()) as { error: string }).error, /North Aero sets/);
		}
		assert.equal(hits.length, 0);
	});

	it("reads the body as the tenant will: a byte-order mark does not hide a change", async () => {
		const evil = new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ fileAccess: { restricted: false, folders: [] } }))]));
		const res = await put(evil);
		assert.equal(res.status, 403);
		assert.equal(hits.length, 0);
	});

	it("refuses a body it cannot parse (400) or one over 64 KB (413), without forwarding", async () => {
		const bad = await put("{not json");
		assert.equal(bad.status, 400);
		const big = await put(JSON.stringify({ fileAccess: FILE_ACCESS, pad: "x".repeat(MAX_CHECKED_BODY_BYTES) }));
		assert.equal(big.status, 413);
		assert.equal(hits.length, 0);
	});

	it("the last of two duplicate keys is what both sides read", async () => {
		const res = await put(`{"fileAccess": ${JSON.stringify(FILE_ACCESS)}, "fileAccess": {"restricted": false, "folders": []}}`);
		assert.equal(res.status, 403);
		const ok = await put(`{"fileAccess": {"restricted": false, "folders": []}, "fileAccess": ${JSON.stringify(FILE_ACCESS)}}`);
		assert.equal(ok.status, 200);
		assert.equal(hits.length, 1);
	});
});

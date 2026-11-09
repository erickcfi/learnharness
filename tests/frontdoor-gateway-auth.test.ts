/**
 * Front door login gate (PRD C1 acceptance test, X1 job 1, X5).
 *
 * Every request outside /account must carry the front door's own login
 * cookie. Without it: any /api route gets 401, and a page gets a redirect to
 * sign-in. Nothing reaches the tenant server. With it, the request passes
 * through, minus the login cookies, and the Clerk session is re-checked every
 * 5 minutes (Owner, 2026-11-08).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ClerkGateway } from "../frontdoor/gateway/auth.ts";
import { createGateway } from "../frontdoor/gateway/handler.ts";
import { SESSION_COOKIE, SESSION_RECHECK_MS, signSession, verifySession } from "../frontdoor/gateway/session.ts";
import { InMemoryAccountStore } from "../frontdoor/tenants/accounts.ts";

const SECRET = new TextEncoder().encode("gateway-auth-test-secret-0123456789abcdef");
const OTHER_SECRET = new TextEncoder().encode("another-secret-another-secret-0123456789");
const REPO = path.join(import.meta.dirname, "..");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Every route file under app/api, as a request path ([id] → x, [...rest] → a/b). */
function apiRoutePaths(): string[] {
	const paths: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name === "route.ts") {
				const rel = path.relative(path.join(REPO, "app"), dir).split(path.sep).join("/");
				paths.push(`/${rel}`.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, "a/b").replace(/\[[^\]]+\]/g, "x"));
			}
		}
	};
	walk(path.join(REPO, "app", "api"));
	return paths.sort();
}

let clock = Date.parse("2026-11-08T12:00:00Z");
let sessionActive: boolean | "error" = true;
let activeChecks = 0;
const clerk: ClerkGateway = {
	authenticate: async () => ({ status: "signed-out" }),
	isSessionActive: async () => {
		activeChecks += 1;
		if (sessionActive === "error") throw new Error("Clerk unreachable");
		return sessionActive;
	},
};

const tenantHits: { url: string; headers: IncomingHttpHeaders }[] = [];
let tenant: Server;
let gateway: Server;
let base = "";
const accounts = new InMemoryAccountStore();
let tenantId = "";

before(async () => {
	tenant = createServer((req, res) => {
		tenantHits.push({ url: req.url ?? "", headers: req.headers });
		res.setHeader("Content-Type", "text/plain");
		res.end("from tenant");
	});
	await new Promise<void>((r) => tenant.listen(0, "127.0.0.1", r));
	const tenantPort = (tenant.address() as AddressInfo).port;

	await accounts.confirmAge("user_a", new Date(clock));
	tenantId = await accounts.assignTenant("user_a");

	const handler = createGateway({
		accounts,
		clerk,
		supervisor: { ensureRunning: async () => tenantPort },
		provision: async () => {},
		sessionSecret: SECRET,
		secureCookies: false,
		trustForwardedHeaders: false,
		frontDoorApp: (_req, res) => {
			res.setHeader("X-Front-Door-App", "1");
			res.end("front door page");
		},
		now: () => clock,
	});
	gateway = createServer(handler);
	await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise((r) => gateway.close(r));
	await new Promise((r) => tenant.close(r));
});

beforeEach(() => {
	tenantHits.length = 0;
	sessionActive = true;
	activeChecks = 0;
});

async function loginCookie(overrides: { checkedAt?: number; secret?: Uint8Array; now?: number } = {}): Promise<string> {
	const token = await signSession(
		{ userId: "user_a", sessionId: "sess_1", tenantId, checkedAt: overrides.checkedAt ?? clock },
		overrides.secret ?? SECRET,
		overrides.now ?? clock,
	);
	return `${SESSION_COOKIE}=${token}`;
}

const send = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { redirect: "manual", ...init });

describe("front door: requests without a login", () => {
	it("finds the upstream API routes to test", () => {
		const routes = apiRoutePaths();
		assert.ok(routes.length >= 20, `expected the app/api route files, found ${routes.length}`);
		assert.ok(routes.includes("/api/keys"));
		assert.ok(routes.includes("/api/events"));
	});

	it("returns 401 for every /api route and method, and never reaches the tenant", async () => {
		const failures: string[] = [];
		for (const route of ["/api", "/api/", ...apiRoutePaths()]) {
			for (const method of METHODS) {
				const res = await send(route, { method, body: method === "GET" ? undefined : "{}" });
				const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
				if (res.status !== 401 || typeof body?.error !== "string") failures.push(`${method} ${route} → ${res.status}`);
			}
		}
		assert.deepEqual(failures, []);
		assert.equal(tenantHits.length, 0);
	});

	it("returns 401 for a forged, expired, or wrongly signed login cookie", async () => {
		const expired = await loginCookie({ now: clock - 8 * 24 * 3600_000, checkedAt: clock - 8 * 24 * 3600_000 });
		const wrongKey = await loginCookie({ secret: OTHER_SECRET });
		for (const cookie of [`${SESSION_COOKIE}=not-a-token`, expired, wrongKey, "__session=clerk-token-alone"]) {
			const res = await send("/api/chats", { headers: { Cookie: cookie } });
			assert.equal(res.status, 401, cookie.slice(0, 40));
		}
		assert.equal(tenantHits.length, 0);
	});

	it("redirects a page request to sign-in, keeping where the student was going", async () => {
		const res = await send("/chat/abc?tab=2");
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), `/account/sign-in?next=${encodeURIComponent("/chat/abc?tab=2")}`);
		assert.equal(tenantHits.length, 0);
	});

	it("serves /account pages from the front door app, with no login", async () => {
		const res = await send("/account/sign-in");
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("x-front-door-app"), "1");
		assert.equal(tenantHits.length, 0);
	});

	it("does not let path tricks reach the tenant or the front door app", async () => {
		// Raw requests: fetch() would clean up "..", and a browser-free client need not.
		const raw = (p: string) =>
			new Promise<{ status: number; frontDoorApp: boolean }>((resolve, reject) => {
				const req = request(`${base}/`, { path: p }, (res) => {
					res.resume();
					resolve({ status: res.statusCode ?? 0, frontDoorApp: res.headers["x-front-door-app"] === "1" });
				});
				req.on("error", reject);
				req.end();
			});
		for (const p of ["/account/../api/keys", "/account/%2e%2e/api/keys", "/account/./../api/keys", "/%61ccount/sign-in", "//api/keys"]) {
			const res = await raw(p);
			assert.equal(res.frontDoorApp, false, p);
			assert.ok(res.status === 401 || res.status === 302, `${p} → ${res.status}`);
		}
		assert.equal(tenantHits.length, 0);
	});
});

describe("front door: requests with a login", () => {
	it("passes the request to the tenant, without the login cookies", async () => {
		const cookie = `${await loginCookie()}; __session=clerk; __client_uat=1; theme=dark`;
		const res = await send("/api/chats?x=1", { headers: { Cookie: cookie } });
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "from tenant");
		assert.equal(tenantHits.length, 1);
		assert.equal(tenantHits[0]?.url, "/api/chats?x=1");
		assert.equal(tenantHits[0]?.headers.cookie, "theme=dark");
		assert.equal(activeChecks, 0, "a fresh login is not re-checked");
	});

	it("re-checks the Clerk session after 5 minutes and renews the cookie", async () => {
		const cookie = await loginCookie({ checkedAt: clock - SESSION_RECHECK_MS - 1000 });
		const res = await send("/api/chats", { headers: { Cookie: cookie } });
		assert.equal(res.status, 200);
		assert.equal(activeChecks, 1);
		const renewed = res.headers.get("set-cookie") ?? "";
		const token = /fd_session=([^;]+)/.exec(renewed)?.[1];
		const session = await verifySession(token, SECRET, clock);
		assert.equal(session?.checkedAt, clock);
		assert.match(renewed, /HttpOnly/i);
		assert.match(renewed, /SameSite=Lax/i);
	});

	it("ends the login when Clerk says the session is no longer active", async () => {
		sessionActive = false;
		const cookie = await loginCookie({ checkedAt: clock - SESSION_RECHECK_MS - 1000 });
		const res = await send("/api/chats", { headers: { Cookie: cookie } });
		assert.equal(res.status, 401);
		assert.match(res.headers.get("set-cookie") ?? "", /fd_session=;.*Max-Age=0/i);
		assert.equal(tenantHits.length, 0);
	});

	it("answers 503 and keeps the cookie when Clerk cannot be reached", async () => {
		sessionActive = "error";
		const cookie = await loginCookie({ checkedAt: clock - SESSION_RECHECK_MS - 1000 });
		const res = await send("/api/chats", { headers: { Cookie: cookie } });
		assert.equal(res.status, 503);
		assert.equal(res.headers.get("set-cookie"), null);
		assert.equal(tenantHits.length, 0);
	});
});

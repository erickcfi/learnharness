/**
 * Public pages through the front door's gateway (W2-11).
 *
 * With no login: "/" shows the landing page, and How it works, Help, the
 * legal pages, robots.txt and sitemap.xml come from the front door's app.
 * Everything else is still closed: every /api route answers 401 (the C1
 * test, repeated here on purpose) and other pages redirect to sign-in.
 * With a login, "/" is still the student's tutor.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ClerkGateway } from "../frontdoor/gateway/auth.ts";
import { createGateway } from "../frontdoor/gateway/handler.ts";
import { SESSION_COOKIE, signSession } from "../frontdoor/gateway/session.ts";
import { BRAND_ICON_PATH, isAlwaysPublicPath, LEGAL_PATHS, OG_IMAGE_PATH, PUBLIC_PAGES, SIGN_UP_PATH } from "../frontdoor/marketing/public-paths.ts";
import { InMemoryAccountStore } from "../frontdoor/tenants/accounts.ts";

const SECRET = new TextEncoder().encode("landing-gateway-test-secret-0123456789ab");
const REPO = path.join(import.meta.dirname, "..");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const clock = Date.parse("2026-11-08T12:00:00Z");

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

const clerk: ClerkGateway = {
	authenticate: async () => ({ status: "signed-out" }),
	isSessionActive: async () => true,
};

const tenantHits: string[] = [];
const appHits: string[] = [];
let tenant: Server;
let gateway: Server;
let base = "";
const accounts = new InMemoryAccountStore();
let tenantId = "";

before(async () => {
	tenant = createServer((req, res) => {
		tenantHits.push(req.url ?? "");
		res.end("from tenant");
	});
	await new Promise<void>((r) => tenant.listen(0, "127.0.0.1", r));
	const tenantPort = (tenant.address() as AddressInfo).port;
	await accounts.confirmAge("user_a", new Date(clock));
	tenantId = await accounts.assignTenant("user_a");

	gateway = createServer(
		createGateway({
			accounts,
			clerk,
			supervisor: { ensureRunning: async () => tenantPort },
			provision: async () => {},
			sessionSecret: SECRET,
			secureCookies: false,
			trustForwardedHeaders: false,
			frontDoorApp: (req, res) => {
				appHits.push(req.url ?? "");
				res.setHeader("X-Front-Door-App", "1");
				res.end("front door page");
			},
			now: () => clock,
		}),
	);
	await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise((r) => gateway.close(r));
	await new Promise((r) => tenant.close(r));
});

beforeEach(() => {
	tenantHits.length = 0;
	appHits.length = 0;
});

const loginCookie = async () => `${SESSION_COOKIE}=${await signSession({ userId: "user_a", sessionId: "sess_1", tenantId, checkedAt: clock }, SECRET, clock)}`;
const send = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { redirect: "manual", ...init });
const fromApp = (res: Response) => res.headers.get("x-front-door-app") === "1";

/** A raw request, so "..", "%2e%2e" and "//" reach the gateway as typed. */
const raw = (p: string, method = "GET") =>
	new Promise<{ status: number; frontDoorApp: boolean }>((resolve, reject) => {
		const req = request(`${base}/`, { path: p, method }, (res) => {
			res.resume();
			resolve({ status: res.statusCode ?? 0, frontDoorApp: res.headers["x-front-door-app"] === "1" });
		});
		req.on("error", reject);
		req.end();
	});

describe("landing page at /", () => {
	it("shows a visitor with no login the front door's landing page", async () => {
		for (const method of ["GET", "HEAD"]) {
			const res = await send("/", { method });
			assert.equal(res.status, 200, method);
			assert.ok(fromApp(res), method);
		}
		assert.deepEqual(appHits, ["/", "/"]);
		assert.equal(tenantHits.length, 0);
	});

	it("keeps the query string for the front door's app", async () => {
		const res = await send("/?_rsc=abc");
		assert.ok(fromApp(res));
		assert.deepEqual(appHits, ["/?_rsc=abc"]);
	});

	it("sends a signed-in student straight to their tutor", async () => {
		const res = await send("/", { headers: { Cookie: await loginCookie() } });
		assert.equal(await res.text(), "from tenant");
		assert.deepEqual(tenantHits, ["/"]);
		assert.equal(appHits.length, 0);
	});

	it("treats a forged login cookie as no login", async () => {
		const res = await send("/", { headers: { Cookie: `${SESSION_COOKIE}=forged` } });
		assert.ok(fromApp(res));
		assert.equal(tenantHits.length, 0);
	});

	it("does not show the landing page for other methods", async () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			const res = await send("/", { method, body: "{}" });
			assert.equal(res.status, 401, method);
			assert.equal(fromApp(res), false, method);
		}
		assert.equal(tenantHits.length, 0);
	});

	it("sends a visitor still signed in to Clerk to sign-in, which forwards them to their tutor", async () => {
		const res = await send("/", { headers: { Cookie: "__client_uat=1762603200" } });
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), `/account/sign-in?next=${encodeURIComponent("/")}`);
		assert.equal(appHits.length, 0);
	});

	it("shows the landing page when Clerk's cookie says signed out", async () => {
		for (const cookie of ["__client_uat=0", "__client_uat_AbC123=0", "__client_uat="]) {
			const res = await send("/", { headers: { Cookie: cookie } });
			assert.ok(fromApp(res), cookie);
		}
		const suffixed = await send("/", { headers: { Cookie: "__client_uat_AbC123=1762603200" } });
		assert.equal(suffixed.status, 302);
	});
});

describe("pages that are always public", () => {
	const always = [...PUBLIC_PAGES.filter((p) => p !== "/"), "/robots.txt", "/sitemap.xml"];

	it("lists the pages the brief names", () => {
		assert.deepEqual([...PUBLIC_PAGES].sort(), ["/", "/help", "/how-it-works", LEGAL_PATHS.aiNotice, LEGAL_PATHS.privacy, LEGAL_PATHS.terms, LEGAL_PATHS.license].sort());
	});

	it("serves them from the front door's app with no login", async () => {
		for (const p of always) {
			const res = await send(p);
			assert.equal(res.status, 200, p);
			assert.ok(fromApp(res), p);
		}
		assert.equal(tenantHits.length, 0);
	});

	it("serves them from the front door's app with a login too", async () => {
		const cookie = await loginCookie();
		for (const p of always) {
			const res = await send(p, { headers: { Cookie: cookie } });
			assert.ok(fromApp(res), p);
		}
		assert.equal(tenantHits.length, 0);
	});

	it("accepts one trailing slash and any page under /legal/", async () => {
		for (const p of ["/help/", "/how-it-works/", "/legal/terms/", "/legal/cookies"]) {
			assert.ok(fromApp(await send(p)), p);
		}
	});

	it("serves the icon and the share image from the front door's app", async () => {
		for (const p of [BRAND_ICON_PATH, OG_IMAGE_PATH]) assert.ok(fromApp(await send(p)), p);
	});

	it("keeps look-alike paths closed", async () => {
		for (const p of ["/helpdesk", "/help/x", "/how-it-works/x", "/legal", "/legalese", "/robots.txt/x", "/HELP", "/%68elp", "/chat/abc"]) {
			assert.equal(isAlwaysPublicPath(new URL(p, "http://x").pathname), false, p);
			const res = await send(p);
			assert.equal(fromApp(res), false, p);
			assert.equal(res.status, 302, p);
			assert.match(res.headers.get("location") ?? "", /^\/account\/sign-in\?next=/, p);
		}
		assert.equal(tenantHits.length, 0);
	});

	it("does not let path tricks through a public page reach the tenant", async () => {
		for (const p of ["/help/../api/keys", "/legal/%2e%2e/api/keys", "/how-it-works/./../api/keys", "//help"]) {
			const res = await raw(p);
			assert.equal(res.frontDoorApp, false, p);
			assert.ok(res.status === 401 || res.status === 302, `${p} → ${res.status}`);
		}
		assert.equal(tenantHits.length, 0);
	});

	it("only answers GET and HEAD from the front door's app", async () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			const res = await send("/help", { method, body: "x" });
			assert.equal(fromApp(res), false, method);
			assert.equal(res.status, 401, method);
		}
	});
});

describe("everything else still needs a login", () => {
	it("returns 401 for every /api route and method, and never reaches the tenant", async () => {
		const routes = apiRoutePaths();
		assert.ok(routes.length >= 20, `expected the app/api route files, found ${routes.length}`);
		const failures: string[] = [];
		for (const route of ["/api", "/api/", ...routes]) {
			for (const method of METHODS) {
				for (const cookie of [undefined, "__client_uat=0", "__client_uat=1762603200"]) {
					const res = await send(route, { method, body: method === "GET" ? undefined : "{}", headers: cookie ? { Cookie: cookie } : {} });
					const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
					if (res.status !== 401 || typeof body?.error !== "string" || fromApp(res)) failures.push(`${method} ${route} (${cookie ?? "no cookie"}) → ${res.status}`);
				}
			}
		}
		assert.deepEqual(failures, []);
		assert.equal(tenantHits.length, 0);
		assert.equal(appHits.length, 0);
	});

	it("the sign-up button's target is a front door page", async () => {
		const res = await send(SIGN_UP_PATH);
		assert.ok(fromApp(res));
		assert.deepEqual(appHits, [SIGN_UP_PATH]);
	});
});

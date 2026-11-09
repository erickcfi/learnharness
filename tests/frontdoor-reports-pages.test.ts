/**
 * The report settings page and the unsubscribe page, through the front
 * door's gateway (W2-10; C6 req 3, N12, P6-05).
 *
 *  - Settings need the front door login; both reports start off; the
 *    address box starts with the login email.
 *  - Unsubscribe works with no login: the link opens a page with one
 *    button, which turns the report off. Mail apps' one-click POST
 *    (RFC 8058) works too.
 *  - The login gate is unchanged: every /api route still answers 401 with
 *    no login (the C1 test, repeated with the report pages in place).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import type { ClerkGateway } from "../frontdoor/gateway/auth.ts";
import { createGateway } from "../frontdoor/gateway/handler.ts";
import { SESSION_COOKIE, SESSION_RECHECK_MS, signSession } from "../frontdoor/gateway/session.ts";
import { createReportPages } from "../frontdoor/reports/pages.ts";
import { MemoryStudentDirectory } from "../frontdoor/reports/students.ts";
import { SupabaseAccountStore } from "../frontdoor/tenants/supabase-accounts.ts";

const SECRET = new TextEncoder().encode("report-pages-test-secret-0123456789abcdef");
const REPO = path.join(import.meta.dirname, "..");
const clock = Date.parse("2026-11-08T12:00:00Z");

let t: TestDb;
let tenantServer: Server;
let gateway: Server;
let base = "";
let clerkActive = true;
const tenantHits: string[] = [];
const appHits: string[] = [];
const students = new MemoryStudentDirectory();
let tenantId = "";
let token = "";

const clerk: ClerkGateway = {
	authenticate: async () => ({ status: "signed-out" }),
	isSessionActive: async () => clerkActive,
};

before(async () => {
	t = await createTestDb();
	const accounts = new SupabaseAccountStore(t.db);
	await accounts.confirmAge("user_rp", new Date(clock));
	tenantId = await accounts.assignTenant("user_rp");
	students.set(tenantId, { name: "Jane Doe", email: "jane@example.com" });
	token = (await dbm.getReportSettings(t.db, tenantId)).unsubscribeToken;

	tenantServer = createServer((req, res) => {
		tenantHits.push(req.url ?? "");
		res.end("from tenant");
	});
	await new Promise<void>((r) => tenantServer.listen(0, "127.0.0.1", r));
	const tenantPort = (tenantServer.address() as AddressInfo).port;

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
				res.end("front door page");
			},
			reportPages: createReportPages({
				db: t.db,
				students,
				accounts,
				clerk,
				sessionSecret: SECRET,
				secureCookies: false,
				trustForwardedHeaders: false,
				emailMode: "memory",
				now: () => clock,
			}),
			now: () => clock,
		}),
	);
	await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise((r) => gateway.close(r));
	await new Promise((r) => tenantServer.close(r));
	await t.close();
});

beforeEach(async () => {
	tenantHits.length = 0;
	appHits.length = 0;
	clerkActive = true;
	await dbm.updateReportSettings(t.db, tenantId, { sessionReportEnabled: false, weeklyReportEnabled: false, reportEmail: null });
});

interface Answer {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

function call(p: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const req = request(`${base}/`, { path: p, method: options.method ?? "GET", headers: options.headers ?? {} }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end(options.body);
	});
}

const loginCookie = async (checkedAt = clock) => `${SESSION_COOKIE}=${await signSession({ userId: "user_rp", sessionId: "sess_rp", tenantId, checkedAt }, SECRET, clock)}`;
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const settings = () => dbm.getReportSettings(t.db, tenantId);

describe("report settings page (/account/reports)", () => {
	it("sends a visitor with no login to sign-in, and never to the tutor or Next.js", async () => {
		const res = await call("/account/reports");
		assert.equal(res.status, 302);
		assert.equal(res.headers.location, `/account/sign-in?next=${encodeURIComponent("/account/reports")}`);
		const post = await call("/account/reports", { method: "POST", headers: { ...FORM, Origin: base }, body: form({ email: "x@example.com", session: "on" }) });
		assert.equal(post.status, 302);
		assert.equal((await settings()).sessionReportEnabled, false);
		assert.equal(tenantHits.length + appHits.length, 0);
	});

	it("shows both reports off, with the login email in the address box", async () => {
		const res = await call("/account/reports", { headers: { Cookie: await loginCookie() } });
		assert.equal(res.status, 200);
		assert.match(String(res.headers["content-type"]), /text\/html/);
		assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
		assert.match(res.body, /<h1>Email reports<\/h1>/);
		assert.match(res.body, /name="email"[^>]*value="jane@example\.com"/);
		assert.doesNotMatch(res.body, /name="session"[^>]*checked/);
		assert.doesNotMatch(res.body, /name="weekly"[^>]*checked/);
		assert.match(res.body, /Self-study record\. Not a logbook entry or instructor endorsement\./);
		assert.doesNotMatch(res.body, /<script/i);
		assert.equal(tenantHits.length + appHits.length, 0);
	});

	it("saves a report turned on with an address, then shows it", async () => {
		const cookie = await loginCookie();
		const res = await call("/account/reports", { method: "POST", headers: { ...FORM, Cookie: cookie, Origin: base }, body: form({ email: " CFI@Example.com ", session: "on" }) });
		assert.equal(res.status, 303);
		assert.equal(res.headers.location, "/account/reports?saved=1");
		const s = await settings();
		assert.equal(s.sessionReportEnabled, true);
		assert.equal(s.weeklyReportEnabled, false);
		assert.equal(s.reportEmail, "CFI@example.com");
		const page = await call("/account/reports?saved=1", { headers: { Cookie: cookie } });
		assert.match(page.body, /Saved\./);
		assert.match(page.body, /value="CFI@example\.com"/);
		assert.match(page.body, /name="session"[^>]*checked/);
	});

	it("turns both off and keeps the address", async () => {
		const cookie = await loginCookie();
		await dbm.updateReportSettings(t.db, tenantId, { sessionReportEnabled: true, weeklyReportEnabled: true, reportEmail: "cfi@example.com" });
		const res = await call("/account/reports", { method: "POST", headers: { ...FORM, Cookie: cookie, Origin: base }, body: form({ email: "cfi@example.com" }) });
		assert.equal(res.status, 303);
		const s = await settings();
		assert.deepEqual([s.sessionReportEnabled, s.weeklyReportEnabled, s.reportEmail], [false, false, "cfi@example.com"]);
	});

	it("refuses a report turned on with no address or a bad one, and changes nothing", async () => {
		const cookie = await loginCookie();
		const empty = await call("/account/reports", { method: "POST", headers: { ...FORM, Cookie: cookie, Origin: base }, body: form({ email: "", weekly: "on" }) });
		assert.equal(empty.status, 400);
		assert.match(empty.body, /Enter an email address to turn a report on\./);
		const bad = await call("/account/reports", { method: "POST", headers: { ...FORM, Cookie: cookie, Origin: base }, body: form({ email: "a@b.com, c@d.com", session: "on" }) });
		assert.equal(bad.status, 400);
		assert.match(bad.body, /does not look right/);
		assert.match(bad.body, /value="a@b\.com, c@d\.com"/);
		const s = await settings();
		assert.deepEqual([s.sessionReportEnabled, s.weeklyReportEnabled, s.reportEmail], [false, false, null]);
	});

	it("refuses a save from another site", async () => {
		const cookie = await loginCookie();
		const res = await call("/account/reports", { method: "POST", headers: { ...FORM, Cookie: cookie, Origin: "https://evil.example" }, body: form({ email: "x@example.com", session: "on" }) });
		assert.equal(res.status, 403);
		const site = await call("/account/reports", { method: "POST", headers: { ...FORM, Cookie: cookie, "Sec-Fetch-Site": "cross-site" }, body: form({ email: "x@example.com", session: "on" }) });
		assert.equal(site.status, 403);
		assert.equal((await settings()).sessionReportEnabled, false);
	});

	it("re-checks an old login with Clerk, like the tutor does", async () => {
		const stale = await loginCookie(clock - SESSION_RECHECK_MS - 1000);
		const ok = await call("/account/reports", { headers: { Cookie: stale } });
		assert.equal(ok.status, 200);
		assert.match(String(ok.headers["set-cookie"]), new RegExp(`^${SESSION_COOKIE}=`));
		clerkActive = false;
		const out = await call("/account/reports", { headers: { Cookie: stale } });
		assert.equal(out.status, 302);
		assert.match(String(out.headers.location), /^\/account\/sign-in/);
		assert.match(String(out.headers["set-cookie"]), new RegExp(`^${SESSION_COOKIE}=;`));
	});

	it("answers 405 for other methods", async () => {
		const res = await call("/account/reports", { method: "PUT", headers: { Cookie: await loginCookie() } });
		assert.equal(res.status, 405);
	});
});

describe("unsubscribe (/account/unsubscribe), no login", () => {
	it("opens a page with a button and changes nothing by itself (mail scanners open links)", async () => {
		await dbm.updateReportSettings(t.db, tenantId, { sessionReportEnabled: true, reportEmail: "cfi@example.com" });
		const res = await call(`/account/unsubscribe?t=${token}&k=session`);
		assert.equal(res.status, 200);
		assert.match(res.body, /<form method="post" action="\/account\/unsubscribe\?t=[0-9a-f]+&amp;k=session">/);
		assert.match(res.body, /name="scope" value="session"/);
		assert.match(res.body, /name="scope" value="all"/);
		assert.equal((await settings()).sessionReportEnabled, true);
		assert.ok(!res.body.includes("cfi@example.com"), "the page shows no address");
		assert.equal(res.headers["referrer-policy"], "no-referrer");
	});

	it("turns the session report off and leaves the weekly report on", async () => {
		await dbm.updateReportSettings(t.db, tenantId, { sessionReportEnabled: true, weeklyReportEnabled: true, reportEmail: "cfi@example.com" });
		const res = await call(`/account/unsubscribe?t=${token}&k=session`, { method: "POST", headers: FORM, body: form({ scope: "session" }) });
		assert.equal(res.status, 200);
		assert.match(res.body, /Done\. Session reports are off\./);
		const s = await settings();
		assert.deepEqual([s.sessionReportEnabled, s.weeklyReportEnabled], [false, true]);
	});

	it("turns all reports off with the second button", async () => {
		await dbm.updateReportSettings(t.db, tenantId, { sessionReportEnabled: true, weeklyReportEnabled: true, reportEmail: "cfi@example.com" });
		const res = await call(`/account/unsubscribe?t=${token}&k=weekly`, { method: "POST", headers: FORM, body: form({ scope: "all" }) });
		assert.match(res.body, /All email reports are off/);
		const s = await settings();
		assert.deepEqual([s.sessionReportEnabled, s.weeklyReportEnabled], [false, false]);
	});

	it("takes a mail app's one-click POST (RFC 8058) for the report the email was for", async () => {
		await dbm.updateReportSettings(t.db, tenantId, { sessionReportEnabled: true, weeklyReportEnabled: true, reportEmail: "cfi@example.com" });
		const res = await call(`/account/unsubscribe?t=${token}&k=weekly`, { method: "POST", headers: { ...FORM, Origin: "https://mail.google.com" }, body: "List-Unsubscribe=One-Click" });
		assert.equal(res.status, 200);
		const s = await settings();
		assert.deepEqual([s.sessionReportEnabled, s.weeklyReportEnabled], [true, false]);
	});

	it("says the link does not work for an unknown or malformed token", async () => {
		for (const bad of ["0".repeat(64), "short", "x'; drop table report_settings; --"]) {
			const page = await call(`/account/unsubscribe?t=${encodeURIComponent(bad)}&k=session`);
			assert.equal(page.status, 404, bad);
			assert.match(page.body, /This link does not work/);
			const post = await call(`/account/unsubscribe?t=${encodeURIComponent(bad)}&k=session`, { method: "POST", headers: FORM, body: form({ scope: "all" }) });
			assert.equal(post.status, 404, bad);
		}
		assert.equal(tenantHits.length + appHits.length, 0, "never the tutor or Next.js");
	});
});

describe("the login gate is unchanged", () => {
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

	it("answers 401 on every /api route with no login, for every method", async () => {
		const paths = apiRoutePaths();
		assert.ok(paths.length > 20, "found the api routes");
		for (const p of paths) {
			for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
				const res = await call(p, { method });
				assert.equal(res.status, 401, `${method} ${p}`);
			}
		}
		assert.equal(tenantHits.length, 0);
	});

	it("does not open look-alike paths", async () => {
		for (const p of ["/api/account/reports", "/account/unsubscribe/../../api/keys", "/account/reports/../../api/keys"]) {
			assert.equal((await call(p)).status, 401, p);
		}
		assert.equal((await call("/reports")).status, 302, "a tutor page: sign in first");
		const next = await call("/account/reportsx");
		assert.equal(next.body, "front door page", "other /account paths still go to Next.js");
		assert.deepEqual(appHits, ["/account/reportsx"]);
		assert.equal(tenantHits.length, 0);
	});
});

describe("without a database (a local run)", () => {
	it("says the pages are unavailable", async () => {
		const pages = createReportPages({ db: null, accounts: { get: async () => null }, clerk, sessionSecret: SECRET, secureCookies: false, trustForwardedHeaders: false, emailMode: "memory" });
		const server = createServer((req, res) => void pages(req, res, new URL(`http://x${req.url}`)));
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as AddressInfo).port;
		const res = await fetch(`http://127.0.0.1:${port}/account/reports`);
		assert.equal(res.status, 503);
		await new Promise((r) => server.close(r));
	});
});

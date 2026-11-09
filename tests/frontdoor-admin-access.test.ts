/**
 * P3-01: roles and the /admin shell (C7 req 1, D27; C7 acceptance test "A
 * student gets 403 on every /admin route").
 *
 * Only the Owner reaches /admin. Every page and every API route refuses
 * anyone else on the server, before any data is read or any action runs.
 * /admin is in no sitemap and no robots.txt, and every answer says noindex.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { can, PERMISSIONS, ROLE_PERMISSIONS } from "../frontdoor/admin/roles.ts";
import * as dbm from "../frontdoor/db/index.ts";
import robots from "../frontdoor/app/robots.ts";
import sitemap from "../frontdoor/app/sitemap.ts";
import { type Fixture, SECRET, startFixture } from "./frontdoor-admin-fixture.ts";
import { SESSION_COOKIE, SESSION_RECHECK_MS, signSession } from "../frontdoor/gateway/session.ts";

const REPO = path.join(import.meta.dirname, "..");
const SAMPLE_UUID = "11111111-1111-4111-8111-111111111111";

/** Every page under frontdoor/app/admin, as a URL ([tenantId] and friends get sample values). */
function adminPagePaths(): string[] {
	const root = path.join(REPO, "frontdoor", "app", "admin");
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.name === "page.tsx" || e.name === "route.ts") {
				const rel = path.relative(path.join(REPO, "frontdoor", "app"), dir).split(path.sep).join("/");
				out.push(`/${rel}`.replace(/\[tenantId\]/g, SAMPLE_UUID).replace(/\[chatId\]/g, "chat_x_1").replace(/\[[^\]]+\]/g, "x"));
			}
		}
	};
	walk(root);
	return out.sort();
}

/** Every API route the dashboard handler serves (frontdoor/admin/handler.ts). */
const API_ROUTES: Array<[string, string]> = [
	["GET", "/admin/api/overview"],
	["GET", `/admin/api/tenants/${SAMPLE_UUID}`],
	["GET", `/admin/api/tenants/${SAMPLE_UUID}/sessions/chat_x_1/text`],
	["POST", `/admin/api/tenants/${SAMPLE_UUID}/pause`],
	["POST", `/admin/api/tenants/${SAMPLE_UUID}/unpause`],
	["POST", `/admin/api/tenants/${SAMPLE_UUID}/consents/tester`],
	["POST", `/admin/api/tenants/${SAMPLE_UUID}/consents/tester/revoke`],
	["POST", "/admin/api/alerts/1/clear"],
	["POST", "/admin/api/thresholds"],
	["GET", "/admin/api/library"],
	["PUT", "/admin/api/library?area=faa&name=x.txt"],
	["POST", "/admin/api/library/remove"],
	["GET", "/admin/api/nope"],
];

let f: Fixture;
let student: { tenantId: string; clerkUserId: string; accountId: string };
let staff: { accountId: string; clerkUserId: string };

before(async () => {
	f = await startFixture();
	student = await f.student("access_student");
	const staffAccount = await dbm.createAccount(f.db, { clerkUserId: "user_staff", age18ConfirmedAt: new Date("2026-11-01T00:00:00Z") });
	await dbm.grantRole(f.db, { accountId: staffAccount.id, role: "staff", grantedBy: f.owner.accountId });
	staff = { accountId: staffAccount.id, clerkUserId: "user_staff" };
	fs.writeFileSync(path.join(f.libraryDir, "keep.txt"), "x");
	fs.mkdirSync(path.join(f.libraryDir, "faa"), { recursive: true });
	fs.writeFileSync(path.join(f.libraryDir, "faa", "keep.txt"), "x");
});
after(async () => {
	await f.close();
});
beforeEach(() => {
	f.pageHits.length = 0;
	f.tenantHits.length = 0;
	f.pause.calls.length = 0;
});

async function call(method: string, p: string, cookie?: string, extra: Record<string, string> = {}): Promise<Response> {
	const body = method === "GET" || method === "HEAD" ? undefined : method === "PUT" ? "hello" : "confirm=yes&path=faa%2Fkeep.txt&alertUsd=1&autopauseUsd=2&note=x";
	return fetch(`${f.base}${p}`, {
		method,
		redirect: "manual",
		headers: {
			...(cookie ? { Cookie: cookie } : {}),
			...(body && method !== "PUT" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
			Origin: f.base,
			...extra,
		},
		body,
	});
}

function assertNothingHappened() {
	assert.deepEqual(f.pageHits, [], "no admin page was rendered");
	assert.deepEqual(f.tenantHits, [], "no tenant server was asked");
	assert.deepEqual(f.pause.calls, [], "no pause or unpause ran");
	assert.ok(fs.existsSync(path.join(f.libraryDir, "faa", "keep.txt")), "the library file is still there");
	assert.ok(!fs.existsSync(path.join(f.libraryDir, "faa", "x.txt")), "no file was uploaded");
}

describe("the role model (D27)", () => {
	it("the Owner has every permission; Staff launches with none; no role means student", () => {
		for (const p of PERMISSIONS) {
			assert.equal(can(["owner"], p), true, p);
			assert.equal(can(["staff"], p), false, p);
			assert.equal(can([], p), false, p);
		}
		assert.deepEqual(ROLE_PERMISSIONS.staff, []);
	});
});

describe("the dashboard has pages to check", () => {
	it("finds the admin pages", () => {
		const pages = adminPagePaths();
		for (const p of ["/admin", "/admin/library", "/admin/settings", `/admin/students/${SAMPLE_UUID}`]) assert.ok(pages.includes(p), `${p} in ${pages.join(", ")}`);
	});
	it("keeps all dashboard actions in the server's checked handler, none as Next.js route files", () => {
		assert.deepEqual(
			adminPagePaths().filter((p) => fs.existsSync(path.join(REPO, "frontdoor", "app", p.replace(SAMPLE_UUID, "[tenantId]").replace("chat_x_1", "[chatId]"), "route.ts"))),
			[],
		);
	});
});

describe("no login", () => {
	it("every admin page redirects to sign-in", async () => {
		for (const p of adminPagePaths()) {
			const res = await call("GET", p);
			assert.equal(res.status, 302, p);
			assert.equal(res.headers.get("location"), `/account/sign-in?next=${encodeURIComponent(p)}`, p);
		}
		assertNothingHappened();
	});
	it("every admin API route gets 401", async () => {
		for (const [method, p] of API_ROUTES) assert.equal((await call(method, p)).status, 401, `${method} ${p}`);
		assertNothingHappened();
	});
	it("a forged or foreign login cookie counts as no login", async () => {
		const foreign = await signSession({ userId: "user_owner", sessionId: "s", tenantId: SAMPLE_UUID, checkedAt: f.clock.now }, new TextEncoder().encode("x".repeat(40)), f.clock.now);
		for (const cookie of [`${SESSION_COOKIE}=${foreign}`, `${SESSION_COOKIE}=not-a-token`]) {
			assert.equal((await call("GET", "/admin/api/overview", cookie)).status, 401);
			assert.equal((await call("GET", "/admin", cookie)).status, 302);
		}
		assertNothingHappened();
	});
});

describe("a student gets 403 on every /admin route (C7 acceptance test)", () => {
	it("every page", async () => {
		const cookie = await f.cookie(student.clerkUserId, { tenantId: student.tenantId });
		for (const p of adminPagePaths()) {
			const res = await call("GET", p, cookie);
			assert.equal(res.status, 403, p);
			assert.doesNotMatch(await res.text(), /admin page/);
		}
		assertNothingHappened();
	});
	it("every API route, with any method", async () => {
		const cookie = await f.cookie(student.clerkUserId, { tenantId: student.tenantId });
		for (const [method, p] of API_ROUTES) assert.equal((await call(method, p, cookie)).status, 403, `${method} ${p}`);
		for (const method of ["DELETE", "PATCH", "POST", "PUT"]) assert.equal((await call(method, "/admin", cookie)).status, 403, method);
		assertNothingHappened();
	});
	it("path tricks still land on the check", async () => {
		const cookie = await f.cookie(student.clerkUserId, { tenantId: student.tenantId });
		for (const p of ["/admin/", "/admin/../admin/api/overview", "/admin/%2e%2e/admin/api/overview", "/x/../admin", "/admin/api/overview?x=1"]) {
			assert.equal((await call("GET", p, cookie)).status, 403, p);
		}
		assertNothingHappened();
	});
});

describe("Staff, before the Owner grants it anything", () => {
	it("gets 403 everywhere", async () => {
		const cookie = await f.cookie(staff.clerkUserId);
		for (const p of adminPagePaths()) assert.equal((await call("GET", p, cookie)).status, 403, p);
		for (const [method, p] of API_ROUTES) assert.equal((await call(method, p, cookie)).status, 403, `${method} ${p}`);
		assertNothingHappened();
	});
});

describe("the Owner", () => {
	it("reaches every admin page, marked noindex and no-store", async () => {
		const cookie = await f.cookie(f.owner.clerkUserId);
		for (const p of adminPagePaths()) {
			const res = await call("GET", p, cookie);
			assert.equal(res.status, 200, p);
			assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow", p);
			assert.equal(res.headers.get("cache-control"), "no-store", p);
		}
		assert.deepEqual(f.pageHits, adminPagePaths());
	});
	it("reads the API", async () => {
		const res = await call("GET", "/admin/api/overview", await f.cookie(f.owner.clerkUserId));
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
	});
	it("loses access at once when the role is taken away", async () => {
		const acct = await dbm.createAccount(f.db, { clerkUserId: "user_owner_2", age18ConfirmedAt: new Date("2026-11-01T00:00:00Z") });
		await dbm.grantRole(f.db, { accountId: acct.id, role: "owner" });
		const cookie = await f.cookie("user_owner_2");
		assert.equal((await call("GET", "/admin/api/overview", cookie)).status, 200);
		await dbm.revokeRole(f.db, acct.id, "owner");
		assert.equal((await call("GET", "/admin/api/overview", cookie)).status, 403);
		assert.equal((await call("GET", "/admin", cookie)).status, 403);
	});
	it("a state change from another site is refused", async () => {
		const cookie = await f.cookie(f.owner.clerkUserId);
		const evil = await call("POST", `/admin/api/tenants/${student.tenantId}/pause`, cookie, { Origin: "https://evil.example" });
		assert.equal(evil.status, 403);
		const none = await fetch(`${f.base}/admin/api/tenants/${student.tenantId}/pause`, { method: "POST", headers: { Cookie: cookie } });
		assert.equal(none.status, 403);
		assert.deepEqual(f.pause.calls, []);
	});
	it("pages accept only GET and HEAD", async () => {
		assert.equal((await call("POST", "/admin", await f.cookie(f.owner.clerkUserId))).status, 405);
	});
});

describe("the 5-minute Clerk re-check applies to /admin too", () => {
	it("an ended Clerk session is signed out; Clerk down is 503; an active one renews the cookie", async () => {
		const stale = f.clock.now - SESSION_RECHECK_MS - 1000;
		const { createDashboard } = await import("../frontdoor/admin/wiring.ts");
		let state: boolean | "error" = false;
		const d = createDashboard({
			db: f.db,
			sessionSecret: SECRET,
			clerk: {
				isSessionActive: async () => {
					if (state === "error") throw new Error("Clerk down");
					return state;
				},
			},
			secureCookies: false,
			trustForwardedHeaders: false,
			frontDoorApp: (_req, res) => res.end("page"),
			supervisor: { ensureRunning: async () => 1 },
			libraryDir: f.libraryDir,
			tenantFetch: async () => new Response("[]"),
			now: () => f.clock.now,
		});
		const { createServer } = await import("node:http");
		const server = createServer((req, res) => void d.admin.handle(req, res, new URL(req.url ?? "/", "http://x")));
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/admin/api/overview`;
		const cookie = await f.cookie(f.owner.clerkUserId, { checkedAt: stale });
		try {
			assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 401);
			state = "error";
			assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 503);
			state = true;
			const ok = await fetch(url, { headers: { Cookie: cookie } });
			assert.equal(ok.status, 200);
			assert.ok(ok.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`)), "a renewed login cookie");
		} finally {
			await new Promise((r) => server.close(r));
			await d.close();
		}
	});
});

describe("making the Owner (one-time step, never hard-coded)", () => {
	it("grants the role only to an account that exists, and is safe to repeat", async () => {
		const { grantOwnerByClerkId, listRoleHolders } = await import("../frontdoor/admin/owner.ts");
		assert.deepEqual(await grantOwnerByClerkId(f.db, "user_neverSignedIn01"), { ok: false, reason: "no-account" });
		assert.deepEqual(await grantOwnerByClerkId(f.db, "not-a-clerk-id"), { ok: false, reason: "bad-id" });
		const acct = await dbm.createAccount(f.db, { clerkUserId: "user_erickTest0001", age18ConfirmedAt: new Date("2026-11-01T00:00:00Z") });
		const cookie = await f.cookie("user_erickTest0001");
		assert.equal((await call("GET", "/admin/api/overview", cookie)).status, 403, "no role yet");
		assert.deepEqual(await grantOwnerByClerkId(f.db, "user_erickTest0001"), { ok: true, accountId: acct.id, alreadyOwner: false });
		assert.deepEqual(await grantOwnerByClerkId(f.db, "user_erickTest0001"), { ok: true, accountId: acct.id, alreadyOwner: true });
		assert.equal((await call("GET", "/admin/api/overview", cookie)).status, 200);
		assert.ok((await listRoleHolders(f.db)).some((r) => r.clerkUserId === "user_erickTest0001" && r.role === "owner"));
	});
	it("no Clerk user id is written into the front door's code", () => {
		const roots = ["admin", "gateway", "wiring", "app"].map((d) => path.join(REPO, "frontdoor", d));
		const hits: string[] = [];
		const walk = (dir: string) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) walk(full);
				else if (/\.(ts|tsx)$/.test(e.name) && /["'`]user_[A-Za-z0-9]{8,}["'`]/.test(fs.readFileSync(full, "utf8"))) hits.push(full);
			}
		};
		roots.forEach(walk);
		assert.deepEqual(hits, []);
	});
});

describe("/admin stays out of search engines", () => {
	it("is in neither the sitemap nor robots.txt", () => {
		assert.ok(sitemap().every((entry) => !entry.url.includes("/admin")));
		assert.doesNotMatch(JSON.stringify(robots()), /admin/);
	});
});

/**
 * Sign-up, the 18+ checkbox, and the first login (PRD C1 req 2 and 5, D28).
 *
 * The Owner's choice (2026-11-08): the student ticks "I am 18 or older" on
 * the front door's sign-up page before Clerk's form appears. The tick is kept
 * in a short-lived signed cookie, saved with its date at the first login, and
 * no tenant is created without it. /account/start is where Clerk sends the
 * student after sign-in or sign-up: it checks the Clerk login, records the
 * tick, creates and provisions the tenant, starts its server, and sets the
 * front door's own login cookie.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ClerkAuthResult, ClerkGateway } from "../frontdoor/gateway/auth.ts";
import { createGateway } from "../frontdoor/gateway/handler.ts";
import { AGE_COOKIE, SESSION_COOKIE, signAgeConfirmation, verifyAgeConfirmation, verifySession } from "../frontdoor/gateway/session.ts";
import { InMemoryAccountStore } from "../frontdoor/tenants/accounts.ts";

const SECRET = new TextEncoder().encode("gateway-signup-test-secret-0123456789abc");
const clock = Date.parse("2026-11-08T12:00:00Z");

let clerkResult: ClerkAuthResult = { status: "signed-out" };
const clerk: ClerkGateway = {
	authenticate: async () => clerkResult,
	isSessionActive: async () => true,
};
let accounts = new InMemoryAccountStore();
let provisioned: string[] = [];
let started: string[] = [];
let gateway: Server;
let base = "";

before(async () => {
	const handler = createGateway({
		get accounts() {
			return accounts;
		},
		clerk,
		supervisor: {
			ensureRunning: async (tenantId: string) => {
				started.push(tenantId);
				return 1;
			},
		},
		provision: async (tenantId: string) => {
			provisioned.push(tenantId);
		},
		sessionSecret: SECRET,
		secureCookies: false,
		trustForwardedHeaders: false,
		frontDoorApp: (_req, res) => {
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
});

beforeEach(() => {
	accounts = new InMemoryAccountStore();
	provisioned = [];
	started = [];
	clerkResult = { status: "signed-out" };
});

const send = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { redirect: "manual", ...init });
const postForm = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
	send("/account/age", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, ...headers },
		body: new URLSearchParams(fields).toString(),
	});
const cookieValue = (setCookie: string | null, name: string) => new RegExp(`${name}=([^;]*)`).exec(setCookie ?? "")?.[1];

describe("the 18+ checkbox", () => {
	it("a ticked box sets the signed age cookie and returns to the sign-up page", async () => {
		const res = await postForm({ over18: "yes", next: "/account/sign-up" });
		assert.equal(res.status, 303);
		assert.equal(res.headers.get("location"), "/account/sign-up");
		const token = cookieValue(res.headers.get("set-cookie"), AGE_COOKIE);
		assert.equal(await verifyAgeConfirmation(token, SECRET, clock), clock);
		assert.match(res.headers.get("set-cookie") ?? "", /HttpOnly/i);
	});

	it("an unticked box sets nothing and asks again", async () => {
		const res = await postForm({ next: "/account/sign-up" });
		assert.equal(res.status, 303);
		assert.equal(res.headers.get("location"), "/account/sign-up?age=required");
		assert.equal(res.headers.get("set-cookie"), null);
	});

	it("only returns to front door pages", async () => {
		for (const next of ["https://evil.example/", "//evil.example/", "/chat/1", "/account/../api/keys"]) {
			const res = await postForm({ over18: "yes", next });
			assert.equal(res.headers.get("location"), "/account/sign-up", next);
		}
	});

	it("refuses a form posted from another site", async () => {
		const res = await postForm({ over18: "yes", next: "/account/sign-up" }, { Origin: "https://evil.example" });
		assert.equal(res.status, 403);
		assert.equal(res.headers.get("set-cookie"), null);
	});
});

describe("/account/start: the first login", () => {
	const signedIn: ClerkAuthResult = { status: "signed-in", userId: "user_new", sessionId: "sess_9" };

	it("sends a signed-out visitor to sign-in", async () => {
		const res = await send("/account/start");
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), "/account/sign-in");
	});

	it("follows Clerk's handshake redirect", async () => {
		clerkResult = { status: "handshake", headers: new Headers({ Location: "https://clerk.example/v1/client/handshake?x=1" }) };
		const res = await send("/account/start");
		assert.equal(res.status, 307);
		assert.equal(res.headers.get("location"), "https://clerk.example/v1/client/handshake?x=1");
	});

	it("without the 18+ tick: asks for it, and creates no tenant", async () => {
		clerkResult = signedIn;
		const res = await send("/account/start?next=%2Fchat%2F1");
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), `/account/confirm-age?next=${encodeURIComponent("/chat/1")}`);
		assert.equal((await accounts.get("user_new"))?.tenantId ?? null, null);
		assert.deepEqual(provisioned, []);
		assert.deepEqual(started, []);
		assert.equal(cookieValue(res.headers.get("set-cookie"), SESSION_COOKIE), undefined);
	});

	it("with the 18+ tick: saves it with its date, creates the tenant, starts its server, and logs in", async () => {
		clerkResult = signedIn;
		const tickedAt = clock - 60_000;
		const age = await signAgeConfirmation(tickedAt, SECRET);
		const res = await send("/account/start?next=%2Fchat%2F1", { headers: { Cookie: `${AGE_COOKIE}=${age}` } });
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), "/chat/1");

		const account = await accounts.get("user_new");
		assert.equal(account?.ageConfirmedAt?.getTime(), tickedAt);
		assert.ok(account?.tenantId);
		assert.deepEqual(provisioned, [account.tenantId]);
		assert.deepEqual(started, [account.tenantId]);

		const setCookie = res.headers.getSetCookie();
		const session = await verifySession(cookieValue(setCookie.find((c) => c.startsWith(SESSION_COOKIE)) ?? null, SESSION_COOKIE), SECRET, clock);
		assert.deepEqual(session, { userId: "user_new", sessionId: "sess_9", tenantId: account.tenantId, checkedAt: clock });
		assert.ok(setCookie.some((c) => c.startsWith(`${AGE_COOKIE}=;`) && /Max-Age=0/i.test(c)), "the age cookie is cleared");
	});

	it("a returning student needs no new tick and keeps the same tenant", async () => {
		clerkResult = signedIn;
		await accounts.confirmAge("user_new", new Date(clock - 86_400_000));
		const first = await accounts.assignTenant("user_new");
		const res = await send("/account/start");
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), "/");
		assert.equal((await accounts.get("user_new"))?.tenantId, first);
		assert.deepEqual(started, [first]);
	});

	it("never redirects off the site or back into /account after login", async () => {
		clerkResult = signedIn;
		await accounts.confirmAge("user_new", new Date(clock));
		for (const next of ["//evil.example/x", "https://evil.example/", "/account/start", "/\\evil.example"]) {
			const res = await send(`/account/start?next=${encodeURIComponent(next)}`);
			assert.equal(res.headers.get("location"), "/", next);
		}
	});

	it("answers 503 when the tenant server cannot start", async () => {
		const handler = createGateway({
			accounts,
			clerk: { authenticate: async () => signedIn, isSessionActive: async () => true },
			supervisor: {
				ensureRunning: async () => {
					throw new Error("start failed");
				},
			},
			provision: async () => {},
			sessionSecret: SECRET,
			secureCookies: false,
			trustForwardedHeaders: false,
			frontDoorApp: (_req, res) => res.end(),
			now: () => clock,
		});
		const server = createServer(handler);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		await accounts.confirmAge("user_new", new Date(clock));
		const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/account/start`, { redirect: "manual" });
		assert.equal(res.status, 503);
		assert.equal(cookieValue(res.headers.get("set-cookie"), SESSION_COOKIE), undefined);
		await new Promise((r) => server.close(r));
	});
});

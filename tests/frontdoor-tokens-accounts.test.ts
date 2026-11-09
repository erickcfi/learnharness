/**
 * Front door building blocks: the signed login and age cookies, the accounts
 * store (in-memory until w1-database's Supabase adapter), cookie handling,
 * safe return paths, and configuration.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../frontdoor/gateway/config.ts";
import { parseCookies, stripLoginCookies } from "../frontdoor/gateway/cookies.ts";
import { safeReturnPath } from "../frontdoor/gateway/return-path.ts";
import { signAgeConfirmation, signSession, verifyAgeConfirmation, verifySession } from "../frontdoor/gateway/session.ts";
import { AgeNotConfirmedError, InMemoryAccountStore } from "../frontdoor/tenants/accounts.ts";

const SECRET = new TextEncoder().encode("tokens-test-secret-0123456789abcdefghijk");
const now = Date.parse("2026-11-08T12:00:00Z");
const session = { userId: "user_1", sessionId: "sess_1", tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", checkedAt: now };

describe("login and age cookies", () => {
	it("a login token round-trips", async () => {
		assert.deepEqual(await verifySession(await signSession(session, SECRET, now), SECRET, now), session);
	});

	it("a login token expires after 7 days", async () => {
		const token = await signSession(session, SECRET, now);
		assert.ok(await verifySession(token, SECRET, now + 6 * 86_400_000));
		assert.equal(await verifySession(token, SECRET, now + 7 * 86_400_000 + 60_000), null);
	});

	it("an age token lasts one hour", async () => {
		const token = await signAgeConfirmation(now, SECRET);
		assert.equal(await verifyAgeConfirmation(token, SECRET, now + 59 * 60_000), now);
		assert.equal(await verifyAgeConfirmation(token, SECRET, now + 61 * 60_000), null);
	});

	it("one kind of token never passes as the other", async () => {
		assert.equal(await verifySession(await signAgeConfirmation(now, SECRET), SECRET, now), null);
		assert.equal(await verifyAgeConfirmation(await signSession(session, SECRET, now), SECRET, now), null);
	});

	it("rejects missing, garbled, and unsigned tokens", async () => {
		const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "user_1" })).toString("base64url")}.`;
		for (const token of [undefined, "", "garbage", unsigned]) {
			assert.equal(await verifySession(token, SECRET, now), null);
			assert.equal(await verifyAgeConfirmation(token, SECRET, now), null);
		}
	});
});

describe("accounts store (in memory)", () => {
	it("refuses a tenant until the 18+ tick is saved", async () => {
		const store = new InMemoryAccountStore();
		await assert.rejects(store.assignTenant("user_1"), AgeNotConfirmedError);
		assert.equal(await store.get("user_1"), null);
	});

	it("saves the first tick's date and keeps it", async () => {
		const store = new InMemoryAccountStore();
		await store.confirmAge("user_1", new Date(now));
		await store.confirmAge("user_1", new Date(now + 1000));
		assert.equal((await store.get("user_1"))?.ageConfirmedAt?.getTime(), now);
	});

	it("gives each account one stable tenant, a UUID", async () => {
		const store = new InMemoryAccountStore();
		await store.confirmAge("user_1", new Date(now));
		await store.confirmAge("user_2", new Date(now));
		const a = await store.assignTenant("user_1");
		assert.equal(await store.assignTenant("user_1"), a);
		assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		assert.notEqual(await store.assignTenant("user_2"), a);
	});

	it("maps a login to the same tenant after a front door restart", async () => {
		const before = new InMemoryAccountStore();
		await before.confirmAge("user_1", new Date(now));
		const afterRestart = new InMemoryAccountStore();
		await afterRestart.confirmAge("user_1", new Date(now));
		assert.equal(await afterRestart.assignTenant("user_1"), await before.assignTenant("user_1"));
	});
});

describe("cookies and return paths", () => {
	it("parses a cookie header", () => {
		const jar = parseCookies("a=1; fd_session=x.y.z; b=hello%20world");
		assert.equal(jar.get("fd_session"), "x.y.z");
		assert.equal(jar.get("b"), "hello world");
	});

	it("removes every login cookie before a request reaches a tenant", () => {
		assert.equal(stripLoginCookies("fd_session=1; theme=dark; __session=2; __session_abc=3; __client_uat=4; __client_uat_x=5; __clerk_db_jwt=6; fd_age=7; lang=en"), "theme=dark; lang=en");
		assert.equal(stripLoginCookies("fd_session=1"), undefined);
		assert.equal(stripLoginCookies(undefined), undefined);
	});

	it("allows only same-site paths", () => {
		assert.equal(safeReturnPath("/chat/1?x=2", "/"), "/chat/1?x=2");
		for (const bad of [null, "", "chat", "//evil.example", "/\\evil.example", "https://evil.example/", "/%2F%2Fevil.example"]) {
			const result = safeReturnPath(bad, "/");
			assert.ok(result === "/" || (result.startsWith("/") && !result.startsWith("//")), String(bad));
		}
		assert.equal(safeReturnPath("//evil.example", "/"), "/");
		assert.equal(safeReturnPath("/account/start", "/"), "/", "outside /account by default");
		assert.equal(safeReturnPath("/account/start?next=%2F", "/account/sign-up", { within: "/account" }), "/account/start?next=%2F");
		assert.equal(safeReturnPath("/chat/1", "/account/sign-up", { within: "/account" }), "/account/sign-up");
	});
});

describe("configuration", () => {
	const required = {
		FRONTDOOR_SESSION_SECRET: "x".repeat(32),
		CLERK_SECRET_KEY: "sk_test_example",
		NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
	};

	it("names every missing variable", () => {
		assert.throws(() => loadConfig({}), /FRONTDOOR_SESSION_SECRET.*CLERK_SECRET_KEY.*NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/s);
	});

	it("refuses a short session secret", () => {
		assert.throws(() => loadConfig({ ...required, FRONTDOOR_SESSION_SECRET: "short" }), /at least 32/);
	});

	it("uses the volume at /data and the upstream standalone server by default", () => {
		const config = loadConfig(required);
		assert.equal(config.volumeDir, "/data");
		assert.match(config.tenantServerScript, /\.next\/standalone\/server\.js$/);
		assert.equal(config.port, 3000);
		assert.equal(config.secureCookies, false);
	});

	it("uses secure cookies and trusts the edge's forwarded headers in production", () => {
		const config = loadConfig({ ...required, NODE_ENV: "production", PORT: "8080", FRONTDOOR_VOLUME: "/vol", FRONTDOOR_AUTHORIZED_PARTIES: "https://a.example, https://b.example" });
		assert.equal(config.secureCookies, true);
		assert.equal(config.trustForwardedHeaders, true);
		assert.equal(config.port, 8080);
		assert.equal(config.volumeDir, "/vol");
		assert.deepEqual(config.clerk.authorizedParties, ["https://a.example", "https://b.example"]);
	});
});

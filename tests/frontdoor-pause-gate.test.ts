/**
 * P2-05, P1-08: the pieces behind the pause screen, one at a time: what
 * counts as a page load, the access reader's memory and outage rule, the
 * gate's decisions, the meter wrapper, and the screens' HTML.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { Db } from "../frontdoor/db/index.ts";
import { createMemoryMeteringStore } from "../frontdoor/metering/store.ts";
import { AccessUnavailableError, createAccessReader, type AccessReader, type TenantAccess } from "../frontdoor/pause/access.ts";
import { API_MESSAGES } from "../frontdoor/pause/copy.ts";
import { createTenantGate, isPageLoad, safeTimeZone, type TenantData } from "../frontdoor/pause/gate.ts";
import { withPauseRules } from "../frontdoor/pause/meter.ts";
import { pauseScreenHtml, retentionScreenHtml } from "../frontdoor/pause/screens.ts";

const TENANT = "11111111-2222-4333-8444-555555555555";
const fakeReq = (method: string, headers: Record<string, string> = {}) => ({ method, headers }) as unknown as IncomingMessage;

describe("what counts as a page load", () => {
	it("documents, navigations, Next.js client navigations and HTML requests; never /api, /_next or writes", () => {
		assert.equal(isPageLoad(fakeReq("GET", { "sec-fetch-dest": "document" }), "/"), true);
		assert.equal(isPageLoad(fakeReq("GET", { "sec-fetch-mode": "navigate" }), "/chat/x"), true);
		assert.equal(isPageLoad(fakeReq("GET", { rsc: "1" }), "/chat/x"), true);
		assert.equal(isPageLoad(fakeReq("HEAD", { accept: "text/html" }), "/"), true);
		assert.equal(isPageLoad(fakeReq("GET", { accept: "text/html", "sec-fetch-dest": "document" }), "/api/chats"), false);
		assert.equal(isPageLoad(fakeReq("GET", { accept: "text/html" }), "/_next/static/app.js"), false);
		assert.equal(isPageLoad(fakeReq("POST", { "sec-fetch-dest": "document" }), "/chat/x"), false);
		assert.equal(isPageLoad(fakeReq("GET", { accept: "image/avif,image/webp" }), "/icon.png"), false);
	});

	it("time zones: a known IANA name, else UTC", () => {
		assert.equal(safeTimeZone("America/Los_Angeles"), "America/Los_Angeles");
		assert.equal(safeTimeZone("Mars/Olympus"), "UTC");
		assert.equal(safeTimeZone(null), "UTC");
		assert.equal(safeTimeZone("x".repeat(100)), "UTC");
	});
});

describe("the access reader", () => {
	function fakeDb(rows: () => Array<Record<string, unknown>>): Db & { calls: number } {
		const db = {
			calls: 0,
			async query() {
				db.calls += 1;
				return rows() as never;
			},
			async transaction<T>(fn: (tx: Db) => Promise<T>) {
				return fn(db);
			},
		};
		return db;
	}

	it("remembers an answer for the TTL, then asks again", async () => {
		let clock = 0;
		const db = fakeDb(() => [{ status: "ready", retention_ends_at: null, reason: "owner", paused_at: new Date(0) }]);
		const reader = createAccessReader({ db, ttlMs: 5_000, now: () => clock });
		assert.equal((await reader.read(TENANT)).state, "paused");
		clock = 4_000;
		await reader.read(TENANT);
		assert.equal(db.calls, 1);
		clock = 5_001;
		await reader.read(TENANT);
		assert.equal(db.calls, 2);
		reader.forget(TENANT);
		await reader.read(TENANT);
		assert.equal(db.calls, 3, "forget drops the memory");
	});

	it("uses the last answer for a minute while the database is down, then throws", async () => {
		let clock = 0;
		let down = false;
		const db = fakeDb(() => {
			if (down) throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
			return [];
		});
		const reader = createAccessReader({ db, ttlMs: 1_000, outageMs: 60_000, now: () => clock });
		assert.equal((await reader.read(TENANT)).state, "gone");
		down = true;
		clock = 30_000;
		assert.equal((await reader.read(TENANT)).state, "gone");
		clock = 61_000;
		await assert.rejects(reader.read(TENANT), AccessUnavailableError);
		await assert.rejects(createAccessReader({ db, now: () => clock }).read(TENANT), /ECONNREFUSED/);
	});
});

describe("the gate", () => {
	const reader = (access: TenantAccess | Error): AccessReader => ({
		read: async () => {
			if (access instanceof Error) throw access;
			return access;
		},
		forget: () => {},
	});
	const data: TenantData = {
		exportZip: async () => ({ fileName: "x.zip", body: Buffer.from("zip") }),
		recordHtml: async () => "<!doctype html><p>record</p>",
	};

	async function ask(access: TenantAccess | Error, method: string, pathname: string, headers: Record<string, string> = {}, gateData: TenantData | null = data) {
		const gate = createTenantGate({ access: reader(access), ...(gateData ? { data: gateData } : {}), log: () => {} });
		let signedOut = false;
		let handled = false;
		const server = createServer((req, res) => {
			void gate
				.handle(req, res, {
					tenantId: TENANT,
					userId: "user_x",
					pathname,
					setCookie: [],
					signOut: () => {
						signedOut = true;
						res.writeHead(401).end();
					},
				})
				.then((answered) => {
					handled = answered;
					if (!answered) res.writeHead(299).end("passed");
				});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${pathname}`, { method, headers });
		const body = await res.text();
		await new Promise<void>((r) => server.close(() => r()));
		return { status: res.status, body, handled, signedOut, type: res.headers.get("content-type") };
	}

	const PAGE = { "sec-fetch-dest": "document", accept: "text/html" };
	const RETENTION: TenantAccess = { state: "retention", retentionEndsAt: new Date("2027-02-06T00:00:00Z"), expired: false };

	it("open: everything passes; paused: page loads get the screen, API calls and files pass", async () => {
		assert.equal((await ask({ state: "open" }, "GET", "/", PAGE)).status, 299);
		const paused: TenantAccess = { state: "paused", reason: "autopause", pausedAt: new Date() };
		const screen = await ask(paused, "GET", "/chat/a", PAGE);
		assert.equal(screen.status, 200);
		assert.ok(screen.body.includes("Your tutor is paused"));
		assert.equal((await ask(paused, "POST", "/api/chats/a/stream")).status, 299, "the meter refuses the model call, not the gate");
		assert.equal((await ask(paused, "GET", "/_next/static/a.js")).status, 299);
	});

	it("retention: the screen for pages, 403 for API calls and form posts, files pass", async () => {
		const screen = await ask(RETENTION, "GET", "/", PAGE);
		assert.ok(screen.body.includes("February 6, 2027"));
		const apiCall = await ask(RETENTION, "GET", "/api/chats");
		assert.equal(apiCall.status, 403);
		assert.deepEqual(JSON.parse(apiCall.body), { error: API_MESSAGES.retention });
		assert.equal((await ask(RETENTION, "POST", "/chat/a")).status, 403);
		assert.equal((await ask(RETENTION, "GET", "/favicon.ico")).status, 299);
	});

	it("gone: signed out, for pages, API calls and the export", async () => {
		for (const [method, p] of [["GET", "/"], ["GET", "/api/chats"], ["GET", "/account/export"]] as const) {
			assert.equal((await ask({ state: "gone" }, method, p, PAGE)).signedOut, true, p);
		}
	});

	it("export and record: allowed open, paused and in retention; 410 once expired; one export at a time; 405 for writes", async () => {
		for (const access of [{ state: "open" } as TenantAccess, { state: "paused", reason: "owner", pausedAt: new Date() } as TenantAccess, RETENTION]) {
			const zip = await ask(access, "GET", "/account/export");
			assert.equal(zip.status, 200, access.state);
			assert.equal(zip.type, "application/zip");
			assert.equal((await ask(access, "GET", "/account/record")).status, 200);
		}
		const expired = await ask({ ...RETENTION, expired: true }, "GET", "/account/export");
		assert.equal(expired.status, 410);
		assert.equal((await ask({ state: "open" }, "POST", "/account/export")).status, 405);
		assert.equal((await ask({ state: "open" }, "GET", "/account/export", {}, null)).status, 404);

		let release: () => void = () => {};
		const slow: TenantData = { ...data, exportZip: () => new Promise((r) => { release = () => r({ fileName: "x.zip", body: Buffer.from("z") }); }) };
		const gate = createTenantGate({ access: reader({ state: "open" }), data: slow, log: () => {} });
		const server = createServer((req, res) => void gate.handle(req, res, { tenantId: TENANT, userId: "u", pathname: "/account/export", setCookie: [], signOut: () => {} }));
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/account/export`;
		const first = fetch(url);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal((await fetch(url)).status, 429);
		release();
		assert.equal((await first).status, 200);
		await new Promise<void>((r) => server.close(() => r()));
	});

	it("when access cannot be read, the request passes through (the meter fails closed on its own)", async () => {
		assert.equal((await ask(new Error("db down"), "GET", "/", PAGE)).status, 299);
	});
});

describe("the meter wrapper", () => {
	it("refuses paused, retention and deleted tenants; never refuses because the second read failed; checks cost after each call", async () => {
		const store = createMemoryMeteringStore();
		const checked: string[] = [];
		let access: TenantAccess | Error = { state: "open" };
		const wrapped = withPauseRules(store, {
			access: { read: async () => { if (access instanceof Error) throw access; return access; }, forget: () => {} },
			watch: { check: async () => ({ countedUsd: 0, alertOpened: false, paused: false }), afterCall: (id) => void checked.push(id), idle: async () => {} },
		});
		assert.equal(await wrapped.isPaused(TENANT), false);
		store.setPaused(TENANT, true);
		assert.equal(await wrapped.isPaused(TENANT), true);
		store.setPaused(TENANT, false);
		access = { state: "retention", retentionEndsAt: new Date(), expired: false };
		assert.equal(await wrapped.isPaused(TENANT), true);
		access = { state: "gone" };
		assert.equal(await wrapped.isPaused(TENANT), true);
		access = new Error("down");
		assert.equal(await wrapped.isPaused(TENANT), false);
		await wrapped.recordCall({ tenantId: TENANT, at: new Date(), model: "m", dollars: 1, requestId: "r", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 });
		assert.deepEqual(checked, [TENANT]);
		assert.equal(store.calls(TENANT).length, 1, "the call is still stored by the meter's own store");
	});
});

describe("the screens", () => {
	it("load nothing from outside and carry no Clerk script", () => {
		for (const html of [pauseScreenHtml(), retentionScreenHtml(new Date("2027-01-01T00:00:00Z"), false), retentionScreenHtml(new Date(), true)]) {
			assert.ok(!/\b(src|href)="https?:/i.test(html), "no outside resources");
			assert.ok(!/clerk/i.test(html));
			assert.ok(html.includes('name="robots" content="noindex"'));
			assert.ok(!html.includes("—"), "no em dashes");
		}
		assert.ok(!retentionScreenHtml(new Date(), true).includes("/account/export"), "no download once the 90 days are over");
	});
});

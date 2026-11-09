/**
 * The meter's Supabase store and the DB-outage rule (W1-6; master decision,
 * 2026-11-08; PRD C3 req 4, 6, 7):
 *  - Each pause read goes to the database. Each student's last status is
 *    remembered for up to 1 minute, and used only when the database is
 *    down or slow.
 *  - Nothing remembered and the database down: the call is refused
 *    (MeteringUnavailableError; the proxy answers 503).
 *  - A usage row that fails to write is kept and retried, never dropped:
 *    a bounded in-memory queue, written on recovery and at shutdown. When
 *    the queue is full, new calls are refused until it drains. Rows still
 *    waiting at shutdown go to a pending file on the volume and are loaded
 *    at the next start.
 *  - A row the database rejects for good (a data or constraint error) is
 *    logged and set aside, so it cannot block the queue.
 * Runs on PGlite, with a switch that makes the database fail or hang.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Db } from "../frontdoor/db/db.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import type { CallRecord } from "../frontdoor/metering/store.ts";
import { blockExternalFetch, startFakeAnthropic, TEST_PASS_KEY_SECRET } from "./frontdoor-metering-fakes.ts";

blockExternalFetch();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fd-wiring-store-"));
// The proxy reaches upstream's config.ts through pricing; give it a scratch data folder.
process.env.LH_DATA_DIR = scratch;

const { createSupabaseMeteringStore, MeteringUnavailableError, UNAVAILABLE_MESSAGE } = await import("../frontdoor/metering/supabase-store.ts");
const { createMeteringProxy } = await import("../frontdoor/metering/proxy.ts");
const { makePassKey, passKeyResolver } = await import("../frontdoor/metering/pass-key.ts");

type Store = ReturnType<typeof createSupabaseMeteringStore>;

const MINUTE = 60_000;

/** A Db that can be switched down (connection refused) or slow (never answers). */
function switchableDb(inner: Db) {
	const state = { mode: "up" as "up" | "down" | "hang", calls: 0 };
	const refuse = () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }));
	const gate = <T>(run: () => Promise<T>): Promise<T> => {
		state.calls += 1;
		if (state.mode === "down") return refuse();
		if (state.mode === "hang") return new Promise<T>(() => {});
		return run();
	};
	const db: Db = {
		query: (text, params) => gate(() => inner.query(text, params)),
		transaction: (fn) => gate(() => inner.transaction(fn)),
	};
	return { db, state };
}

let t: TestDb;
let tenantA = "";
let tenantB = "";
let clock = 0;
let logs: string[] = [];
const stores: Store[] = [];
let sw: ReturnType<typeof switchableDb>;
let n = 0;

function makeStore(extra: Partial<Parameters<typeof createSupabaseMeteringStore>[1]> = {}): Store {
	const store = createSupabaseMeteringStore(sw.db, {
		now: () => clock,
		log: (line) => logs.push(line),
		readTimeoutMs: 100,
		writeTimeoutMs: 100,
		retryMinMs: 20,
		retryMaxMs: 40,
		...extra,
	});
	stores.push(store);
	return store;
}

function call(tenantId: string, extra: Partial<CallRecord> = {}): CallRecord {
	n += 1;
	return {
		tenantId,
		at: new Date(),
		model: "claude-opus-5-5",
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cacheWrite1hTokens: 0,
		dollars: 0.001,
		requestId: `req_store_${n}`,
		...extra,
	};
}

async function waitFor(check: () => Promise<boolean> | boolean, label: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

const rowsFor = async (tenantId: string) => (await dbm.listModelUsage(t.db, tenantId)).length;
const searchesFor = async (tenantId: string) => (await dbm.searchUsageSince(t.db, tenantId, new Date(0))).count;

before(async () => {
	t = await createTestDb();
	tenantA = (await dbm.createStudentAccount(t.db, { clerkUserId: "user_store_a", age18ConfirmedAt: new Date() })).tenant.id;
	tenantB = (await dbm.createStudentAccount(t.db, { clerkUserId: "user_store_b", age18ConfirmedAt: new Date() })).tenant.id;
});
beforeEach(async () => {
	sw = switchableDb(t.db);
	clock = 1_000_000;
	logs = [];
	await t.db.query("delete from model_usage");
	await t.db.query("delete from search_usage");
	await t.db.query("delete from pauses");
});
afterEach(async () => {
	sw.state.mode = "up";
	for (const store of stores.splice(0)) await store.close();
});
after(async () => {
	await t.close();
	fs.rmSync(scratch, { recursive: true, force: true });
});

describe("pause status and the DB-outage rule", () => {
	it("reads the pause from the database each time, so a pause and an unpause act at once", async () => {
		const store = makeStore();
		assert.equal(await store.isPaused(tenantA), false);
		await dbm.pauseTenant(t.db, { tenantId: tenantA, reason: "owner" });
		assert.equal(await store.isPaused(tenantA), true);
		await dbm.unpauseTenant(t.db, { tenantId: tenantA });
		assert.equal(await store.isPaused(tenantA), false);
	});

	it("uses the remembered status within 1 minute while the database is down", async () => {
		const store = makeStore();
		await dbm.pauseTenant(t.db, { tenantId: tenantB, reason: "owner" });
		assert.equal(await store.isPaused(tenantA), false);
		assert.equal(await store.isPaused(tenantB), true);
		sw.state.mode = "down";
		clock += MINUTE - 1;
		assert.equal(await store.isPaused(tenantA), false, "teaching goes on");
		assert.equal(await store.isPaused(tenantB), true, "a paused student stays paused");
	});

	it("refuses when the remembered status is older than 1 minute and the database is down", async () => {
		const store = makeStore();
		assert.equal(await store.isPaused(tenantA), false);
		sw.state.mode = "down";
		clock += MINUTE + 1;
		await assert.rejects(store.isPaused(tenantA), MeteringUnavailableError);
	});

	it("refuses when nothing is remembered and the database is down (a first call after a restart)", async () => {
		const store = makeStore();
		sw.state.mode = "down";
		await assert.rejects(store.isPaused(tenantA), MeteringUnavailableError);
	});

	it("treats a database that does not answer in time as down", async () => {
		const store = makeStore();
		assert.equal(await store.isPaused(tenantA), false);
		sw.state.mode = "hang";
		clock += 1_000;
		assert.equal(await store.isPaused(tenantA), false, "remembered status, after the read timed out");
		await assert.rejects(store.isPaused(tenantB), MeteringUnavailableError, "nothing remembered for B");
	});
});

describe("usage rows during an outage", () => {
	it("keeps a row that fails to write and writes it after the database is back", async () => {
		const store = makeStore();
		sw.state.mode = "down";
		await store.recordCall(call(tenantA));
		await store.recordSearch({ tenantId: tenantA, at: new Date() });
		assert.equal(store.pending(), 2, "both rows are kept");
		sw.state.mode = "up";
		await waitFor(async () => store.pending() === 0, "the retry");
		assert.equal(await rowsFor(tenantA), 1);
		assert.equal(await searchesFor(tenantA), 1);
	});

	it("keeps retrying through a long outage, never dropping a row", async () => {
		const store = makeStore();
		sw.state.mode = "down";
		for (let i = 0; i < 5; i++) await store.recordCall(call(tenantA));
		const before = sw.state.calls;
		await waitFor(() => sw.state.calls >= before + 3, "several retries");
		assert.equal(store.pending(), 5);
		sw.state.mode = "up";
		await waitFor(async () => store.pending() === 0, "the queue drains");
		assert.equal(await rowsFor(tenantA), 5);
	});

	it("writes the waiting rows as soon as a pause read finds the database back", async () => {
		const store = makeStore({ retryMinMs: 60_000, retryMaxMs: 60_000 });
		sw.state.mode = "down";
		await store.recordCall(call(tenantA));
		sw.state.mode = "up";
		assert.equal(await store.isPaused(tenantA), false);
		await waitFor(async () => store.pending() === 0, "the recovery write");
		assert.equal(await rowsFor(tenantA), 1);
	});

	it("a row retried after a write that timed out is stored once (unique request id)", async () => {
		const store = makeStore();
		const row = call(tenantA);
		await dbm.recordModelUsage(t.db, { ...row, occurredAt: row.at, costUsd: row.dollars });
		sw.state.mode = "down";
		await store.recordCall(row);
		sw.state.mode = "up";
		await waitFor(async () => store.pending() === 0, "the retry");
		assert.equal(await rowsFor(tenantA), 1);
	});

	it("when the queue is full, refuses new calls until it drains, and still keeps rows of calls under way", async () => {
		const store = makeStore({ maxPending: 3 });
		assert.equal(await store.isPaused(tenantA), false);
		sw.state.mode = "down";
		for (let i = 0; i < 3; i++) await store.recordCall(call(tenantA));
		await assert.rejects(store.isPaused(tenantA), MeteringUnavailableError, "a full queue refuses new calls, even with a status remembered");
		await store.recordCall(call(tenantA));
		assert.equal(store.pending(), 4, "a call already under way is still kept");
		sw.state.mode = "up";
		await waitFor(async () => store.pending() === 0, "the queue drains");
		assert.equal(await store.isPaused(tenantA), false, "calls go through again");
		assert.equal(await rowsFor(tenantA), 4);
	});

	it("sets aside a row the database rejects for good, logs it without text, and goes on", async () => {
		const store = makeStore();
		const ghost = "00000000-0000-4000-8000-0000000000aa";
		await store.recordCall(call(ghost));
		await store.recordCall(call(tenantA));
		await waitFor(async () => store.pending() === 0, "the queue moves on");
		assert.equal(await rowsFor(tenantA), 1);
		const line = logs.find((l) => l.includes(ghost));
		assert.ok(line, "the rejected row is logged with its tenant id");
		assert.match(line, /23503/, "and the database's error code");
	});

	it("saves each rejected row in full, with its error code, in an owner-only file beside the pending file", async () => {
		const dir = path.join(scratch, "rejected-volume", "metering");
		const store = makeStore({ pendingFile: path.join(dir, "pending-usage.jsonl") });
		const ghost = "00000000-0000-4000-8000-0000000000bb";
		const row = call(ghost, { dollars: 0.0421, inputTokens: 777 });
		await store.recordCall(row);
		const file = path.join(dir, "rejected-usage.jsonl");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		const saved = fs
			.readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { kind: string; call: CallRecord; errorCode: string });
		assert.equal(saved.length, 1);
		assert.equal(saved[0]?.kind, "call");
		assert.equal(saved[0]?.errorCode, "23503");
		assert.equal(saved[0]?.call.tenantId, ghost);
		assert.equal(saved[0]?.call.requestId, row.requestId);
		assert.equal(saved[0]?.call.dollars, 0.0421, "the cost can still be seen");
		assert.equal(saved[0]?.call.inputTokens, 777);
		const line = logs.find((l) => l.includes(ghost)) ?? "";
		assert.ok(!line.includes("0.0421") && !line.includes(row.requestId), "the log line keeps tenant id and error code only");
	});
});

describe("shutdown", () => {
	it("close() writes every waiting row when the database is up", async () => {
		const store = makeStore({ retryMinMs: 60_000, retryMaxMs: 60_000 });
		sw.state.mode = "down";
		await store.recordCall(call(tenantA));
		await store.recordCall(call(tenantB));
		sw.state.mode = "up";
		await store.close();
		assert.equal(store.pending(), 0);
		assert.equal(await rowsFor(tenantA), 1);
		assert.equal(await rowsFor(tenantB), 1);
	});

	it("rows still waiting at shutdown go to the pending file, and the next start writes them", async () => {
		const pendingFile = path.join(scratch, "volume", "metering", "pending-usage.jsonl");
		const first = makeStore({ pendingFile });
		sw.state.mode = "down";
		const row = call(tenantA, { dollars: null, cacheWriteTokens: 50, cacheWrite1hTokens: 20 });
		await first.recordCall(row);
		await first.recordSearch({ tenantId: tenantB, at: new Date("2026-11-08T10:00:00Z") });
		await first.close();
		assert.ok(fs.existsSync(pendingFile), "the rows were saved");
		assert.equal(fs.statSync(pendingFile).mode & 0o777, 0o600, "only the server user can read it");

		const second = makeStore({ pendingFile });
		assert.equal(second.pending(), 2, "loaded at start");
		sw.state.mode = "up";
		await waitFor(async () => second.pending() === 0, "the loaded rows are written");
		const [stored] = await dbm.listModelUsage(t.db, tenantA);
		assert.equal(stored?.requestId, row.requestId);
		assert.equal(stored?.costUsd, null, "unpriced stays unpriced");
		assert.equal(stored?.cacheWrite1hTokens, 20);
		assert.equal(await searchesFor(tenantB), 1);
		await waitFor(() => !fs.existsSync(pendingFile), "the pending file is cleared once written");
	});
});

describe("the meter with this store", () => {
	it("answers 503 with a plain message, and forwards nothing, when it cannot check the pause", async () => {
		const anthropic = await startFakeAnthropic(() => ({ usage: { input: 1, output: 1 }, text: "x" }));
		const store = makeStore();
		const proxy = createMeteringProxy({
			store,
			resolveTenant: passKeyResolver(TEST_PASS_KEY_SECRET),
			anthropic: { apiKey: "real", baseUrl: anthropic.url },
			log: () => {},
		});
		const server = http.createServer(proxy.handle);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		try {
			sw.state.mode = "down";
			const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": makePassKey(TEST_PASS_KEY_SECRET, tenantA) },
				body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
			});
			assert.equal(res.status, 503);
			const body = (await res.json()) as { error: { message: string } };
			assert.equal(body.error.message, UNAVAILABLE_MESSAGE);
			assert.equal(anthropic.received.length, 0, "nothing reached Anthropic");
		} finally {
			server.closeAllConnections();
			await new Promise((r) => server.close(r));
			await anthropic.close();
		}
	});
});

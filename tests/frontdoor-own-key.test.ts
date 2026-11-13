/**
 * A student's own Anthropic key (master decision, 2026-11-13;
 * docs/decisions/2026-11-13-own-ai-key.md).
 *
 * Units: the AES-256-GCM sealing, the key format, the service's outage rule
 * and check limit, the meter's refusal messages, the log filter on sk-...
 * keys, and the database reads before the migration is applied.
 *
 * End to end, through the whole wired front door (PGlite with the real
 * migrations, the meter, a fake Anthropic on 127.0.0.1, the stand-in
 * tenant server): a student saves a key on the Account page's routes, the
 * tutor's calls then go out with that key and are marked own_key, they do
 * not count toward the alert or autopause, the dashboard shows them apart,
 * a refusal is never retried with North Aero's key, and removing the key
 * goes back to North Aero's at once. The key never comes back whole, and
 * never reaches the volume or the logs. No real API call, no real key.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildOverview } from "../frontdoor/admin/overview.ts";
import { trialUsage } from "../frontdoor/billing/trial.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import type { ClerkAuthResult } from "../frontdoor/gateway/auth.ts";
import { AGE_COOKIE, SESSION_COOKIE } from "../frontdoor/gateway/session.ts";
import { crashReport } from "../frontdoor/log-hygiene/crash.ts";
import { filterLogArgs, formatLogValue, redactLogText } from "../frontdoor/log-hygiene/filter.ts";
import { ownKeyRefusal } from "../frontdoor/metering/proxy.ts";
import { MeteringUnavailableError } from "../frontdoor/metering/store.ts";
import {
	OWN_KEY_LIMITED_MESSAGE,
	OWN_KEY_NO_CREDIT_MESSAGE,
	OWN_KEY_REFUSED_MESSAGE,
	OWN_KEY_UNREADABLE_MESSAGE,
} from "../frontdoor/own-key/copy.ts";
import { anthropicApiKeyFrom, openOwnKey, OWN_KEY_SECRET_ENV, ownKeyEnvProblem, ownKeySecretFrom, sealOwnKey } from "../frontdoor/own-key/crypto.ts";
import { databaseOwnKeyStore } from "../frontdoor/own-key/db-store.ts";
import { getOwnKeyRuntime } from "../frontdoor/own-key/registry.ts";
import { CHECK_WINDOW_MS, createOwnKeys, MAX_CHECKS, memoryOwnKeyStore, type OwnKeyStore } from "../frontdoor/own-key/service.ts";
import { costTowardLimits } from "../frontdoor/pause/limits.ts";
import { preflight } from "../frontdoor/wiring/env.ts";
import { blockExternalFetch, messageBody, REAL_ANTHROPIC_KEY } from "./frontdoor-metering-fakes.ts";

blockExternalFetch();

/** Made-up keys in Anthropic's format. None is real. */
const GOOD_KEY = `sk-ant-api03-TESTONLYnotarealkey${"q".repeat(70)}-WXYZ`;
const OTHER_GOOD_KEY = `sk-ant-api03-TESTONLYsecondfake${"r".repeat(70)}-ABCD`;
const BAD_KEY = `sk-ant-api03-TESTONLYrefusedkey${"z".repeat(70)}-BADK`;
const SUBSCRIPTION_TOKEN = `sk-ant-oat01-TESTONLYsubscription${"s".repeat(70)}`;
const SECRET = randomBytes(32);
const TENANT = "11111111-2222-4333-8444-555555555555";

// ---- units ----

describe("own key: sealing (AES-256-GCM)", () => {
	it("opens what it sealed, and keeps only the last 4 characters in clear", () => {
		const sealed = sealOwnKey(SECRET, TENANT, GOOD_KEY);
		assert.equal(sealed.last4, "WXYZ");
		assert.equal(sealed.iv.length, 12);
		assert.equal(sealed.tag.length, 16);
		assert.equal(sealed.ciphertext.toString("utf8").includes("sk-ant"), false);
		assert.equal(sealed.ciphertext.includes(Buffer.from(GOOD_KEY.slice(13, 40))), false);
		assert.equal(openOwnKey(SECRET, TENANT, sealed), GOOD_KEY);
		assert.notDeepEqual(sealOwnKey(SECRET, TENANT, GOOD_KEY).iv, sealed.iv, "a fresh nonce for each seal");
	});

	it("refuses another tenant's row, changed bytes and another secret, with no key in the error", () => {
		const sealed = sealOwnKey(SECRET, TENANT, GOOD_KEY);
		const fails = (fn: () => unknown) =>
			assert.throws(fn, (error: Error) => error.name === "OwnKeyUnreadableError" && !error.message.includes(GOOD_KEY) && !String(error.stack).includes(GOOD_KEY));
		fails(() => openOwnKey(SECRET, "99999999-2222-4333-8444-555555555555", sealed));
		fails(() => openOwnKey(randomBytes(32), TENANT, sealed));
		const changed = Buffer.from(sealed.ciphertext);
		changed[0] = (changed[0] ?? 0) ^ 1;
		fails(() => openOwnKey(SECRET, TENANT, { ...sealed, ciphertext: changed }));
	});

	it("LH_OWN_KEY_SECRET: unset means off; 32 bytes of base64 or base64url; anything else names the variable, never the value", () => {
		assert.equal(ownKeySecretFrom({}), null);
		assert.equal(ownKeySecretFrom({ [OWN_KEY_SECRET_ENV]: "" }), null);
		assert.deepEqual(ownKeySecretFrom({ [OWN_KEY_SECRET_ENV]: SECRET.toString("base64") }), SECRET);
		assert.deepEqual(ownKeySecretFrom({ [OWN_KEY_SECRET_ENV]: SECRET.toString("base64url") }), SECRET);
		for (const bad of ["c2hvcnQ=", "not base64 at all!", randomBytes(16).toString("base64"), randomBytes(48).toString("base64")]) {
			const problem = ownKeyEnvProblem({ [OWN_KEY_SECRET_ENV]: bad });
			assert.match(problem ?? "", /LH_OWN_KEY_SECRET must be 32 random bytes in base64/);
			assert.equal((problem ?? "").includes(bad), false);
			assert.throws(() => ownKeySecretFrom({ [OWN_KEY_SECRET_ENV]: bad }), /LH_OWN_KEY_SECRET/);
		}
	});

	it("the front door's start checks stop on a malformed secret, naming the variable only", () => {
		const env = {
			NODE_ENV: "test",
			FRONTDOOR_SESSION_SECRET: "own-key-session-secret-0123456789abcdefgh",
			CLERK_SECRET_KEY: "sk_test_own_key",
			NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_own_key",
			[OWN_KEY_SECRET_ENV]: "dG9vLXNob3J0",
		};
		assert.throws(
			() => preflight(env),
			(error: Error) => error.message.includes("LH_OWN_KEY_SECRET") && !error.message.includes("dG9vLXNob3J0"),
		);
		assert.equal(preflight({ ...env, [OWN_KEY_SECRET_ENV]: SECRET.toString("base64") }).wiring.ownKeySecret?.length, 32);
		assert.equal(preflight({ ...env, [OWN_KEY_SECRET_ENV]: undefined }).wiring.ownKeySecret, null);
	});

	it("takes Console API keys only: no subscription tokens, no Admin keys, nothing short", () => {
		assert.equal(anthropicApiKeyFrom(`  ${GOOD_KEY}\n`), GOOD_KEY);
		for (const bad of [SUBSCRIPTION_TOKEN, `sk-ant-admin01-${"a".repeat(80)}`, "sk-ant-api03-short", "hello", "", `${GOOD_KEY} extra`, `sk-proj-${"a".repeat(80)}`]) {
			assert.equal(anthropicApiKeyFrom(bad), null, bad.slice(0, 16));
		}
	});
});

describe("own key: the service", () => {
	const okCheck = async () => "ok" as const;

	it("off without the secret: the meter never reads the store, and nothing is saved", async () => {
		const store: OwnKeyStore = {
			get: async () => {
				throw new Error("must not be read");
			},
			put: async () => {
				throw new Error("must not be written");
			},
			remove: async () => false,
		};
		const keys = createOwnKeys({ secret: null, store, check: okCheck, log: () => {} });
		assert.equal(keys.enabled, false);
		assert.deepEqual(await keys.forCall(TENANT), { kind: "north-aero" });
		assert.deepEqual(await keys.save(TENANT, GOOD_KEY), { ok: false, problem: "off" });
	});

	it("the database outage rule: the last answer is used for 1 minute, then the call is refused", async () => {
		let clock = 1_000_000;
		let down = false;
		const memory = memoryOwnKeyStore();
		const store: OwnKeyStore = {
			...memory,
			get: async (id) => {
				if (down) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
				return memory.get(id);
			},
		};
		const keys = createOwnKeys({ secret: SECRET, store, check: okCheck, now: () => clock, log: () => {} });
		assert.deepEqual(await keys.save(TENANT, GOOD_KEY), { ok: true, last4: "WXYZ" });
		assert.deepEqual(await keys.forCall(TENANT), { kind: "own", apiKey: GOOD_KEY });
		down = true;
		clock += 30_000;
		assert.deepEqual(await keys.forCall(TENANT), { kind: "own", apiKey: GOOD_KEY }, "remembered for an outage");
		clock += 31_000;
		await assert.rejects(keys.forCall(TENANT), MeteringUnavailableError, "over a minute old: refused, not sent with North Aero's key");
		await assert.rejects(keys.forCall("22222222-2222-4333-8444-555555555555"), MeteringUnavailableError, "nothing remembered: refused");
	});

	it("a key saved under another secret is unreadable: its calls are refused, and the log has no key", async () => {
		const store = memoryOwnKeyStore();
		const logs: string[] = [];
		await createOwnKeys({ secret: randomBytes(32), store, check: okCheck, log: () => {} }).save(TENANT, GOOD_KEY);
		const keys = createOwnKeys({ secret: SECRET, store, check: okCheck, log: (line) => logs.push(line) });
		assert.deepEqual(await keys.forCall(TENANT), { kind: "unreadable" });
		assert.deepEqual((await keys.status(TENANT)).saved?.last4, "WXYZ");
		assert.equal(logs.join("\n").includes(GOOD_KEY), false);
		assert.match(logs.join("\n"), /cannot be decrypted/);
	});

	it(`at most ${MAX_CHECKS} key checks per student in 10 minutes`, async () => {
		let clock = 0;
		let checks = 0;
		const keys = createOwnKeys({
			secret: SECRET,
			store: memoryOwnKeyStore(),
			check: async () => {
				checks += 1;
				return "refused";
			},
			now: () => clock,
			log: () => {},
		});
		for (let i = 0; i < MAX_CHECKS; i++) assert.deepEqual(await keys.save(TENANT, BAD_KEY), { ok: false, problem: "refused" });
		assert.deepEqual(await keys.save(TENANT, BAD_KEY), { ok: false, problem: "too-many" });
		assert.equal(checks, MAX_CHECKS, "the 6th try never reached Anthropic");
		assert.deepEqual(await keys.save("22222222-2222-4333-8444-555555555555", BAD_KEY), { ok: false, problem: "refused" }, "another student is not held up");
		clock += CHECK_WINDOW_MS;
		assert.deepEqual(await keys.save(TENANT, BAD_KEY), { ok: false, problem: "refused" });
	});

	it("the store keeps only sealed bytes and the last 4 characters", async () => {
		const store = memoryOwnKeyStore();
		await createOwnKeys({ secret: SECRET, store, check: okCheck, log: () => {} }).save(TENANT, GOOD_KEY);
		const raw = store.raw(TENANT);
		assert.ok(raw);
		assert.equal(raw.last4, "WXYZ");
		assert.equal(JSON.stringify(raw).includes(GOOD_KEY), false);
		assert.equal(Buffer.concat([raw.ciphertext, raw.iv, raw.tag]).toString("latin1").includes("TESTONLY"), false);
	});
});

describe("own key: the meter's refusal messages", () => {
	it("401 and 403 are a refused key, 402 and a 400 about credit are no credit, 429 is a rate limit; any other error passes", () => {
		assert.equal(ownKeyRefusal(401, ""), OWN_KEY_REFUSED_MESSAGE);
		assert.equal(ownKeyRefusal(403, ""), OWN_KEY_REFUSED_MESSAGE);
		assert.equal(ownKeyRefusal(402, ""), OWN_KEY_NO_CREDIT_MESSAGE);
		assert.equal(ownKeyRefusal(400, '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'), OWN_KEY_NO_CREDIT_MESSAGE);
		assert.equal(ownKeyRefusal(429, ""), OWN_KEY_LIMITED_MESSAGE);
		assert.equal(ownKeyRefusal(400, '{"error":{"message":"max_tokens: too large"}}'), null);
		assert.equal(ownKeyRefusal(500, ""), null);
		assert.equal(ownKeyRefusal(529, ""), null);
	});

	it("the messages are plain: they name the Account page, and have no em dash", () => {
		for (const m of [OWN_KEY_REFUSED_MESSAGE, OWN_KEY_NO_CREDIT_MESSAGE, OWN_KEY_LIMITED_MESSAGE, OWN_KEY_UNREADABLE_MESSAGE]) {
			assert.match(m, /Account page/);
			assert.match(m, /North Aero's/);
			assert.equal(m.includes("—"), false);
		}
		assert.equal(OWN_KEY_REFUSED_MESSAGE, "Anthropic refused your own AI key. Check it on the Account page, or remove it to use North Aero's.");
	});
});

describe("own key: the log filter hides sk-... keys", () => {
	const preload = path.join(import.meta.dirname, "..", "frontdoor", "log-hygiene", "preload.ts");

	it("in the code's own message, later arguments, errors, objects and crash reports", () => {
		assert.equal(redactLogText(`saving key ${GOOD_KEY} for tenant t1`), "saving key [key] for tenant t1");
		assert.equal(redactLogText(`x-api-key: ${GOOD_KEY}, other=${SUBSCRIPTION_TOKEN}`), "x-api-key: [key], other=[key]");
		assert.equal(redactLogText(`key="${GOOD_KEY}"`).includes("sk-ant"), false);
		assert.equal(redactLogText("an sk-ant-api03 mention"), "an sk-ant-api03 mention", "a word without a key stays");
		assert.equal(redactLogText(`openai sk-proj-${"a".repeat(40)}`), "openai [key]");
		const args = filterLogArgs([`first ${GOOD_KEY}`, GOOD_KEY, { headers: { "x-api-key": GOOD_KEY } }, new Error(`bad key ${GOOD_KEY}`)]);
		const printed = args.map(String).join(" ");
		assert.equal(printed.includes("sk-ant"), false, printed);
		assert.equal(formatLogValue(Object.assign(new Error("x"), { code: GOOD_KEY })).includes("sk-ant"), false);
		assert.equal(crashReport("uncaught exception", new Error(`key ${GOOD_KEY}`)).includes("sk-ant"), false);
		assert.equal(crashReport("unhandled rejection", `key ${GOOD_KEY}`).includes("sk-ant"), false);
	});

	it("a process started with the preload prints no key, whatever it logs", () => {
		const script = [
			`console.log("own key ${GOOD_KEY} saved");`,
			`console.error("call failed", "${GOOD_KEY}", { apiKey: "${GOOD_KEY}" });`,
			`console.warn(new Error("refused ${GOOD_KEY}"));`,
			`throw new Error("crash with ${GOOD_KEY}");`,
		].join("\n");
		const env = { PATH: process.env.PATH ?? "" } as Record<string, string> as unknown as NodeJS.ProcessEnv;
		const result = spawnSync(process.execPath, ["--import", preload, "-e", script], { encoding: "utf8", env });
		const output = result.stdout + result.stderr;
		assert.equal(result.status, 1, "the crash still stops the process");
		assert.match(output, /own key \[key\] saved/);
		assert.equal(output.includes("sk-ant"), false, output);
		assert.equal(output.includes("TESTONLY"), false, output);
	});
});

describe("own key: the database", () => {
	let t: TestDb;
	before(async () => {
		t = await createTestDb();
	});
	after(async () => {
		await t?.close();
	});
	let n = 0;
	const tenant = async () => (await dbm.createStudentAccount(t.db, { clerkUserId: `user_ownkey_db_${++n}`, age18ConfirmedAt: new Date("2026-11-01T00:00:00Z") })).tenant;
	const call = (tenantId: string, costUsd: number, ownKey: boolean, at: Date) => ({
		tenantId,
		occurredAt: at,
		model: "claude-opus-5-5",
		inputTokens: 10,
		outputTokens: 10,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd,
		requestId: `req_ownkey_${++n}`,
		ownKey,
	});

	it("stores the sealed key once per student, replaces it, and removes it with the tenant", async () => {
		const a = await tenant();
		const sealed = sealOwnKey(SECRET, a.id, GOOD_KEY);
		const first = await dbm.saveOwnAiKey(t.db, { tenantId: a.id, ciphertext: sealed.ciphertext, iv: sealed.iv, authTag: sealed.tag, last4: sealed.last4, at: new Date("2026-11-13T10:00:00Z") });
		const row = await dbm.getOwnAiKey(t.db, a.id);
		assert.ok(row);
		assert.equal(openOwnKey(SECRET, a.id, { ciphertext: row.ciphertext, iv: row.iv, tag: row.authTag }), GOOD_KEY);
		const second = sealOwnKey(SECRET, a.id, OTHER_GOOD_KEY);
		const replaced = await dbm.saveOwnAiKey(t.db, { tenantId: a.id, ciphertext: second.ciphertext, iv: second.iv, authTag: second.tag, last4: second.last4, at: new Date("2026-11-14T10:00:00Z") });
		assert.equal(replaced.last4, "ABCD");
		assert.deepEqual(replaced.createdAt, first.createdAt, "the first save's date stays");
		assert.deepEqual(replaced.updatedAt, new Date("2026-11-14T10:00:00Z"));
		const all = await t.db.query("select * from own_ai_keys");
		assert.equal(all.length, 1);
		assert.equal(JSON.stringify(all, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v)).includes("TESTONLY"), false);
		assert.deepEqual(await dbm.listOwnAiKeyTenants(t.db), new Set([a.id]));
		const b = await tenant();
		const insert = (last4: string, iv: Buffer) =>
			t.db.query("insert into own_ai_keys (tenant_id, ciphertext, iv, auth_tag, last4) values ($1, $2, $3, $4, $5)", [b.id, sealed.ciphertext, iv, sealed.tag, last4]);
		await assert.rejects(insert("ab", sealed.iv), "last4 is exactly 4 characters");
		await assert.rejects(insert("abcd", Buffer.alloc(8)), "the nonce is 12 bytes");
		assert.equal(await dbm.getOwnAiKey(t.db, b.id), null);
		assert.equal(await dbm.deleteTenantAndAccount(t.db, a.id), true);
		assert.equal(await dbm.getOwnAiKey(t.db, a.id), null, "the day-91 delete takes the key too");
		assert.equal(await dbm.removeOwnAiKey(t.db, a.id), false);
	});

	it("model_usage.own_key: false by default; cost scopes and the dashboard totals keep own-key cost apart", async () => {
		const a = await tenant();
		const now = new Date("2026-11-13T12:00:00Z");
		await dbm.recordModelUsage(t.db, call(a.id, 2, false, now));
		await dbm.recordModelUsage(t.db, call(a.id, 3, true, now));
		await dbm.recordModelUsage(t.db, { ...call(a.id, 0, false, now), ownKey: undefined });
		const flags = await t.db.query("select own_key from model_usage where tenant_id = $1 order by id", [a.id]);
		assert.deepEqual(flags.map((r) => r.own_key), [false, true, false]);
		const since = new Date(now.getTime() - 60_000);
		assert.equal(await dbm.modelCostSince(t.db, a.id, since, now), 5, "all: every priced call");
		assert.equal(await dbm.modelCostSince(t.db, a.id, since, now, "north-aero"), 2);
		assert.equal(await dbm.modelCostSince(t.db, a.id, since, now, "own-key"), 3);
		assert.equal((await costTowardLimits(t.db, a.id, now)).rollingUsd, 2, "the alert and autopause count North Aero's cost only");
		const totals = (await dbm.usageTotals(t.db, { since, until: new Date(now.getTime() + 1) })).find((x) => x.tenantId === a.id);
		assert.deepEqual([totals?.modelCostUsd, totals?.modelCalls], [2, 2]);
		assert.deepEqual((await dbm.ownKeyUsageTotals(t.db, { since, until: new Date(now.getTime() + 1) })).get(a.id), { costUsd: 3, calls: 1 });
	});

	it("the trial's cost cap counts North Aero's cost only (Erick, 2026-11-13)", async () => {
		const a = await tenant();
		const start = new Date("2026-11-13T08:00:00Z");
		const now = new Date("2026-11-13T12:00:00Z");
		await dbm.recordModelUsage(t.db, call(a.id, 4, false, new Date("2026-11-13T09:00:00Z")));
		await dbm.recordModelUsage(t.db, call(a.id, 50, true, new Date("2026-11-13T10:00:00Z")));
		const limits = { studySeconds: 7200, costUsd: 10 };
		const usage = await trialUsage(t.db, { tenantId: a.id, trialStart: start }, now, limits);
		assert.equal(usage.costUsd, 4, "the $50 own-key call is left out");
		assert.equal(usage.usedUp, null, "own-key spending does not end the trial");
		await dbm.recordModelUsage(t.db, call(a.id, 7, false, new Date("2026-11-13T11:00:00Z")));
		assert.equal((await trialUsage(t.db, { tenantId: a.id, trialStart: start }, now, limits)).usedUp, "cost", "North Aero's cost still ends it at the cap");
	});

	it("before the migration is applied, the meter and the dashboard still work as before", async () => {
		const old = await createTestDb();
		try {
			await old.db.query("drop table own_ai_keys");
			await old.db.query("alter table model_usage drop column own_key");
			const { tenant: a } = await dbm.createStudentAccount(old.db, { clerkUserId: "user_ownkey_premigration", age18ConfirmedAt: new Date("2026-11-01T00:00:00Z") });
			const now = new Date("2026-11-13T12:00:00Z");
			await dbm.recordModelUsage(old.db, call(a.id, 4, false, now));
			const since = new Date(now.getTime() - 60_000);
			assert.equal(await dbm.modelCostSince(old.db, a.id, since, now, "north-aero"), 4);
			assert.equal(await dbm.modelCostSince(old.db, a.id, since, now, "own-key"), 0);
			assert.equal((await costTowardLimits(old.db, a.id, now)).rollingUsd, 4);
			assert.equal((await dbm.usageTotals(old.db, { since, until: new Date(now.getTime() + 1) })).find((x) => x.tenantId === a.id)?.modelCostUsd, 4);
			assert.equal((await dbm.ownKeyUsageTotals(old.db)).size, 0);
			assert.equal((await dbm.listOwnAiKeyTenants(old.db)).size, 0);
			const logs: string[] = [];
			const store = databaseOwnKeyStore(old.db, { log: (line) => logs.push(line) });
			assert.equal(await store.get(a.id), null);
			assert.equal(await store.get(a.id), null);
			assert.equal(logs.length, 1, "said once");
			assert.match(logs[0] ?? "", /apply migration 20261113000100/);
			const o = await buildOverview(old.db, { period: "all", now });
			assert.equal(o.rows.find((r) => r.tenantId === a.id)?.ownKey, false);
		} finally {
			await old.close();
		}
	});
});

// ---- end to end ----

type Mode = "ok" | "refuse" | "credit" | "credit402" | "limit" | "bad-request";

interface KeyAwareAnthropic {
	url: string;
	/** Every request: method, path and the key it came with. */
	received: Array<{ method: string; path: string; key: string }>;
	/** How the Messages API answers each key (default ok). */
	modes: Map<string, Mode>;
	close(): Promise<void>;
}

const USAGE = { input: 100_000, output: 20_000 };

/** A fake Anthropic that knows keys: GET /v1/models takes only `valid`, and POST /v1/messages answers per key. */
async function startKeyAwareAnthropic(valid: ReadonlySet<string>): Promise<KeyAwareAnthropic> {
	const received: KeyAwareAnthropic["received"] = [];
	const modes = new Map<string, Mode>();
	let requests = 0;
	const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
		res.writeHead(status, { "content-type": "application/json", ...headers });
		res.end(JSON.stringify(body));
	};
	const error = (res: http.ServerResponse, status: number, type: string, message: string) => json(res, status, { type: "error", error: { type, message } });
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const key = String(req.headers["x-api-key"] ?? "");
			const pathname = new URL(req.url ?? "/", "http://fake").pathname;
			received.push({ method: req.method ?? "", path: pathname, key });
			if (req.method === "GET" && pathname === "/v1/models") {
				return valid.has(key) ? json(res, 200, { data: [{ type: "model", id: "claude-opus-5-5" }], has_more: false }) : error(res, 401, "authentication_error", "invalid x-api-key");
			}
			if (req.method !== "POST" || pathname !== "/v1/messages") return error(res, 404, "not_found_error", "Not found");
			if (key !== REAL_ANTHROPIC_KEY && !valid.has(key)) return error(res, 401, "authentication_error", "invalid x-api-key");
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
			switch (modes.get(key) ?? "ok") {
				case "refuse":
					return error(res, 401, "authentication_error", "invalid x-api-key");
				case "credit":
					return error(res, 400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
				case "credit402":
					return error(res, 402, "billing_error", "There is an issue with your billing.");
				case "limit":
					return error(res, 429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit.");
				case "bad-request":
					return error(res, 400, "invalid_request_error", "max_tokens: 16 is too small for this test");
				case "ok":
					return json(res, 200, messageBody(body.model ?? "claude-opus-5-5", { usage: USAGE, text: "Own key or not." }), { "request-id": `req_ownkey_fake_${++requests}` });
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		received,
		modes,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fd-own-key-"));
const volume = path.join(work, "volume");
const ENV: Record<string, string> = {
	NODE_ENV: "test",
	PATH: process.env.PATH ?? "",
	FRONTDOOR_SESSION_SECRET: "own-key-e2e-session-secret-0123456789abcdefgh",
	CLERK_SECRET_KEY: "sk_test_own_key_e2e",
	NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_own_key_e2e",
	FRONTDOOR_PASS_KEY_SECRET: "own-key-e2e-pass-key-secret-0123456789abcdef",
	ANTHROPIC_API_KEY: REAL_ANTHROPIC_KEY,
	SUPABASE_DB_URL: "postgres://u:p@127.0.0.1:9/never_dialed",
	FRONTDOOR_VOLUME: volume,
	FRONTDOOR_TENANT_SERVER: path.join(import.meta.dirname, "frontdoor-pause-tenant.ts"),
	FRONTDOOR_LISTEN_HOST: "127.0.0.1",
	PORT: "0",
	[OWN_KEY_SECRET_ENV]: randomBytes(32).toString("base64"),
};

describe("own key, end to end through the front door", () => {
	let t: TestDb;
	let anthropic: KeyAwareAnthropic;
	let frontDoor: Awaited<ReturnType<typeof import("../frontdoor/wiring/front-door.ts").startFrontDoor>>;
	let clerkResult: ClerkAuthResult = { status: "signed-out" };
	const logs: string[] = [];
	let cookie = "";
	let tenantId = "";

	before(async () => {
		t = await createTestDb();
		anthropic = await startKeyAwareAnthropic(new Set([GOOD_KEY, OTHER_GOOD_KEY]));
		const { startFrontDoor } = await import("../frontdoor/wiring/front-door.ts");
		frontDoor = await startFrontDoor({
			env: ENV,
			frontDoorApp: (_req, res) => res.end("front door page"),
			clerk: { authenticate: async () => clerkResult, isSessionActive: async () => true },
			db: t.db,
			upstream: { anthropicBaseUrl: anthropic.url },
			extraTestRoutes: [{ path: "/api/wiring/[action]", methods: ["POST"], access: "allowed", reason: "Test stand-in only." }],
			log: (line) => logs.push(line),
		});
		// Low lines, so North Aero's cost would cross both at once; own-key cost must not.
		await dbm.updateOwnerSettings(t.db, { alertUsd: 0.01, autopauseUsd: 0.02 });
	});

	after(async () => {
		await frontDoor?.close();
		await anthropic?.close();
		await t?.close();
		fs.rmSync(work, { recursive: true, force: true });
	});

	const cookieValue = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0];
	const keyRoute = () => `${frontDoor.url}/_frontdoor/ai-key`;
	const status = async () => (await fetch(keyRoute(), { headers: { Cookie: cookie, Accept: "application/json" } })).text();
	const post = (body: Record<string, string>, extra: Record<string, string> = {}) =>
		fetch(keyRoute(), {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: frontDoor.url, ...extra },
			body: new URLSearchParams(body).toString(),
		});
	const messagesWith = (key: string) => anthropic.received.filter((r) => r.path === "/v1/messages" && r.key === key).length;
	const usageRows = async () => t.db.query("select own_key, cost_usd from model_usage where tenant_id = $1 order by id", [tenantId]);
	async function waitForRows(count: number): Promise<void> {
		const deadline = Date.now() + 5_000;
		while ((await usageRows()).length < count) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} usage rows`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	async function turn(): Promise<{ status: number; body: string }> {
		const res = await fetch(`${frontDoor.url}/api/wiring/raw-call`, { method: "POST", headers: { Cookie: cookie, Accept: "application/json" } });
		assert.equal(res.status, 200, await res.clone().text());
		return (await res.json()) as { status: number; body: string };
	}

	it("signs a student in; own keys are on, and none is saved yet", async () => {
		const age = await fetch(`${frontDoor.url}/account/age`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "over18=yes&next=%2Faccount%2Fsign-up",
		});
		clerkResult = { status: "signed-in", userId: "user_own_key_e2e", sessionId: "sess_own_key_e2e" };
		const start = await fetch(`${frontDoor.url}/account/start`, { redirect: "manual", headers: { Cookie: cookieValue(age, AGE_COOKIE) ?? "" } });
		assert.equal(start.status, 302, logs.join(" | "));
		cookie = cookieValue(start, SESSION_COOKIE) ?? "";
		tenantId = (await dbm.getTenantByClerkUserId(t.db, "user_own_key_e2e"))!.id;
		assert.deepEqual(JSON.parse(await status()), { enabled: true, saved: false, last4: null, savedAt: null });
		assert.ok(logs.includes("own AI keys: on"));
		assert.equal((await fetch(keyRoute(), { redirect: "manual" })).status, 302, "needs the tutor's login: sign in first");
		assert.equal((await fetch(keyRoute(), { method: "POST", body: "action=remove" })).status, 401);
	});

	it("a save needs the site's own page, and a key that is not a Console API key never reaches Anthropic", async () => {
		assert.equal((await post({ action: "save", key: GOOD_KEY }, { Origin: "https://evil.example" })).status, 403);
		for (const key of ["hello", SUBSCRIPTION_TOKEN]) {
			const res = await post({ action: "save", key });
			assert.equal(res.status, 303);
			assert.equal(res.headers.get("location"), "/account/ai-key?error=format");
		}
		assert.equal(anthropic.received.length, 0);
		assert.equal(await dbm.getOwnAiKey(t.db, tenantId), null);
	});

	it("a key Anthropic refuses is not saved", async () => {
		const res = await post({ action: "save", key: BAD_KEY });
		assert.equal(res.headers.get("location"), "/account/ai-key?error=refused");
		assert.deepEqual(anthropic.received.at(-1), { method: "GET", path: "/v1/models", key: BAD_KEY });
		assert.equal(await dbm.getOwnAiKey(t.db, tenantId), null);
	});

	it("a good key is checked, saved encrypted, and only its last 4 characters ever come back", async () => {
		const res = await post({ action: "save", key: GOOD_KEY });
		assert.equal(res.status, 303);
		assert.equal(res.headers.get("location"), "/account/ai-key?saved=1", "the key is never put in an address");
		assert.deepEqual(anthropic.received.at(-1), { method: "GET", path: "/v1/models", key: GOOD_KEY });

		const text = await status();
		const body = JSON.parse(text) as { enabled: boolean; saved: boolean; last4: string; savedAt: string };
		assert.deepEqual([body.enabled, body.saved, body.last4], [true, true, "WXYZ"]);
		assert.ok(!Number.isNaN(Date.parse(body.savedAt)));
		assert.equal(text.includes("sk-ant"), false);
		assert.equal(text.includes("TESTONLY"), false);

		const page = await getOwnKeyRuntime()?.state(cookie);
		assert.equal(page?.saved?.last4, "WXYZ");
		assert.equal(JSON.stringify(page).includes("TESTONLY"), false, "the page gets no more than the API");
		assert.equal(await getOwnKeyRuntime()?.state(undefined), null);

		const rows = await t.db.query("select * from own_ai_keys where tenant_id = $1", [tenantId]);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.last4, "WXYZ");
		assert.equal(JSON.stringify(rows, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v)).includes("TESTONLY"), false, "no clear key in the database");
	});

	it("the tutor's calls now go out with the student's key, marked own_key; the tenant still holds only its pass key", async () => {
		const result = await turn();
		assert.equal(result.status, 200, result.body);
		assert.equal(messagesWith(GOOD_KEY), 1);
		assert.equal(messagesWith(REAL_ANTHROPIC_KEY), 0, "North Aero's key was not used");
		await waitForRows(1);
		const [row] = await usageRows();
		assert.equal(row?.own_key, true);
		assert.ok(Number(row?.cost_usd) > 0.02, "priced at list price, over both lines");
	});

	it("own-key cost does not count toward the alert or the autopause", async () => {
		await turn();
		await turn();
		await waitForRows(3);
		await frontDoor.dataSafety!.watch.idle();
		assert.deepEqual(await dbm.listAlerts(t.db, tenantId), []);
		assert.equal(await dbm.isPaused(t.db, tenantId), false);
		const limits = await costTowardLimits(t.db, tenantId);
		assert.deepEqual([limits.rollingUsd, limits.countedUsd], [0, 0]);
		assert.ok((await dbm.modelCostSince(t.db, tenantId, new Date(0), new Date(), "own-key")) > 0.06);
	});

	it("the dashboard marks the student and shows own-key spend apart from North Aero's cost, with no part of the key", async () => {
		const o = await buildOverview(t.db, { period: "all" });
		const row = o.rows.find((r) => r.tenantId === tenantId);
		assert.ok(row);
		assert.equal(row.ownKey, true);
		assert.equal(row.ownKeyCalls, 3);
		assert.ok(row.ownKeyCostUsd > 0.06);
		assert.deepEqual([row.modelCostUsd, row.modelCalls, row.costUsd], [0, 0, 0], "North Aero's cost leaves the own-key calls out");
		assert.equal(o.totals.ownKeyStudents, 1);
		assert.equal(o.totals.ownKeyCostUsd, row.ownKeyCostUsd);
		const all = JSON.stringify(o);
		assert.equal(all.includes("TESTONLY") || all.includes("sk-ant") || all.includes("WXYZ"), false);
	});

	it("when Anthropic refuses the student's key, the tutor gets a plain message, and North Aero's key is never tried", async () => {
		const cases: Array<[Mode, string]> = [
			["refuse", OWN_KEY_REFUSED_MESSAGE],
			["credit", OWN_KEY_NO_CREDIT_MESSAGE],
			["credit402", OWN_KEY_NO_CREDIT_MESSAGE],
			["limit", OWN_KEY_LIMITED_MESSAGE],
		];
		for (const [mode, message] of cases) {
			anthropic.modes.set(GOOD_KEY, mode);
			const before = messagesWith(GOOD_KEY);
			const result = await turn();
			assert.equal(result.status, 403, `${mode}: ${result.body}`);
			assert.deepEqual(JSON.parse(result.body), { type: "error", error: { type: "permission_error", message } });
			assert.equal(messagesWith(GOOD_KEY), before + 1, `${mode}: one try, not retried`);
			assert.equal(messagesWith(REAL_ANTHROPIC_KEY), 0, `${mode}: no fallback to North Aero's key`);
			assert.equal(result.body.includes("TESTONLY"), false);
		}
		// Another error is Anthropic's own answer, passed through as before.
		anthropic.modes.set(GOOD_KEY, "bad-request");
		const passed = await turn();
		assert.equal(passed.status, 400);
		assert.match(passed.body, /too small for this test/);
		anthropic.modes.delete(GOOD_KEY);
		assert.equal((await usageRows()).length, 3, "a refused call records no usage");
		assert.ok(logs.some((l) => /Anthropic refused tenant .+'s own key \(status 401\); not retried/.test(l)));
	});

	it("removing the key goes back to North Aero's key at once, and that cost counts again", async () => {
		const res = await post({ action: "remove" });
		assert.equal(res.headers.get("location"), "/account/ai-key?removed=1");
		assert.deepEqual(JSON.parse(await status()), { enabled: true, saved: false, last4: null, savedAt: null });
		assert.equal(await dbm.getOwnAiKey(t.db, tenantId), null);
		const result = await turn();
		assert.equal(result.status, 200);
		assert.equal(messagesWith(REAL_ANTHROPIC_KEY), 1);
		await waitForRows(4);
		assert.equal((await usageRows()).at(-1)?.own_key, false);
		await frontDoor.dataSafety!.watch.idle();
		assert.ok((await costTowardLimits(t.db, tenantId)).rollingUsd > 0.02);
		assert.equal(await dbm.isPaused(t.db, tenantId), true, "North Aero's cost crossed the low autopause line");
		assert.equal((await buildOverview(t.db, { period: "all" })).rows.find((r) => r.tenantId === tenantId)?.ownKey, false);
	});

	it("a paused student can still save a key, but the pause still holds for the meter", async () => {
		assert.equal((await post({ action: "save", key: OTHER_GOOD_KEY })).headers.get("location"), "/account/ai-key?saved=1");
		const before = messagesWith(OTHER_GOOD_KEY);
		const result = await turn();
		assert.equal(result.status, 403);
		assert.match(result.body, /paused/);
		assert.equal(messagesWith(OTHER_GOOD_KEY), before, "nothing reached Anthropic");
	});

	it("the key never reaches the volume or the logs", () => {
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(p);
				else if (entry.isFile()) files.push(p);
			}
		};
		walk(volume);
		assert.ok(files.length > 0, "the tenant's folder is on the volume");
		for (const file of files) {
			const text = fs.readFileSync(file).toString("latin1");
			assert.equal(text.includes("TESTONLY"), false, `${path.relative(volume, file)} holds no key`);
		}
		const all = logs.join("\n");
		assert.equal(all.includes("TESTONLY") || all.includes("sk-ant"), false);
	});
});

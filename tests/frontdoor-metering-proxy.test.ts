/**
 * The metering proxy (P2-01: C3 requirements 4 and 6, X2, D29).
 *
 * A tenant's real engine (src/agent/models.ts, routed by
 * LH_ANTHROPIC_BASE_URL) calls the proxy with the tenant's pass key in the
 * API-key slot. The proxy swaps in the real key, forwards to a FAKE
 * Anthropic on 127.0.0.1, and meters the call. No real API call, no key.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { REAL_ANTHROPIC_KEY, TEST_PASS_KEY_SECRET, blockExternalFetch, startFakeAnthropic, startMeteringProxy, waitFor, type FakeAnthropic, type ScriptedReply, type ScriptedUsage } from "./frontdoor-metering-fakes.ts";
import { makePassKey, passKeyResolver } from "../frontdoor/metering/pass-key.ts";

blockExternalFetch();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-metering-proxy-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });

const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { PAUSED_MESSAGE } = await import("../frontdoor/metering/proxy.ts");

const TENANT_A = "tenant-a-0001";
const TENANT_B = "tenant-b-0002";
const PASS_A = makePassKey(TEST_PASS_KEY_SECRET, TENANT_A);
const PASS_B = makePassKey(TEST_PASS_KEY_SECRET, TENANT_B);

type Stack = Awaited<ReturnType<typeof startMeteringProxy>>;
let anthropic: FakeAnthropic | undefined;
let stack: Stack | undefined;

/** Start a fake Anthropic and the proxy, and point the tenant at the proxy as tenant A. */
async function start(script: ScriptedReply[]): Promise<{ anthropic: FakeAnthropic; stack: Stack }> {
	anthropic = await startFakeAnthropic(script);
	stack = await startMeteringProxy({ anthropicUrl: anthropic.url });
	process.env.LH_ANTHROPIC_BASE_URL = stack.url;
	process.env.ANTHROPIC_API_KEY = PASS_A;
	return { anthropic, stack };
}

afterEach(async () => {
	await stack?.close();
	await anthropic?.close();
	stack = undefined;
	anthropic = undefined;
	delete process.env.LH_ANTHROPIC_BASE_URL;
	delete process.env.ANTHROPIC_API_KEY;
});

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** One model call through the tenant's real engine, as a teaching turn makes it. */
async function call(text: string, modelId = "claude-opus-5-5", signal?: AbortSignal) {
	const engine = piEngineForSpec({ provider: "anthropic", id: modelId }, false);
	const context = normalizeContext({ messages: [{ role: "user", content: text, timestamp: Date.now() }] });
	return engine.streamFn(engine.model, context, signal ? { signal } : {}).result();
}

/**
 * The provider's reported usage times list price, worked out here by hand
 * from the catalog's rates and Anthropic's rules: a tier applies when the
 * prompt (input + cache read + cache write) passes its threshold, and a
 * 1-hour cache write costs 2x the input rate.
 */
function expectedDollars(modelId: string, usage: ScriptedUsage): number {
	const cost = piModels().getModel("anthropic", modelId)!.cost;
	const prompt = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	const tier = [...(cost.tiers ?? [])].filter((t) => prompt > t.inputTokensAbove).sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0];
	const rates = tier ?? cost;
	const long = usage.cacheWrite1h ?? 0;
	const short = (usage.cacheWrite ?? 0) - long;
	return (usage.input * rates.input + usage.output * rates.output + (usage.cacheRead ?? 0) * rates.cacheRead + short * rates.cacheWrite + long * 2 * rates.input) / 1_000_000;
}

describe("pass keys", () => {
	it("round-trip a tenant id, and refuse a tampered key or another secret", () => {
		const resolve = passKeyResolver(TEST_PASS_KEY_SECRET);
		assert.equal(resolve(PASS_A), TENANT_A);
		assert.equal(resolve(PASS_B), TENANT_B);
		const odd = "user_2x/ü.+ ==";
		assert.equal(resolve(makePassKey(TEST_PASS_KEY_SECRET, odd)), odd);
		assert.equal(resolve(`${PASS_A.slice(0, -2)}xx`), null, "a changed signature is refused");
		assert.equal(resolve(PASS_A.replace(Buffer.from(TENANT_A).toString("base64url"), Buffer.from(TENANT_B).toString("base64url"))), null, "a swapped tenant is refused");
		assert.equal(passKeyResolver("another-secret-of-enough-length-000000")(PASS_A), null);
		assert.equal(resolve("sk-ant-api03-not-a-pass-key"), null);
		assert.equal(resolve(""), null);
		assert.throws(() => makePassKey("short", TENANT_A), /at least 32 characters/);
		assert.throws(() => passKeyResolver("short"), /at least 32 characters/);
	});
});

describe("metering proxy", () => {
	before(() => {
		assert.ok(piModels().getModel("anthropic", "claude-opus-5-5"), "the catalog prices Opus 5.5");
	});

	it("C3: for a scripted session, metered dollars equal the provider's reported usage times list price, within one cent", async () => {
		// A study session's mix: teaching turns with 1-hour and 5-minute cache
		// writes, a tool-loop step, a Cheap-slot extraction big enough for
		// Haiku's upper price tier, and a compaction.
		const calls: Array<{ model: string; reply: ScriptedReply }> = [
			{ model: "claude-opus-5-5", reply: { text: "Let us decode a METAR, starting with the station.", usage: { input: 12_000, cacheWrite: 30_000, cacheWrite1h: 30_000, output: 1_500 } } },
			{ model: "claude-opus-5-5", reply: { text: "KPAE 081953Z: the day and time in Zulu.", usage: { input: 800, cacheRead: 30_000, cacheWrite: 2_000, output: 2_200 } } },
			{ model: "claude-opus-5-5", reply: { toolCall: { id: "toolu_1", name: "quiz", input: { topic: "wind group" } }, usage: { input: 300, cacheRead: 32_000, output: 450 } } },
			{ model: "claude-opus-5-5", reply: { text: "Wind 270 at 10 knots.", usage: { input: 1_200, cacheRead: 32_300, cacheWrite: 1_100, cacheWrite1h: 600, output: 3_100 } } },
			{ model: "claude-haiku-5-5", reply: { text: "{\"concepts\":[\"METAR wind group\"]}", usage: { input: 150_000, output: 3_000 } } },
			{ model: "claude-opus-5-5", reply: { text: "Summary so far: station, time, wind.", usage: { input: 90_000, output: 6_000 } } },
		];
		const { anthropic, stack } = await start(calls.map((c) => c.reply));

		let upstreamDollars = 0;
		for (const { model } of calls) {
			const message = await call("Teach me to decode a METAR.", model);
			assert.equal(message.stopReason === "stop" || message.stopReason === "toolUse", true, `call finished (${message.stopReason}: ${message.errorMessage ?? ""})`);
			upstreamDollars += message.usage.cost.total;
		}
		await stack.proxy.flush();

		const rows = stack.store.calls(TENANT_A);
		assert.equal(rows.length, calls.length, "one usage row per model call");
		assert.equal(stack.store.calls(TENANT_B).length, 0);
		rows.forEach((row, i) => {
			const { model, reply } = calls[i]!;
			assert.equal(row.tenantId, TENANT_A);
			assert.equal(row.model, model);
			assert.ok(row.at instanceof Date && !Number.isNaN(row.at.getTime()));
			assert.deepEqual(
				[row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.cacheWrite1hTokens],
				[reply.usage.input, reply.usage.output, reply.usage.cacheRead ?? 0, reply.usage.cacheWrite ?? 0, reply.usage.cacheWrite1h ?? 0],
				`call ${i + 1}: the provider's reported tokens`,
			);
			assert.ok(row.dollars !== null, `call ${i + 1} is priced`);
			assert.ok(Math.abs(row.dollars - expectedDollars(model, reply.usage)) < 0.01, `call ${i + 1} within one cent`);
		});

		const metered = rows.reduce((sum, row) => sum + (row.dollars ?? 0), 0);
		const expected = calls.reduce((sum, c) => sum + expectedDollars(c.model, c.reply.usage), 0);
		assert.ok(expected > 1, `the session costs real money (${expected.toFixed(4)})`);
		assert.ok(Math.abs(metered - expected) < 0.01, `metered ${metered.toFixed(4)} vs usage x list price ${expected.toFixed(4)}`);
		// X2 option B cross-check: the proxy matches upstream's own usage record.
		assert.ok(Math.abs(metered - upstreamDollars) < 0.01, `metered ${metered.toFixed(4)} vs upstream's record ${upstreamDollars.toFixed(4)}`);

		// Only the proxy holds the real key: Anthropic never sees a pass key.
		assert.equal(anthropic.received.length, calls.length);
		for (const request of anthropic.received) {
			assert.equal(request.headers["x-api-key"], REAL_ANTHROPIC_KEY);
			assert.ok(!JSON.stringify(request.headers).includes(PASS_A), "the pass key stays at the proxy");
		}
	});

	it("each tenant's calls land on that tenant's pass key", async () => {
		const { stack } = await start([
			{ text: "A", usage: { input: 100, output: 10 } },
			{ text: "B", usage: { input: 200, output: 20 } },
		]);
		await call("tenant A");
		process.env.ANTHROPIC_API_KEY = PASS_B;
		await call("tenant B");
		await stack.proxy.flush();
		assert.deepEqual(stack.store.calls(TENANT_A).map((r) => r.inputTokens), [100]);
		assert.deepEqual(stack.store.calls(TENANT_B).map((r) => r.inputTokens), [200]);
	});

	it("C3: a paused tenant's call is refused with the pause notice, and unpausing restores access", async () => {
		const { anthropic, stack } = await start([{ text: "Welcome back.", usage: { input: 50, output: 5 } }]);
		stack.store.setPaused(TENANT_A, true);

		const refused = await call("Teach me about Class B airspace.");
		assert.equal(refused.stopReason, "error");
		assert.ok((refused.errorMessage ?? "").includes(PAUSED_MESSAGE), `the student sees the pause notice: ${refused.errorMessage}`);
		assert.equal(anthropic.received.length, 0, "nothing reached Anthropic");
		await stack.proxy.flush();
		assert.equal(stack.store.calls().length, 0, "nothing metered");

		// The Owner unpauses: the next call goes through and is metered.
		stack.store.setPaused(TENANT_A, false);
		const allowed = await call("Teach me about Class B airspace.");
		assert.equal(allowed.stopReason, "stop");
		await stack.proxy.flush();
		assert.equal(stack.store.calls(TENANT_A).length, 1);
	});

	it("a pause does not touch other tenants", async () => {
		const { stack } = await start([{ text: "B studies on.", usage: { input: 70, output: 7 } }]);
		stack.store.setPaused(TENANT_A, true);
		process.env.ANTHROPIC_API_KEY = PASS_B;
		const message = await call("tenant B");
		assert.equal(message.stopReason, "stop");
		await stack.proxy.flush();
		assert.equal(stack.store.calls(TENANT_B).length, 1);
	});

	it("a call cut off midway records the tokens seen so far", async () => {
		const { anthropic, stack } = await start([{ stall: true, usage: { input: 5_000, cacheRead: 20_000, output: 0 } }]);
		const controller = new AbortController();
		const pending = call("A long answer, please.", "claude-opus-5-5", controller.signal);
		await waitFor(() => anthropic.stalled() === 1, "the stream to start");
		controller.abort();
		const message = await pending;
		assert.equal(message.stopReason, "aborted");
		await waitFor(() => stack.store.calls(TENANT_A).length === 1, "the partial usage row");
		const [row] = stack.store.calls(TENANT_A);
		assert.equal(row!.inputTokens, 5_000);
		assert.equal(row!.cacheReadTokens, 20_000);
		assert.equal(row!.outputTokens, 1, "message_start's running output count");
		assert.ok(row!.dollars !== null && row!.dollars > 0);
		await waitFor(() => anthropic.stalled() === 0, "the upstream stream to close");
	});

	it("a model missing from the price list is passed through and recorded unpriced", async () => {
		const { anthropic, stack } = await start([{ text: "Hello from the future.", usage: { input: 1_000, output: 100 } }]);
		const response = await fetch(`${stack.url}/v1/messages?beta=true`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": PASS_A, "anthropic-version": "2023-06-01", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
			body: JSON.stringify({ model: "claude-future-9", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }),
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		assert.match(await response.text(), /Hello from the future/);
		assert.equal(anthropic.received[0]!.path, "/v1/messages?beta=true", "the query string is forwarded");
		assert.equal(anthropic.received[0]!.headers["anthropic-beta"], "fine-grained-tool-streaming-2025-05-14", "API headers are forwarded");
		assert.equal(anthropic.received[0]!.headers["anthropic-version"], "2023-06-01");
		await stack.proxy.flush();
		const [row] = stack.store.calls(TENANT_A);
		assert.equal(row!.model, "claude-future-9");
		assert.equal(row!.inputTokens, 1_000);
		assert.equal(row!.outputTokens, 100);
		assert.equal(row!.dollars, null, "no dollar amount: the row is unpriced");
		assert.equal(anthropic.received.length, 1);
	});

	it("a non-streaming call is metered from the response body", async () => {
		const usage = { input: 2_000, cacheRead: 1_000, output: 300 };
		const { stack } = await start([{ text: "Not streamed.", usage }]);
		const response = await fetch(`${stack.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": PASS_A, "anthropic-version": "2023-06-01" },
			body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 500, messages: [{ role: "user", content: "hi" }] }),
		});
		assert.equal(response.status, 200);
		const body = (await response.json()) as { content: Array<{ text: string }> };
		assert.equal(body.content[0]!.text, "Not streamed.");
		await stack.proxy.flush();
		const [row] = stack.store.calls(TENANT_A);
		assert.deepEqual([row!.inputTokens, row!.cacheReadTokens, row!.outputTokens], [2_000, 1_000, 300]);
		assert.ok(Math.abs(row!.dollars! - expectedDollars("claude-opus-5-5", usage)) < 0.01);
	});

	it("refuses an unknown pass key and any call type outside the meter", async () => {
		const { anthropic, stack } = await start([]);
		const post = (route: string, key: string, method = "POST") =>
			fetch(`${stack.url}${route}`, {
				method,
				headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
				...(method === "POST" ? { body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [] }) } : {}),
			});
		assert.equal((await post("/v1/messages", "sk-ant-api03-a-real-looking-key")).status, 401);
		assert.equal((await post("/v1/messages", makePassKey("a-different-secret-of-enough-length-00", TENANT_A))).status, 401);
		assert.equal((await post("/v1/messages/batches", PASS_A)).status, 404, "batches would skip the meter");
		assert.equal((await post("/v1/files", PASS_A)).status, 404);
		assert.equal((await post("/v1/messages", PASS_A, "GET")).status, 404);
		assert.equal((await post("/tavily/search", PASS_A)).status, 404, "no Tavily key configured here");
		assert.equal(anthropic.received.length, 0, "none of these reached Anthropic");

		// Counting tokens is free: forwarded, never metered.
		const counted = await post("/v1/messages/count_tokens", PASS_A);
		assert.equal(counted.status, 200);
		assert.deepEqual(await counted.json(), { input_tokens: 42 });
		assert.equal(anthropic.received.at(-1)!.headers["x-api-key"], REAL_ANTHROPIC_KEY);
		await stack.proxy.flush();
		assert.equal(stack.store.calls().length, 0);
	});
});

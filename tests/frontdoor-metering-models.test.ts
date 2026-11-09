/**
 * The models.ts edit for metering (P2-01, X2). With LH_ANTHROPIC_BASE_URL
 * unset, Anthropic requests go where upstream sends them. With it set,
 * every Anthropic request goes to that address (the metering proxy),
 * whichever caller makes it. A stub fetch answers: no network, no key.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { blockExternalFetch, sseEvents } from "./frontdoor-metering-fakes.ts";

blockExternalFetch();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-metering-models-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
// pi-ai refuses to build a request without some key. Never a real one.
process.env.ANTHROPIC_API_KEY = "test-placeholder-not-a-key";

const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");

afterEach(() => {
	delete process.env.LH_ANTHROPIC_BASE_URL;
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** A fetch that records each request's address (without the query) and answers with one short scripted reply. */
function stubFetch() {
	const urls: string[] = [];
	const fetchFn = (async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		urls.push(`${url.origin}${url.pathname}`);
		const body = sseEvents("claude-opus-5-5", { text: "ok", usage: { input: 10, output: 2 } }).join("");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	return { urls, fetchFn };
}

const context = { messages: [{ role: "user" as const, content: "Teach me to decode a METAR.", timestamp: 1 }] };

/** One teaching-engine call, the way chat-handler's engines make it. */
async function engineCall(fetchFn: typeof fetch) {
	const engine = piEngineForSpec({ provider: "anthropic", id: "claude-opus-5-5" }, false);
	return engine.streamFn(engine.model, normalizeContext(context), { fetch: fetchFn }).result();
}

describe("models.ts metering route (LH_ANTHROPIC_BASE_URL)", () => {
	it("unset: Anthropic requests go to api.anthropic.com, as upstream", async () => {
		delete process.env.LH_ANTHROPIC_BASE_URL;
		const { urls, fetchFn } = stubFetch();
		const message = await engineCall(fetchFn);
		assert.equal(message.stopReason, "stop", message.errorMessage);
		assert.deepEqual(urls, ["https://api.anthropic.com/v1/messages"]);
	});

	it("set: Anthropic requests go to the metering proxy", async () => {
		process.env.LH_ANTHROPIC_BASE_URL = "http://127.0.0.1:9/metering";
		const { urls, fetchFn } = stubFetch();
		const message = await engineCall(fetchFn);
		assert.equal(message.stopReason, "stop", message.errorMessage);
		assert.deepEqual(urls, ["http://127.0.0.1:9/metering/v1/messages"]);
	});

	it("set: a direct Models call is routed too, so compaction, extraction and imports are covered (D29)", async () => {
		process.env.LH_ANTHROPIC_BASE_URL = "http://127.0.0.1:9/metering";
		const { urls, fetchFn } = stubFetch();
		const model = piModels().getModel("anthropic", "claude-haiku-5-5")!;
		await piModels().streamSimple(model, context, { fetch: fetchFn }).result();
		await piModels().stream(model, context, { fetch: fetchFn }).result();
		assert.deepEqual(urls, ["http://127.0.0.1:9/metering/v1/messages", "http://127.0.0.1:9/metering/v1/messages"]);
	});

	it("the catalog is untouched either way: models keep upstream's base URL and prices", () => {
		const before = structuredClone(piModels().getModel("anthropic", "claude-opus-5-5"));
		process.env.LH_ANTHROPIC_BASE_URL = "http://127.0.0.1:9/metering";
		const during = piModels().getModel("anthropic", "claude-opus-5-5")!;
		assert.equal(during.baseUrl, "https://api.anthropic.com");
		assert.deepEqual(structuredClone(during), before);
	});
});

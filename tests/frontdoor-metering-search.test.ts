/**
 * The search counter (P2-02: C3 requirement 7, N11, X2). The search.ts
 * edit sends Tavily searches to the metering proxy when
 * LH_TAVILY_BASE_URL is set. The proxy counts each tenant's successful
 * searches and swaps the pass key for the real Tavily key. The fee is
 * searches x $0.008. A fake Tavily answers: no network, no key.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { REAL_TAVILY_KEY, TEST_PASS_KEY_SECRET, blockExternalFetch, startFakeTavily, startMeteringProxy, type FakeServer } from "./frontdoor-metering-fakes.ts";
import { makePassKey } from "../frontdoor/metering/pass-key.ts";

blockExternalFetch();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-metering-search-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });

const { tavilyProvider } = await import("../src/server/search.ts");
const { searchFeeDollars, SEARCH_FEE_DOLLARS } = await import("../frontdoor/metering/price.ts");
const { PAUSED_MESSAGE } = await import("../frontdoor/metering/proxy.ts");

const TENANT_A = "tenant-a-0001";
const TENANT_B = "tenant-b-0002";
const PASS_A = makePassKey(TEST_PASS_KEY_SECRET, TENANT_A);
const PASS_B = makePassKey(TEST_PASS_KEY_SECRET, TENANT_B);

type Stack = Awaited<ReturnType<typeof startMeteringProxy>>;
let tavily: FakeServer | undefined;
let stack: Stack | undefined;

async function start() {
	tavily = await startFakeTavily();
	// No Anthropic call happens in this file; the address is never dialed.
	stack = await startMeteringProxy({ anthropicUrl: "http://127.0.0.1:9", tavilyUrl: tavily.url });
	process.env.LH_TAVILY_BASE_URL = `${stack.url}/tavily`;
	return { tavily, stack };
}

afterEach(async () => {
	await stack?.close();
	await tavily?.close();
	stack = undefined;
	tavily = undefined;
	delete process.env.LH_TAVILY_BASE_URL;
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe("search counter", () => {
	it("C3: searches are counted per tenant, and the fee is searches x $0.008", async () => {
		const { tavily, stack } = await start();
		const a = tavilyProvider(PASS_A);
		const b = tavilyProvider(PASS_B);

		const hits = await a.search("METAR format", 5);
		assert.deepEqual(hits, [{ title: "About METAR format", url: "https://www.faa.gov/", snippet: "Fake result." }], "the tenant gets Tavily's results");
		await a.search("TAF format", 5);
		await a.search("PIREP format", 5);
		await b.search("Class B airspace", 5);
		await assert.rejects(a.search("fail", 5), /Tavily search API 500/, "a failed search reaches the tenant as before");
		await stack.proxy.flush();

		assert.equal(stack.store.searches(TENANT_A).length, 3, "only successful searches count");
		assert.equal(stack.store.searches(TENANT_B).length, 1);
		assert.equal(SEARCH_FEE_DOLLARS, 0.008);
		assert.equal(searchFeeDollars(stack.store.searches(TENANT_A).length), 0.024);
		assert.equal(searchFeeDollars(stack.store.searches(TENANT_B).length), 0.008);
		assert.equal(searchFeeDollars(1_000), 8);
		for (const search of stack.store.searches()) assert.ok(search.at instanceof Date);

		// Only the proxy holds the real Tavily key.
		assert.equal(tavily.received.length, 5);
		for (const request of tavily.received) {
			assert.equal(request.path, "/search");
			assert.equal(request.headers.authorization, `Bearer ${REAL_TAVILY_KEY}`);
		}
	});

	it("a paused tenant's search is refused with the pause notice", async () => {
		const { tavily, stack } = await start();
		stack.store.setPaused(TENANT_A, true);
		await assert.rejects(tavilyProvider(PASS_A).search("METAR format", 5), (error: Error) => error.message.includes(PAUSED_MESSAGE));
		await tavilyProvider(PASS_B).search("METAR format", 5);
		await stack.proxy.flush();
		assert.equal(stack.store.searches(TENANT_A).length, 0);
		assert.equal(stack.store.searches(TENANT_B).length, 1);
		assert.equal(tavily.received.length, 1, "A's search never reached Tavily");
	});

	it("an unknown pass key is refused and not counted", async () => {
		const { tavily, stack } = await start();
		await assert.rejects(tavilyProvider("tvly-a-real-looking-key").search("METAR format", 5), /Tavily search API 401/);
		await stack.proxy.flush();
		assert.equal(stack.store.searches().length, 0);
		assert.equal(tavily.received.length, 0);
	});

	it("search.ts with LH_TAVILY_BASE_URL unset calls api.tavily.com, as upstream", async () => {
		delete process.env.LH_TAVILY_BASE_URL;
		const urls: string[] = [];
		const stub = async (input: string) => {
			urls.push(input);
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		};
		await tavilyProvider("tvly-throwaway-key-00001", stub).search("q", 3);
		assert.deepEqual(urls, ["https://api.tavily.com/search"]);

		process.env.LH_TAVILY_BASE_URL = "http://127.0.0.1:9/tavily/";
		await tavilyProvider("tvly-throwaway-key-00001", stub).search("q", 3);
		assert.equal(urls[1], "http://127.0.0.1:9/tavily/search", "a trailing slash is tolerated");
	});
});

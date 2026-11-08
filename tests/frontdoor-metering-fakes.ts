/**
 * Test doubles for the metering proxy (P2-01, P2-02): a fake Anthropic
 * Messages API and a fake Tavily search API, both on 127.0.0.1. No real
 * call leaves the machine and no API key is needed. Each fake records what
 * it received, so a test can check that the proxy swapped the tenant's
 * pass key for the real key.
 *
 * This file is a helper, not a test file: `npm test` runs tests/*.test.ts.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

/** The usage a scripted reply reports, in Anthropic's own terms. */
export interface ScriptedUsage {
	input: number;
	output: number;
	cacheRead?: number;
	/** All cache-write tokens, 5-minute and 1-hour together. */
	cacheWrite?: number;
	/** The 1-hour part of cacheWrite. */
	cacheWrite1h?: number;
}

export interface ScriptedReply {
	usage: ScriptedUsage;
	text?: string;
	toolCall?: { id: string; name: string; input: unknown };
	/** Send message_start, then hold the stream open: a call cut off midway. */
	stall?: boolean;
}

export interface Received {
	path: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}

export interface FakeServer {
	url: string;
	received: Received[];
	close(): Promise<void>;
}

export interface FakeAnthropic extends FakeServer {
	/** Streams currently held open by a `stall` reply. */
	stalled(): number;
}

/** A reply queue (in call order) or a chooser that reads the request. */
export type Script = ScriptedReply[] | ((request: { model: string; body: Record<string, unknown> }) => ScriptedReply);

/** Anthropic's usage object for a scripted reply. */
function anthropicUsage(usage: ScriptedUsage, output: number) {
	const cacheWrite = usage.cacheWrite ?? 0;
	const cacheWrite1h = usage.cacheWrite1h ?? 0;
	return {
		input_tokens: usage.input,
		cache_creation_input_tokens: cacheWrite,
		cache_read_input_tokens: usage.cacheRead ?? 0,
		cache_creation: { ephemeral_5m_input_tokens: cacheWrite - cacheWrite1h, ephemeral_1h_input_tokens: cacheWrite1h },
		output_tokens: output,
	};
}

let messageCounter = 0;

/** The SSE events of one scripted reply, as the Messages API streams them. */
export function sseEvents(model: string, reply: ScriptedReply): string[] {
	const events: string[] = [];
	const send = (type: string, data: unknown) => events.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
	send("message_start", {
		type: "message_start",
		message: {
			id: `msg_fake_${++messageCounter}`,
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			// The real API reports a small running output count here and the
			// final count in message_delta.
			usage: anthropicUsage(reply.usage, 1),
		},
	});
	if (reply.stall) return events;
	let index = 0;
	if (reply.text !== undefined) {
		send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
		send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: reply.text } });
		send("content_block_stop", { type: "content_block_stop", index });
		index += 1;
	}
	if (reply.toolCall) {
		const { id, name, input } = reply.toolCall;
		send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
		send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
		send("content_block_stop", { type: "content_block_stop", index });
	}
	send("message_delta", {
		type: "message_delta",
		delta: { stop_reason: reply.toolCall ? "tool_use" : "end_turn", stop_sequence: null },
		usage: { output_tokens: reply.usage.output },
	});
	send("message_stop", { type: "message_stop" });
	return events;
}

/** One whole scripted reply as a non-streaming Messages API body. */
export function messageBody(model: string, reply: ScriptedReply) {
	return {
		id: `msg_fake_${++messageCounter}`,
		type: "message",
		role: "assistant",
		model,
		content: reply.text !== undefined ? [{ type: "text", text: reply.text }] : [],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: anthropicUsage(reply.usage, reply.usage.output),
	};
}

function listen(server: http.Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}`);
		});
	});
}

function closeServer(server: http.Server): Promise<void> {
	server.closeAllConnections();
	return new Promise((resolve) => server.close(() => resolve()));
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** A fake Anthropic Messages API: POST /v1/messages and /v1/messages/count_tokens. */
export async function startFakeAnthropic(script: Script): Promise<FakeAnthropic> {
	const received: Received[] = [];
	const queue = Array.isArray(script) ? [...script] : null;
	let stalled = 0;
	const server = http.createServer((req, res) => {
		void readBody(req).then((raw) => {
			received.push({ path: req.url ?? "", headers: req.headers, body: raw });
			const body = JSON.parse(raw) as Record<string, unknown>;
			const model = typeof body.model === "string" ? body.model : "unknown";
			if (new URL(req.url ?? "/", "http://fake").pathname === "/v1/messages/count_tokens") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ input_tokens: 42 }));
				return;
			}
			const reply = queue ? queue.shift() : (script as Exclude<Script, ScriptedReply[]>)({ model, body });
			if (!reply) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "script exhausted" } }));
				return;
			}
			if (body.stream !== true) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(messageBody(model, reply)));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			for (const event of sseEvents(model, reply)) res.write(event);
			if (reply.stall) {
				stalled += 1;
				res.on("close", () => {
					stalled -= 1;
				});
				return;
			}
			res.end();
		});
	});
	const url = await listen(server);
	return { url, received, stalled: () => stalled, close: () => closeServer(server) };
}

/** A fake Tavily search API: POST /search. The query "fail" gets a 500. */
export async function startFakeTavily(): Promise<FakeServer> {
	const received: Received[] = [];
	const server = http.createServer((req, res) => {
		void readBody(req).then((raw) => {
			received.push({ path: req.url ?? "", headers: req.headers, body: raw });
			const body = JSON.parse(raw) as { query?: string };
			if (body.query === "fail") {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ detail: { error: "fake Tavily failure" } }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ results: [{ title: `About ${body.query}`, url: "https://www.faa.gov/", content: "Fake result." }] }));
		});
	});
	const url = await listen(server);
	return { url, received, close: () => closeServer(server) };
}

/**
 * Make every fetch to a host other than 127.0.0.1 fail at once, so a
 * routing bug can never send a request to a real API. Call it before the
 * first import that reaches pi-ai.
 */
export function blockExternalFetch(): void {
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname !== "127.0.0.1") return Promise.reject(new Error(`test network guard: blocked a request to ${url.host}`));
		return realFetch(input, init);
	}) as typeof fetch;
}

/** Made-up keys and secret for tests. The "real" keys stand for the ones only the proxy holds. */
export const TEST_PASS_KEY_SECRET = "metering-test-secret-0123456789abcdef";
export const REAL_ANTHROPIC_KEY = "test-real-anthropic-key-held-by-proxy";
export const REAL_TAVILY_KEY = "test-real-tavily-key-held-by-proxy";

/**
 * The metering proxy on 127.0.0.1 in front of the fakes, with an in-memory
 * store. Imported lazily: the proxy reaches upstream's config.ts (through
 * pricing), which reads LH_DATA_DIR once, so each test sets that first.
 */
export async function startMeteringProxy(upstream: { anthropicUrl: string; tavilyUrl?: string }) {
	const { createMeteringProxy } = await import("../frontdoor/metering/proxy.ts");
	const { createMemoryMeteringStore } = await import("../frontdoor/metering/store.ts");
	const { passKeyResolver } = await import("../frontdoor/metering/pass-key.ts");
	const store = createMemoryMeteringStore();
	const proxy = createMeteringProxy({
		store,
		resolveTenant: passKeyResolver(TEST_PASS_KEY_SECRET),
		anthropic: { apiKey: REAL_ANTHROPIC_KEY, baseUrl: upstream.anthropicUrl },
		...(upstream.tavilyUrl ? { tavily: { apiKey: REAL_TAVILY_KEY, baseUrl: upstream.tavilyUrl } } : {}),
	});
	const server = http.createServer(proxy.handle);
	const url = await listen(server);
	return {
		url,
		store,
		proxy,
		close: async () => {
			await proxy.flush();
			await closeServer(server);
		},
	};
}

/** Poll until `check` is true (the proxy records after the response ends). */
export async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * The metering proxy (X2 option A; C3 requirements 4, 6 and 7; D29).
 *
 * Each tenant's LearnHarness server sends its Anthropic calls here
 * (LH_ANTHROPIC_BASE_URL, src/agent/models.ts) and its Tavily searches here
 * (LH_TAVILY_BASE_URL, src/server/search.ts), with the tenant's pass key
 * where the real API key would go. For each request the proxy:
 *  1. finds the tenant from the pass key, and refuses a paused tenant;
 *  2. swaps in the real key and forwards the request, streaming included;
 *  3. records each model call's tokens and list-price dollars, and counts
 *     each successful search, through the MeteringStore.
 *
 * Only the call types LearnHarness uses pass: POST /v1/messages (metered),
 * POST /v1/messages/count_tokens (free, not metered) and POST
 * /tavily/search. Anything else gets 404, so nothing goes around the meter.
 *
 * Plain Node, no Next.js. The front door mounts `handle` on a private port.
 * Logs carry no session text: only tenant ids, statuses and error names.
 */

import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { listPrice } from "./price.ts";
import { type MeteringStore, MeteringUnavailableError, type TokenUsage, UNAVAILABLE_MESSAGE } from "./store.ts";
import { createUsageTap, usageFromMessage, type SeenUsage, type UsageTap } from "./usage.ts";

/** What a paused student sees (C3 requirement 6). */
export const PAUSED_MESSAGE = "Your account is paused for a fair-use review. Contact North Aero.";

const ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com";
const TAVILY_DEFAULT_URL = "https://api.tavily.com";
/** Anthropic's own Messages API request limit; a bigger body would be refused there anyway. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const MESSAGES_PATH = "/v1/messages";
const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";
const TAVILY_SEARCH_PATH = "/tavily/search";

/** Request headers that stay at the proxy: hop-by-hop, length, encoding, and the tenant's pass key. */
const DROP_REQUEST_HEADERS = new Set([
	"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
	"host", "content-length", "accept-encoding", "x-api-key", "authorization",
]);
/** Response headers that do not carry over: hop-by-hop, and length and encoding (fetch hands over a decoded body). */
const DROP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);

export interface MeteringProxyOptions {
	store: MeteringStore;
	/** The tenant for a pass key, or null when the key is not valid (see pass-key.ts). */
	resolveTenant: (passKey: string) => string | null;
	/** The real Anthropic key, held only here. baseUrl is for tests. */
	anthropic: { apiKey: string; baseUrl?: string };
	/** The real Tavily key, held only here. Without it, searches get 404. */
	tavily?: { apiKey: string; baseUrl?: string };
	/** Dollars for one call. Defaults to upstream's list price (price.ts). */
	price?: (model: string, usage: TokenUsage) => number | null;
	now?: () => Date;
	/** Where operational lines go. Defaults to console.error. */
	log?: (line: string) => void;
}

export interface MeteringProxy {
	/** A node:http request handler. */
	handle(req: IncomingMessage, res: ServerResponse): void;
	/** Resolves when every usage record already started has been written. Call before shutdown. */
	flush(): Promise<void>;
}

type Api = "anthropic" | "tavily";

class BodyTooLarge extends Error {}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/** An error body in the shape the tenant's client reads: Anthropic's for model calls, Tavily's for searches. */
function sendError(res: ServerResponse, api: Api, status: number, type: string, message: string): void {
	const body = api === "tavily" ? { detail: { error: message } } : { type: "error", error: { type, message } };
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/** The pass key from x-api-key (Anthropic) or a Bearer authorization header (Tavily, or an Anthropic auth token). */
function passKeyOf(headers: IncomingHttpHeaders, api: Api): string | undefined {
	const apiKey = headers["x-api-key"];
	if (api === "anthropic" && typeof apiKey === "string" && apiKey) return apiKey;
	const auth = headers.authorization;
	const match = typeof auth === "string" ? /^Bearer\s+(.+)$/i.exec(auth) : null;
	return match?.[1]?.trim() || undefined;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				req.pause();
				reject(new BodyTooLarge());
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function forwardHeaders(incoming: IncomingHttpHeaders, auth: Record<string, string>): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming)) {
		if (value === undefined || DROP_REQUEST_HEADERS.has(name)) continue;
		headers.set(name, Array.isArray(value) ? value.join(", ") : value);
	}
	// Plain bytes back, so the usage events can be read as they pass.
	headers.set("accept-encoding", "identity");
	for (const [name, value] of Object.entries(auth)) headers.set(name, value);
	return headers;
}

function responseHeaders(upstream: Response): Record<string, string> {
	const headers: Record<string, string> = {};
	upstream.headers.forEach((value, name) => {
		if (!DROP_RESPONSE_HEADERS.has(name)) headers[name] = value;
	});
	return headers;
}

/** The model the request asked for. A body that is not JSON is forwarded as is and Anthropic answers it. */
function requestedModel(body: Buffer): string | undefined {
	try {
		const parsed = JSON.parse(body.toString("utf8")) as { model?: unknown };
		return typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
	} catch {
		return undefined;
	}
}

/** Write one chunk, waiting while the client's buffer is full. False once the client has gone. */
async function write(res: ServerResponse, chunk: Uint8Array): Promise<boolean> {
	if (res.destroyed) return false;
	if (res.write(chunk)) return true;
	await new Promise<void>((resolve) => {
		const done = () => {
			res.off("drain", done);
			res.off("close", done);
			resolve();
		};
		res.on("drain", done);
		res.on("close", done);
	});
	return !res.destroyed;
}

export function createMeteringProxy(options: MeteringProxyOptions): MeteringProxy {
	const anthropicUrl = trimSlash(options.anthropic.baseUrl ?? ANTHROPIC_DEFAULT_URL);
	const tavilyUrl = trimSlash(options.tavily?.baseUrl ?? TAVILY_DEFAULT_URL);
	const price = options.price ?? listPrice;
	const now = options.now ?? (() => new Date());
	const log = options.log ?? ((line: string) => console.error(line));
	const inFlight = new Set<Promise<void>>();

	/** Keep a usage write in view of flush(). Writes never throw: a failure is logged without session text. */
	function track(task: () => Promise<void>, what: string, tenantId: string): void {
		const pending = task().catch((error: unknown) => {
			log(`metering: could not record a ${what} for tenant ${tenantId} (${(error as Error)?.name ?? "Error"})`);
		});
		inFlight.add(pending);
		void pending.finally(() => inFlight.delete(pending));
	}

	function recordCall(tenantId: string, model: string, usage: TokenUsage, requestId: string): void {
		track(async () => {
			const dollars = price(model, usage);
			await options.store.recordCall({ tenantId, at: now(), model, ...usage, dollars, requestId });
		}, "model call", tenantId);
	}

	async function forwardAnthropic(req: IncomingMessage, res: ServerResponse, target: string, body: Buffer, tenantId: string, metered: boolean): Promise<void> {
		const controller = new AbortController();
		// The tenant hung up (a stopped turn, an aborted job): stop the upstream call too.
		res.on("close", () => {
			if (!res.writableFinished) controller.abort();
		});
		const model = requestedModel(body);
		let upstream: Response;
		try {
			upstream = await fetch(`${anthropicUrl}${target}`, {
				method: "POST",
				headers: forwardHeaders(req.headers, { "x-api-key": options.anthropic.apiKey }),
				body: new Uint8Array(body),
				signal: controller.signal,
			});
		} catch (error) {
			if (controller.signal.aborted) return;
			throw error;
		}
		res.writeHead(upstream.status, responseHeaders(upstream));
		res.flushHeaders();
		if (!upstream.body) {
			res.end();
			return;
		}
		const meter = metered && upstream.ok;
		const streaming = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
		const tap: UsageTap | null = meter && streaming ? createUsageTap() : null;
		const whole: Buffer[] | null = meter && !streaming ? [] : null;
		const reader = upstream.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				tap?.push(value);
				whole?.push(Buffer.from(value));
				if (!(await write(res, value))) {
					await reader.cancel().catch(() => undefined);
					break;
				}
			}
			if (!res.destroyed) res.end();
		} catch {
			// Upstream failed or the tenant hung up mid-stream: close the reply, keep what was seen.
			if (!res.destroyed) res.destroy();
		} finally {
			let seen: SeenUsage = { usage: null, model: undefined, messageId: undefined };
			if (tap) {
				tap.end();
				seen = { usage: tap.usage, model: tap.model, messageId: tap.messageId };
			} else if (whole) {
				try {
					seen = usageFromMessage(JSON.parse(Buffer.concat(whole).toString("utf8")));
				} catch {
					// A body that is not a whole JSON message carries no usage to record.
				}
			}
			if (seen.usage) {
				const requestId = upstream.headers.get("request-id") || seen.messageId || `proxy-${randomUUID()}`;
				recordCall(tenantId, model ?? seen.model ?? "unknown", seen.usage, requestId);
			}
		}
	}

	async function forwardSearch(req: IncomingMessage, res: ServerResponse, body: Buffer, tenantId: string, apiKey: string): Promise<void> {
		const upstream = await fetch(`${tavilyUrl}/search`, {
			method: "POST",
			headers: forwardHeaders(req.headers, { authorization: `Bearer ${apiKey}` }),
			body: new Uint8Array(body),
		});
		const payload = Buffer.from(await upstream.arrayBuffer());
		// Tavily bills a search it answered; a failed one is not counted.
		if (upstream.ok) track(() => options.store.recordSearch({ tenantId, at: now() }), "search", tenantId);
		res.writeHead(upstream.status, responseHeaders(upstream));
		res.end(payload);
	}

	async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://metering.invalid");
		const kind = url.pathname === MESSAGES_PATH ? "messages" : url.pathname === COUNT_TOKENS_PATH ? "count" : url.pathname === TAVILY_SEARCH_PATH ? "search" : null;
		const api: Api = kind === "search" ? "tavily" : "anthropic";
		if (!kind || req.method !== "POST" || (kind === "search" && !options.tavily)) {
			sendError(res, api, 404, "not_found_error", "Not found.");
			return;
		}
		const passKey = passKeyOf(req.headers, api);
		const tenantId = passKey ? options.resolveTenant(passKey) : null;
		if (!tenantId) {
			sendError(res, api, 401, "authentication_error", "Invalid pass key.");
			return;
		}
		if (await options.store.isPaused(tenantId)) {
			sendError(res, api, 403, "permission_error", PAUSED_MESSAGE);
			return;
		}
		let body: Buffer;
		try {
			body = await readBody(req);
		} catch (error) {
			if (!(error instanceof BodyTooLarge)) throw error;
			res.setHeader("connection", "close");
			sendError(res, api, 413, "request_too_large", "Request is too large.");
			return;
		}
		if (kind === "search") await forwardSearch(req, res, body, tenantId, options.tavily!.apiKey);
		else await forwardAnthropic(req, res, `${url.pathname}${url.search}`, body, tenantId, kind === "messages");
	}

	return {
		handle(req, res) {
			route(req, res).catch((error: unknown) => {
				log(`metering: request failed (${(error as Error)?.name ?? "Error"})`);
				const api: Api = (req.url ?? "").startsWith(TAVILY_SEARCH_PATH) ? "tavily" : "anthropic";
				if (res.headersSent) res.destroy();
				// The pause could not be checked: refuse, and say it is brief (DB-outage rule, 2026-11-08).
				else if (error instanceof MeteringUnavailableError) sendError(res, api, 503, "api_error", UNAVAILABLE_MESSAGE);
				else sendError(res, api, 502, "api_error", "Metering proxy error.");
			});
		},
		async flush() {
			while (inFlight.size > 0) await Promise.all([...inFlight]);
		},
	};
}

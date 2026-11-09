/**
 * A stand-in tenant server for tests/frontdoor-wiring-e2e.test.ts. The front
 * door's supervisor starts it exactly as it starts upstream's standalone
 * server: `node --import <log filter> <this file>`, with the tenant's own
 * environment. It answers:
 *
 *   GET  /                    "ok" (the supervisor's ready check)
 *   GET  /env                 its pid, environment, and whether the log filter is loaded
 *   POST /api/wiring/call     one model call through upstream's src/agent/models.ts
 *   POST /api/wiring/search   one Tavily search through upstream's src/server/search.ts
 *   POST /api/wiring/raw-call one Messages API call made by hand with the tenant's
 *                             variables, answering the status and body as received
 *   POST /api/wiring/print    one line to stdout and one to stderr
 *
 * Upstream code needs tsx (an enum in its imports), so tsx is registered
 * here; Node strips this file's own types. A helper, not a test file.
 */
import { createServer } from "node:http";
import { register } from "tsx/esm/api";

register();

// Never let a routing bug reach a real API.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.hostname !== "127.0.0.1") return Promise.reject(new Error(`test network guard: blocked ${url.host}`));
	return realFetch(input, init);
}) as typeof fetch;

const MODEL = "claude-opus-5-5";

async function modelCall(): Promise<unknown> {
	const { normalizeContext } = await import("@earendil-works/pi-ai");
	const { piEngineForSpec } = await import("../src/agent/models.ts");
	const engine = piEngineForSpec({ provider: "anthropic", id: MODEL }, false);
	const context = normalizeContext({ messages: [{ role: "user", content: "wiring test turn", timestamp: Date.now() }] });
	const message = await engine.streamFn(engine.model, context, {}).result();
	return { stopReason: message.stopReason, errorMessage: message.errorMessage, usage: message.usage };
}

async function search(): Promise<unknown> {
	const { tavilyProvider } = await import("../src/server/search.ts");
	const hits = await tavilyProvider(process.env.TAVILY_API_KEY ?? "").search("METAR format", 3);
	return { hits };
}

async function rawCall(): Promise<unknown> {
	const res = await fetch(`${process.env.LH_ANTHROPIC_BASE_URL}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
		body: JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "raw wiring call" }] }),
	});
	return { status: res.status, body: await res.text() };
}

/** Writes straight to the streams, past this process's log filter, as Node's crash printout does. */
async function print(): Promise<unknown> {
	process.stdout.write("stdout routine line that must not reach the front door\n");
	process.stderr.write('Error: tenant failure for pilot@example.com: "Explain the METAR for KSFO"\n');
	return { printed: true };
}

const ROUTES: Record<string, () => Promise<unknown>> = {
	"/api/wiring/call": modelCall,
	"/api/wiring/search": search,
	"/api/wiring/raw-call": rawCall,
	"/api/wiring/print": print,
};

createServer((req, res) => {
	const json = (status: number, body: unknown) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (req.url === "/env") {
		const marked = console as unknown as Record<symbol, unknown>;
		return json(200, { pid: process.pid, env: process.env, logFilter: marked[Symbol.for("north-aero.log-filter")] === true });
	}
	const route = req.method === "POST" ? ROUTES[req.url ?? ""] : undefined;
	if (route) {
		route().then(
			(body) => json(200, body),
			(error: unknown) => json(500, { error: (error as Error).message }),
		);
		return;
	}
	res.end("ok");
}).listen(Number(process.env.PORT), process.env.HOSTNAME);

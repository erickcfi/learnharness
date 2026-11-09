/**
 * A real tenant server for tests/frontdoor-isolation-tenants.test.ts (W2-6,
 * C1 suite). The front door's supervisor starts it exactly as it starts
 * upstream's standalone server (`node --import <log filter> <this file>`,
 * with the tenant's own environment and secret). It runs upstream's own code
 * for everything that matters:
 *
 *  - every request first goes through upstream's proxy.ts (wall A), on every
 *    path;
 *  - /api requests run upstream's route handlers from app/api, unchanged,
 *    against this process's LH_DATA_DIR (one data root per process);
 *  - pages answer a plain placeholder (Next.js page rendering is the one part
 *    not run here; proxy.ts covers pages the same way, and the C1 data walls
 *    are in the API);
 *  - /__harness/* (behind proxy.ts too) lets the test run an upstream agent
 *    tool inside this tenant, and read this process's request count and pid.
 *
 * Upstream code needs tsx (an enum in its imports), so tsx is registered
 * here, as in tests/frontdoor-wiring-tenant.ts. A helper, not a test file.
 */
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

register();

const ROOT = path.join(import.meta.dirname, "..", "..");
const API_DIR = path.join(ROOT, "app", "api");

// Never let a routing bug reach a real API: global fetch may only reach this
// machine (the meter). The web tools' guarded fetch does not use it.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.hostname !== "127.0.0.1") return Promise.reject(new Error(`test network guard: blocked ${url.host}`));
	return realFetch(input, init);
}) as typeof fetch;

interface Route {
	segments: string[];
	file: string;
}

function scan(dir: string, prefix: string[] = []): Route[] {
	const out: Route[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) out.push(...scan(path.join(dir, entry.name), [...prefix, entry.name]));
		else if (entry.name === "route.ts") out.push({ segments: prefix, file: path.join(dir, entry.name) });
	}
	return out;
}
const ROUTES = scan(API_DIR).sort((a, b) => a.segments.filter((s) => s.startsWith("[")).length - b.segments.filter((s) => s.startsWith("[")).length);

function match(pathname: string): { file: string; params: Record<string, string | string[]> } | null {
	const parts = pathname.split("/").slice(2).map((p) => decodeURIComponent(p));
	for (const route of ROUTES) {
		const params: Record<string, string | string[]> = {};
		let ok = true;
		for (let i = 0; i < route.segments.length; i++) {
			const want = route.segments[i] as string;
			if (want.startsWith("[...")) {
				const rest = parts.slice(i);
				if (rest.length === 0) ok = false;
				else params[want.slice(4, -1)] = rest;
				i = route.segments.length;
				break;
			}
			const got = parts[i];
			if (got === undefined || got === "") ok = false;
			else if (want.startsWith("[")) params[want.slice(1, -1)] = got;
			else if (want !== got) ok = false;
			if (!ok) break;
		}
		const catchAll = route.segments.some((s) => s.startsWith("[..."));
		if (ok && (catchAll || parts.length === route.segments.length)) return { file: route.file, params };
	}
	return null;
}

const modules = new Map<string, Promise<Record<string, unknown>>>();
const load = (file: string) => {
	let mod = modules.get(file);
	if (!mod) {
		mod = import(pathToFileURL(file).href) as Promise<Record<string, unknown>>;
		modules.set(file, mod);
	}
	return mod;
};

const { NextRequest } = await import("next/server");
const { proxy } = await import(pathToFileURL(path.join(ROOT, "proxy.ts")).href);

let hits = 0;

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function headersOf(req: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (Array.isArray(value)) for (const v of value) headers.append(name, v);
		else if (value !== undefined) headers.set(name, value);
	}
	return headers;
}

async function send(res: ServerResponse, response: Response): Promise<void> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, name) => {
		headers[name] = value;
	});
	res.writeHead(response.status, headers);
	if (!response.body) return void res.end();
	// Send the headers now, as Next.js does for a stream (a quiet SSE
	// stream would otherwise hold them until its first frame).
	res.flushHeaders();
	const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
	res.on("close", () => body.destroy());
	body.on("error", () => res.destroy());
	body.pipe(res);
}

const json = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
};

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
	type Tool = { execute?: (id: string, input: unknown) => Promise<unknown> };
	let found: unknown;
	if (name === "web_fetch") found = (await import("../../src/agent/tools/web.ts")).createWebTools(() => null).web_fetch;
	else if (name === "web_fetch_pdf") {
		const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "pdf-"));
		found = (await import("../../src/agent/tools/pdf-read.ts")).createPdfReadTools(dir).web_fetch_pdf;
	} else if (name === "read") found = (await import("../../src/agent/tools/read.ts")).readTool;
	else if (name === "ls") found = (await import("../../src/agent/tools/ls.ts")).lsTool;
	const tool = found as Tool | undefined;
	if (!tool?.execute) throw new Error(`unknown tool ${name}`);
	try {
		return JSON.stringify(await tool.execute("harness", input));
	} catch (error) {
		return `threw: ${(error as Error).message}`;
	}
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	hits++;
	const port = (server.address() as { port: number }).port;
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
	const method = req.method ?? "GET";

	// Wall A: upstream's proxy.ts, on every path.
	const verdict = proxy(new NextRequest(url, { method, headers: headersOf(req) })) as Response;
	if (verdict.headers.get("x-middleware-next") !== "1") return send(res, verdict);

	if (url.pathname === "/__harness/state") return json(res, 200, { hits, pid: process.pid, hosted: process.env.LH_HOSTED, tmpdir: process.env.TMPDIR, secretLength: process.env.LH_DESKTOP_API_SECRET?.length ?? 0 });
	if (url.pathname === "/__harness/tool" && method === "POST") {
		const { tool, input } = JSON.parse((await readBody(req)).toString("utf8")) as { tool: string; input: Record<string, unknown> };
		return json(res, 200, { output: await runTool(tool, input) });
	}

	if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		return void res.end(`harness page ${url.pathname}`);
	}
	const found = match(url.pathname);
	if (!found) return json(res, 500, { error: "harness bug: no such route" });
	const mod = await load(found.file);
	const handler = (mod[method] ?? (method === "HEAD" ? mod.GET : undefined)) as ((r: Request, ctx: unknown) => Promise<Response> | Response) | undefined;
	if (!handler) return json(res, 500, { error: "harness bug: no handler for this method" });
	const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
	const request = new Request(url, { method, headers: headersOf(req), ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}) });
	const response = await handler(request, { params: Promise.resolve(found.params) });
	return send(res, response);
}

const server = createServer((req, res) => {
	handle(req, res).catch((error: unknown) => {
		if (!res.headersSent) json(res, 500, { error: (error as Error).message });
		else res.destroy();
	});
});
server.listen(Number(process.env.PORT), process.env.HOSTNAME ?? "127.0.0.1");

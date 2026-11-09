/**
 * Pass one request through to a tenant's server and its answer back, piece
 * by piece (PRD X1 job 4). This is the X5 spike's method A: Next.js is not in
 * the path, so nothing can compress or hold back a stream
 * (docs/decisions/2026-11-08-x5-front-door-spike.md).
 */
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { stripLoginCookies } from "./cookies.ts";

/** Headers that belong to one connection, not to the message. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "transfer-encoding", "upgrade", "te", "trailer"]);

function connectionTokens(value: string | string[] | undefined): Set<string> {
	const joined = Array.isArray(value) ? value.join(",") : (value ?? "");
	return new Set(
		joined
			.split(",")
			.map((t) => t.trim().toLowerCase())
			.filter(Boolean),
	);
}

/** What the tenant receives: the browser's headers minus connection headers
 *  and login cookies, plus the usual forwarding headers. */
export function forwardRequestHeaders(req: IncomingMessage, proto: string): OutgoingHttpHeaders {
	const named = connectionTokens(req.headers.connection);
	const headers: OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined || HOP_BY_HOP.has(name) || named.has(name) || name === "cookie") continue;
		if (name.startsWith("x-forwarded-")) continue;
		headers[name] = value;
	}
	const cookie = stripLoginCookies(req.headers.cookie);
	if (cookie) headers.cookie = cookie;
	if (req.socket.remoteAddress) headers["x-forwarded-for"] = req.socket.remoteAddress;
	headers["x-forwarded-proto"] = proto;
	if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;
	return headers;
}

function responseHeaders(tenantRes: IncomingMessage, extraSetCookie: string[]): OutgoingHttpHeaders {
	const named = connectionTokens(tenantRes.headers.connection);
	const headers: OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(tenantRes.headers)) {
		if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue;
		headers[name] = value;
	}
	if (extraSetCookie.length > 0) {
		const existing = tenantRes.headers["set-cookie"] ?? [];
		headers["set-cookie"] = [...existing, ...extraSetCookie];
	}
	return headers;
}

export interface PassThroughOptions {
	port: number;
	/** Path and query, already normalized by the gateway. */
	path: string;
	proto: string;
	/** Cookies the front door sets on this answer (a renewed login). */
	setCookie?: string[];
}

export function passThrough(req: IncomingMessage, res: ServerResponse, options: PassThroughOptions): void {
	const upstream = httpRequest(
		{ host: "127.0.0.1", port: options.port, method: req.method, path: options.path, headers: forwardRequestHeaders(req, options.proto) },
		(tenantRes) => {
			res.writeHead(tenantRes.statusCode ?? 502, responseHeaders(tenantRes, options.setCookie ?? []));
			tenantRes.pipe(res);
			tenantRes.on("error", () => res.destroy());
		},
	);
	upstream.on("error", () => {
		if (!res.headersSent) {
			res.writeHead(502, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ error: "The tutor server did not answer." }));
		} else {
			res.destroy();
		}
	});
	// The browser went away (closed tab, ended stream): stop the tenant's side too.
	res.on("close", () => {
		if (!res.writableFinished) upstream.destroy();
	});
	req.pipe(upstream);
}

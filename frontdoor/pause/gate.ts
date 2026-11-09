/**
 * The gateway's hook for pause and retention (P2-05, P1-08; C3 req 6,
 * C1 req 6). gateway/handler.ts calls it after the login check and before
 * the request reaches the tenant's server.
 *
 *   tenant page loads (GET, not /api, not /_next):
 *     open       pass through
 *     paused     the pause screen, at the same address
 *     retention  the plan-ended screen, at the same address
 *     gone       signed out (the login cookie is cleared)
 *   /api requests:
 *     paused     pass through: an open tab can still read its chats; new
 *                turns and jobs are refused by the meter, with the pause
 *                message
 *     retention  403 with a short JSON message (no tenant server is reached)
 *     gone       401, signed out
 *   other files (/_next, images): pass through, except for gone.
 *
 *   GET /account/export  the student's data as a zip (any state but gone or
 *                        an expired retention), one at a time per tenant
 *   GET /account/record  the printable study record (same states)
 *
 * If the access state cannot be read (database down, nothing remembered),
 * the request passes through: the meter's pause check fails closed on its
 * own, so a short outage does not hide the tutor.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type AccessReader, type TenantAccess } from "./access.ts";
import { API_MESSAGES } from "./copy.ts";
import { EXPORT_PATH, pauseScreenHtml, RECORD_PATH, retentionScreenHtml } from "./screens.ts";

export interface TenantGateContext {
	tenantId: string;
	/** The Clerk user id of the signed-in student. */
	userId: string;
	pathname: string;
	/** Set-Cookie values the gateway owes this answer (a renewed login cookie). */
	setCookie: string[];
	/** Answer as for a signed-out request, clearing the login cookie. */
	signOut(): void;
}

export interface TenantGate {
	/** Front door paths outside the tenant that need the login (gateway/handler.ts routes them through the login check). */
	ownsPath(pathname: string): boolean;
	/** True when the gate answered; false to pass the request to the tenant's server. */
	handle(req: IncomingMessage, res: ServerResponse, ctx: TenantGateContext): Promise<boolean>;
}

/** Builds what the export and record links download (retention/export.ts). */
export interface TenantData {
	exportZip(tenantId: string, userId: string, timeZone: string): Promise<{ fileName: string; body: Buffer }>;
	recordHtml(tenantId: string, userId: string, timeZone: string): Promise<string>;
}

export interface TenantGateOptions {
	access: AccessReader;
	/** Without it, /account/export and /account/record answer 404. */
	data?: TenantData;
	log?: (line: string) => void;
}

const isApi = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");
const isRead = (req: IncomingMessage) => req.method === "GET" || req.method === "HEAD";

/** A browser page load: a document request, or Next.js's client navigation (RSC), which turns into a full load when it gets HTML. */
export function isPageLoad(req: IncomingMessage, pathname: string): boolean {
	if (!isRead(req) || isApi(pathname) || pathname.startsWith("/_next/")) return false;
	const dest = req.headers["sec-fetch-dest"];
	if (dest === "document" || req.headers["sec-fetch-mode"] === "navigate") return true;
	if (req.headers.rsc === "1") return true;
	const accept = String(req.headers.accept ?? "");
	return accept.includes("text/html");
}

/** An IANA zone name the runtime knows, else UTC. */
export function safeTimeZone(value: string | null | undefined): string {
	if (!value || value.length > 64) return "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return value;
	} catch {
		return "UTC";
	}
}

function errorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : ((error as Error | null)?.name ?? "Error");
}

export function createTenantGate(options: TenantGateOptions): TenantGate {
	const log = options.log ?? ((line: string) => console.error(line));
	const exporting = new Set<string>();

	function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer, ctx: TenantGateContext, head: boolean): void {
		res.writeHead(status, { "Cache-Control": "no-store", ...headers, ...(ctx.setCookie.length ? { "Set-Cookie": ctx.setCookie } : {}) });
		res.end(head ? undefined : body);
	}
	const html = (res: ServerResponse, status: number, body: string, ctx: TenantGateContext, head: boolean) =>
		send(res, status, { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" }, body, ctx, head);
	const json = (res: ServerResponse, status: number, body: object, ctx: TenantGateContext) =>
		send(res, status, { "Content-Type": "application/json" }, JSON.stringify(body), ctx, false);

	async function readAccess(tenantId: string): Promise<TenantAccess | null> {
		try {
			return await options.access.read(tenantId);
		} catch (error) {
			log(`gate: access for tenant ${tenantId} could not be read (${errorCode(error)}); passing through`);
			return null;
		}
	}

	async function handleData(req: IncomingMessage, res: ServerResponse, ctx: TenantGateContext, access: TenantAccess | null): Promise<void> {
		const head = req.method === "HEAD";
		if (!isRead(req)) return json(res, 405, { error: "Method not allowed." }, ctx);
		if (access?.state === "gone") return ctx.signOut();
		if (access?.state === "retention" && access.expired) return json(res, 410, { error: API_MESSAGES.expired }, ctx);
		if (!options.data) return json(res, 404, { error: "Not found." }, ctx);
		const timeZone = safeTimeZone(new URL(req.url ?? "/", "http://front.door").searchParams.get("tz"));

		if (ctx.pathname === RECORD_PATH) {
			try {
				const body = await options.data.recordHtml(ctx.tenantId, ctx.userId, timeZone);
				return html(res, 200, body, ctx, head);
			} catch (error) {
				log(`gate: study record for tenant ${ctx.tenantId} failed (${errorCode(error)})`);
				return json(res, 503, { error: API_MESSAGES.recordFailed }, ctx);
			}
		}

		if (exporting.has(ctx.tenantId)) return json(res, 429, { error: API_MESSAGES.exportBusy }, ctx);
		exporting.add(ctx.tenantId);
		try {
			const zip = await options.data.exportZip(ctx.tenantId, ctx.userId, timeZone);
			log(`export: tenant ${ctx.tenantId} downloaded ${zip.body.length} bytes`);
			return send(
				res,
				200,
				{ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${zip.fileName}"`, "Content-Length": String(zip.body.length) },
				zip.body,
				ctx,
				head,
			);
		} catch (error) {
			log(`export: tenant ${ctx.tenantId} failed (${errorCode(error)})`);
			return json(res, 503, { error: API_MESSAGES.exportFailed }, ctx);
		} finally {
			exporting.delete(ctx.tenantId);
		}
	}

	return {
		ownsPath: (pathname) => pathname === EXPORT_PATH || pathname === RECORD_PATH,
		async handle(req, res, ctx) {
			const access = await readAccess(ctx.tenantId);
			if (ctx.pathname === EXPORT_PATH || ctx.pathname === RECORD_PATH) {
				await handleData(req, res, ctx, access);
				return true;
			}
			if (!access || access.state === "open") return false;
			if (access.state === "gone") {
				ctx.signOut();
				return true;
			}
			const head = req.method === "HEAD";
			if (access.state === "paused") {
				if (!isPageLoad(req, ctx.pathname)) return false;
				html(res, 200, pauseScreenHtml(), ctx, head);
				return true;
			}
			// retention: nothing that writes reaches the tutor (API calls, form posts).
			if (isApi(ctx.pathname) || !isRead(req)) {
				json(res, 403, { error: access.expired ? API_MESSAGES.expired : API_MESSAGES.retention }, ctx);
				return true;
			}
			if (!isPageLoad(req, ctx.pathname)) return false;
			html(res, 200, retentionScreenHtml(access.retentionEndsAt, access.expired), ctx, head);
			return true;
		},
	};
}

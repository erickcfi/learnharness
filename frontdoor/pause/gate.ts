/**
 * The gateway's hook for pause and retention (P2-05, P1-08; C3 req 6,
 * C1 req 6). gateway/handler.ts calls it after the login check and before
 * the request reaches the tenant's server.
 *
 *   tenant page loads (GET, not /api, not /_next):
 *     open       pass through
 *     paused     the pause screen at the same address (interstitial.ts):
 *                "Read your sessions" lets tutor pages load again for an
 *                hour; the next full visit to "/" shows the screen again
 *     retention  the plan-ended screen at the same address
 *     gone       signed out (the login cookie is cleared)
 *   /api requests:
 *     paused     pass through: reading works; new turns and jobs are
 *                refused by the meter, with the pause message
 *     retention  403 with a short JSON message (no tenant server is reached)
 *     gone       401, signed out
 *   other files (/_next, images): pass through, except for gone.
 *
 *   GET /account/read-sessions  the pause screen's "Read your sessions"
 *   GET /account/export         the student's data as a zip (any state but
 *                               gone or an expired retention), one at a
 *                               time per tenant
 *   GET /account/record         the printable study record (same states)
 *
 * If the access state cannot be read (database down, nothing remembered),
 * the request passes through: the meter's pause check fails closed on its
 * own, so a short outage does not hide the tutor.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type AccessReader, type TenantAccess } from "./access.ts";
import { API_MESSAGES } from "./copy.ts";
import { interstitialDecision, isPageLoad, READ_PATH, readRedirect } from "./interstitial.ts";
import { EXPORT_PATH, pauseScreenHtml, RECORD_PATH, retentionScreenHtml } from "./screens.ts";

export { isPageLoad };

/** The interstitial kind (and read cookie value) for a paused tenant. */
export const PAUSED_KIND = "paused";

export interface TenantGateContext {
	tenantId: string;
	/** The Clerk user id of the signed-in student. */
	userId: string;
	pathname: string;
	/** Set-Cookie values for this answer, the pass-through's included. The gate may add to it. */
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
	exportZip(tenantId: string, userId: string): Promise<{ fileName: string; body: Buffer }>;
	recordHtml(tenantId: string, userId: string): Promise<string>;
}

export interface TenantGateOptions {
	access: AccessReader;
	/** Without it, /account/export and /account/record answer 404. */
	data?: TenantData;
	/** The read cookies get Secure, like the login cookie. */
	secureCookies?: boolean;
	log?: (line: string) => void;
}

const isApi = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");
const isRead = (req: IncomingMessage) => req.method === "GET" || req.method === "HEAD";

function errorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : ((error as Error | null)?.name ?? "Error");
}

export function createTenantGate(options: TenantGateOptions): TenantGate {
	const log = options.log ?? ((line: string) => console.error(line));
	const secure = options.secureCookies ?? false;
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

	function handleRead(req: IncomingMessage, res: ServerResponse, ctx: TenantGateContext, access: TenantAccess | null): void {
		if (!isRead(req)) return json(res, 405, { error: "Method not allowed." }, ctx);
		if (access?.state === "gone") return ctx.signOut();
		if (access?.state === "paused") {
			const r = readRedirect(PAUSED_KIND, secure);
			ctx.setCookie.push(...r.setCookie);
			return send(res, 303, { Location: r.location }, "", ctx, true);
		}
		// Not paused (any more): the tutor or the right screen is at "/".
		return send(res, 303, { Location: "/" }, "", ctx, true);
	}

	async function handleData(req: IncomingMessage, res: ServerResponse, ctx: TenantGateContext, access: TenantAccess | null): Promise<void> {
		const head = req.method === "HEAD";
		if (!isRead(req)) return json(res, 405, { error: "Method not allowed." }, ctx);
		if (access?.state === "gone") return ctx.signOut();
		if (access?.state === "retention" && access.expired) return json(res, 410, { error: API_MESSAGES.expired }, ctx);
		if (!options.data) return json(res, 404, { error: "Not found." }, ctx);

		if (ctx.pathname === RECORD_PATH) {
			try {
				return html(res, 200, await options.data.recordHtml(ctx.tenantId, ctx.userId), ctx, head);
			} catch (error) {
				log(`gate: study record for tenant ${ctx.tenantId} failed (${errorCode(error)})`);
				return json(res, 503, { error: API_MESSAGES.recordFailed }, ctx);
			}
		}

		if (exporting.has(ctx.tenantId)) return json(res, 429, { error: API_MESSAGES.exportBusy }, ctx);
		exporting.add(ctx.tenantId);
		try {
			const zip = await options.data.exportZip(ctx.tenantId, ctx.userId);
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
		ownsPath: (pathname) => pathname === EXPORT_PATH || pathname === RECORD_PATH || pathname === READ_PATH,
		async handle(req, res, ctx) {
			const access = await readAccess(ctx.tenantId);
			if (ctx.pathname === READ_PATH) {
				handleRead(req, res, ctx, access);
				return true;
			}
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
				const decision = interstitialDecision(req, ctx.pathname, PAUSED_KIND, secure);
				if (!decision.show) {
					ctx.setCookie.push(...decision.setCookie);
					return false;
				}
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

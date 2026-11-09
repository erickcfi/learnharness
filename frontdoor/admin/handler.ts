/**
 * /admin and everything under it (P3-01, C7 req 1). The gateway sends every
 * /admin request here. Each one is checked on the server, close to the
 * data (section 4 fact 7):
 *
 *   no login            pages redirect to sign-in, API calls get 401
 *   login, no role      403 (students, and Staff until it is granted any)
 *   Owner               pages go on to the Next.js pages in app/admin/;
 *                       API calls below run here, each with its permission
 *
 *   GET  /admin/api/overview?period=30d|month|all          dashboard.view
 *   GET  /admin/api/tenants/:id?period=                    dashboard.view
 *   GET  /admin/api/tenants/:id/sessions/:chat/text        sessionText.read (consent only)
 *   POST /admin/api/tenants/:id/pause | /unpause           tenants.pause
 *   POST /admin/api/tenants/:id/consents/tester            consents.record (note)
 *   POST /admin/api/tenants/:id/consents/tester/revoke     consents.record
 *   POST /admin/api/alerts/:id/clear                       alerts.clear
 *   POST /admin/api/thresholds                             settings.edit (alertUsd, autopauseUsd)
 *   GET  /admin/api/library                                library.manage
 *   PUT  /admin/api/library?area=&aircraft=&name=&replace=1  library.manage (the file is the body)
 *   POST /admin/api/library/remove                         library.manage (path, confirm=yes)
 *
 * Forms post with plain HTML and get a 303 back to the page they came from
 * (`back`), so the dashboard works without JavaScript except for uploads.
 * A caller that asks for JSON (Accept: application/json) gets JSON.
 * Every answer carries noindex and no-store; /admin is in no sitemap or
 * robots.txt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "../db/index.ts";
import type { ClerkGateway } from "../gateway/auth.ts";
import { serializeCookie } from "../gateway/cookies.ts";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "../gateway/session.ts";
import { LIBRARY_MAX_BYTES, LibraryError, listLibrary, removeLibraryFile, saveLibraryFile } from "../library/index.ts";
import { type AdminIdentity, LoginCheckUnavailableError, resolveAdminAccess } from "./access.ts";
import type { StudentDirectory } from "./directory.ts";
import { isSameOrigin } from "./origin.ts";
import { buildOverview } from "./overview.ts";
import { type AlertActions, type PauseActions } from "./pause.ts";
import { parsePeriod } from "./period.ts";
import type { Permission } from "./roles.ts";
import { readSessionText, recordTesterConsent, revokeTesterConsent, SessionTextNotAllowedError } from "./session-text.ts";
import { buildStudentDetail } from "./student.ts";
import { CHAT_ID, type TenantFetch } from "./tenant-api.ts";
import { parseThresholds, saveThresholds } from "./thresholds.ts";

export interface AdminHandlerDeps {
	/** Null outside production without SUPABASE_DB_URL: every admin route then answers 503. */
	db: Db | null;
	sessionSecret: Uint8Array;
	clerk: Pick<ClerkGateway, "isSessionActive">;
	secureCookies: boolean;
	trustForwardedHeaders: boolean;
	/** The front door's Next.js handler, for the pages in app/admin/. */
	frontDoorApp(req: IncomingMessage, res: ServerResponse): unknown;
	tenantFetch: TenantFetch;
	pause: PauseActions;
	alerts: AlertActions;
	libraryDir: string;
	directory?: StudentDirectory;
	now?: () => number;
	log?: (line: string) => void;
}

const MAX_FORM_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOINDEX = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** A back link inside /admin only, so a form can never send the Owner elsewhere. */
export function safeAdminPath(value: unknown, fallback = "/admin"): string {
	if (typeof value !== "string" || !value.startsWith("/admin") || value.startsWith("//") || /[\\\r\n]/.test(value)) return fallback;
	try {
		const u = new URL(value, "http://front.door");
		if (u.origin !== "http://front.door" || !(u.pathname === "/admin" || u.pathname.startsWith("/admin/"))) return fallback;
		u.searchParams.delete("done");
		u.searchParams.delete("error");
		return `${u.pathname}${u.search}`;
	} catch {
		return fallback;
	}
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				req.removeAllListeners("data");
				req.pause();
				reject(new HttpError(413, "Form too large."));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
	const raw = await readBody(req, MAX_FORM_BYTES);
	const type = String(req.headers["content-type"] ?? "");
	if (type.includes("application/json")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw || "{}");
		} catch {
			throw new HttpError(400, "Bad JSON.");
		}
		const form = new URLSearchParams();
		if (parsed && typeof parsed === "object") for (const [k, v] of Object.entries(parsed)) if (v !== null && v !== undefined) form.set(k, String(v));
		return form;
	}
	return new URLSearchParams(raw);
}

export function createAdminHandler(deps: AdminHandlerDeps): { handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> } {
	const now = () => (deps.now ? deps.now() : Date.now());

	/** A state change must come from the dashboard's own pages. */
	const sameOrigin = (req: IncomingMessage) => isSameOrigin(req, deps.trustForwardedHeaders);

	const wantsJson = (req: IncomingMessage) => String(req.headers.accept ?? "").includes("application/json");

	function send(res: ServerResponse, status: number, headers: Record<string, string | string[]>, body = ""): void {
		if (res.headersSent) return;
		res.writeHead(status, { ...NOINDEX, ...headers });
		res.end(body);
	}
	const sendJson = (res: ServerResponse, status: number, body: unknown) => send(res, status, { "Content-Type": "application/json" }, JSON.stringify(body));
	const sendText = (res: ServerResponse, status: number, text: string) => send(res, status, { "Content-Type": "text/plain; charset=utf-8" }, text);

	function refusePage(res: ServerResponse, status: number, message: string): void {
		send(
			res,
			status,
			{ "Content-Type": "text/html; charset=utf-8" },
			`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>North Aero Ground Tutor</title><p style="font:16px system-ui;margin:2rem">${message}</p>`,
		);
	}

	/** Answer a form post: JSON for API callers, a 303 back to the page for HTML forms. */
	function done(req: IncomingMessage, res: ServerResponse, form: URLSearchParams | null, result: { ok: true; done: string; data?: unknown } | { ok: false; status: number; error: string }): void {
		if (wantsJson(req) || !form) {
			if (result.ok) return sendJson(res, 200, { ok: true, done: result.done, ...(result.data !== undefined ? { data: result.data } : {}) });
			return sendJson(res, result.status, { ok: false, error: result.error });
		}
		const back = new URL(safeAdminPath(form.get("back")), "http://front.door");
		if (result.ok) back.searchParams.set("done", result.done);
		else back.searchParams.set("error", result.error);
		send(res, 303, { Location: `${back.pathname}${back.search}` });
	}

	async function api(req: IncomingMessage, res: ServerResponse, url: URL, who: AdminIdentity, db: Db): Promise<void> {
		const parts = url.pathname.split("/").filter(Boolean).slice(2); // after "admin", "api"
		const method = req.method ?? "GET";
		const isRead = method === "GET" || method === "HEAD";
		const need = async (permission: Permission) => {
			const access = await resolveAdminAccess({ db, sessionSecret: deps.sessionSecret, clerk: null, now: deps.now }, req.headers.cookie, permission);
			if (access.kind !== "allowed") throw new HttpError(403, "Forbidden.");
		};
		if (!isRead && !sameOrigin(req)) throw new HttpError(403, "Forbidden.");

		// GET /admin/api/overview
		if (parts[0] === "overview" && parts.length === 1 && isRead) {
			await need("dashboard.view");
			return sendJson(res, 200, await buildOverview(db, { period: parsePeriod(url.searchParams.get("period")), now: new Date(now()), directory: deps.directory }));
		}

		// /admin/api/tenants/:id...
		if (parts[0] === "tenants" && parts[1]) {
			const tenantId = parts[1];
			if (!UUID.test(tenantId)) throw new HttpError(404, "Not found.");
			if (parts.length === 2 && isRead) {
				await need("dashboard.view");
				const detail = await buildStudentDetail({ db, tenantFetch: deps.tenantFetch, directory: deps.directory }, tenantId, {
					period: parsePeriod(url.searchParams.get("period")),
					now: new Date(now()),
				});
				if (!detail) throw new HttpError(404, "Not found.");
				return sendJson(res, 200, detail);
			}
			if (parts[2] === "sessions" && parts[3] && parts[4] === "text" && parts.length === 5 && isRead) {
				await need("sessionText.read");
				const chatId = parts[3];
				if (!CHAT_ID.test(chatId)) throw new HttpError(404, "Not found.");
				try {
					return sendText(res, 200, await readSessionText({ db, tenantFetch: deps.tenantFetch }, tenantId, chatId));
				} catch (error) {
					if (error instanceof SessionTextNotAllowedError) throw new HttpError(403, error.message);
					throw error;
				}
			}
			if (method === "POST" && parts.length === 3 && (parts[2] === "pause" || parts[2] === "unpause")) {
				await need("tenants.pause");
				const form = await readForm(req);
				if (parts[2] === "pause") await deps.pause.pauseTenant(tenantId, "owner", who.accountId);
				else await deps.pause.unpauseTenant(tenantId, who.accountId);
				return done(req, res, form, { ok: true, done: parts[2] === "pause" ? "paused" : "unpaused" });
			}
			if (method === "POST" && parts[2] === "consents" && parts[3] === "tester") {
				await need("consents.record");
				const form = await readForm(req);
				if (parts.length === 4) {
					const note = (form.get("note") ?? "").trim().slice(0, 300);
					if (!note) return done(req, res, form, { ok: false, status: 400, error: "Write where the written OK is kept, for example: signed form, 2026-11-10." });
					await recordTesterConsent(db, { tenantId, recordedBy: who.accountId, note, at: new Date(now()) });
					return done(req, res, form, { ok: true, done: "consent-recorded" });
				}
				if (parts.length === 5 && parts[4] === "revoke") {
					await revokeTesterConsent(db, tenantId, new Date(now()));
					return done(req, res, form, { ok: true, done: "consent-revoked" });
				}
			}
		}

		// POST /admin/api/alerts/:id/clear
		if (parts[0] === "alerts" && parts.length === 3 && parts[2] === "clear" && method === "POST") {
			await need("alerts.clear");
			const id = Number(parts[1]);
			if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, "Not found.");
			const form = await readForm(req);
			await deps.alerts.clearAlert(id, who.accountId);
			return done(req, res, form, { ok: true, done: "alert-cleared" });
		}

		// POST /admin/api/thresholds
		if (parts[0] === "thresholds" && parts.length === 1 && method === "POST") {
			await need("settings.edit");
			const form = await readForm(req);
			const parsed = parseThresholds({ alertUsd: form.get("alertUsd") ?? undefined, autopauseUsd: form.get("autopauseUsd") ?? undefined });
			if (!parsed.ok) return done(req, res, form, { ok: false, status: 400, error: parsed.error });
			const saved = await saveThresholds(db, parsed.value, who.accountId);
			return done(req, res, form, { ok: true, done: "thresholds-saved", data: { alertUsd: saved.alertUsd, autopauseUsd: saved.autopauseUsd } });
		}

		// /admin/api/library
		if (parts[0] === "library") {
			await need("library.manage");
			if (parts.length === 1 && isRead) return sendJson(res, 200, await listLibrary(deps.libraryDir));
			if (parts.length === 1 && method === "PUT") {
				const declared = Number(req.headers["content-length"] ?? "NaN");
				if (Number.isFinite(declared) && declared > LIBRARY_MAX_BYTES) throw new HttpError(413, `Files can be up to ${LIBRARY_MAX_BYTES / (1024 * 1024)} MB.`);
				try {
					const saved = await saveLibraryFile(deps.libraryDir, req, {
						area: url.searchParams.get("area"),
						aircraft: url.searchParams.get("aircraft") ?? undefined,
						fileName: url.searchParams.get("name"),
						replace: url.searchParams.get("replace") === "1",
					});
					deps.log?.(`library: ${saved.replaced ? "replaced" : "added"} ${saved.file.relPath} (${saved.file.bytes} bytes)`);
					return sendJson(res, 200, { ok: true, ...saved });
				} catch (error) {
					if (error instanceof LibraryError) {
						const status = error.code === "exists" ? 409 : error.code === "too-large" ? 413 : error.code === "not-found" ? 404 : 400;
						return sendJson(res, status, { ok: false, code: error.code, error: error.message });
					}
					throw error;
				}
			}
			if (parts.length === 2 && parts[1] === "remove" && method === "POST") {
				const form = await readForm(req);
				if (form.get("confirm") !== "yes") return done(req, res, form, { ok: false, status: 400, error: "Confirm the removal first." });
				try {
					await removeLibraryFile(deps.libraryDir, form.get("path"));
				} catch (error) {
					if (error instanceof LibraryError) return done(req, res, form, { ok: false, status: error.code === "not-found" ? 404 : 400, error: error.message });
					throw error;
				}
				deps.log?.(`library: removed ${String(form.get("path"))}`);
				return done(req, res, form, { ok: true, done: "file-removed" });
			}
		}
		throw new HttpError(404, "Not found.");
	}

	async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const isApi = url.pathname === "/admin/api" || url.pathname.startsWith("/admin/api/");
		const target = `${url.pathname}${url.search}`;
		if (!deps.db) return isApi ? sendJson(res, 503, { error: "The dashboard needs the database." }) : refusePage(res, 503, "The dashboard needs the database.");
		const db = deps.db;
		let access;
		try {
			access = await resolveAdminAccess({ db, sessionSecret: deps.sessionSecret, clerk: deps.clerk, now: deps.now }, req.headers.cookie, "dashboard.view");
		} catch (error) {
			if (!(error instanceof LoginCheckUnavailableError)) throw error;
			return isApi ? sendJson(res, 503, { error: "The login check is unavailable. Try again in a minute." }) : refusePage(res, 503, "The login check is unavailable. Try again in a minute.");
		}
		if (access.kind === "signed-out") {
			if (!isApi && (req.method === "GET" || req.method === "HEAD")) return send(res, 302, { Location: `/account/sign-in?next=${encodeURIComponent(target)}` });
			return sendJson(res, 401, { error: "Sign in required." });
		}
		if (access.kind === "forbidden") return isApi ? sendJson(res, 403, { error: "Forbidden." }) : refusePage(res, 403, "This page is for North Aero staff only.");
		const renewed = access.renewedSession
			? [serializeCookie(SESSION_COOKIE, access.renewedSession, { maxAgeSeconds: SESSION_MAX_AGE_SECONDS, secure: deps.secureCookies })]
			: [];

		if (isApi) {
			if (renewed.length) res.setHeader("Set-Cookie", renewed);
			try {
				return await api(req, res, url, access.identity, db);
			} catch (error) {
				if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
				throw error;
			}
		}
		if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { Allow: "GET, HEAD" });
		// Headers before Next.js starts its answer (Next.js custom-server guide).
		for (const [name, value] of Object.entries(NOINDEX)) res.setHeader(name, value);
		if (renewed.length) res.setHeader("Set-Cookie", renewed);
		req.url = target;
		await deps.frontDoorApp(req, res);
	}

	return { handle };
}

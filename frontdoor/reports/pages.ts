/**
 * The report pages (C6 req 3, N12, P6-05), served by the gateway before
 * Next.js (a hook in gateway/handler.ts, like /account/age):
 *
 *   GET  /account/reports      the student's report settings. Needs the
 *                              front door login (same check as the tutor,
 *                              with the 5-minute Clerk re-check).
 *   POST /account/reports      saves them.
 *   GET  /account/unsubscribe  ?t=<token>&k=session|weekly: a page with one
 *                              button. No login. Opening the page changes
 *                              nothing, so a mail scanner that opens links
 *                              cannot turn reports off.
 *   POST /account/unsubscribe  turns the report off. No login. Also takes
 *                              mail apps' one-click POST (RFC 8058,
 *                              "List-Unsubscribe=One-Click").
 *
 * Everything under /account is already outside the login gate, so these
 * paths change nothing for /api or the tutor. Plain HTML, no scripts.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { Db } from "../db/db.ts";
import { getReportSettings, unsubscribeByToken, updateReportSettings } from "../db/reports.ts";
import { normalizeEmailAddress } from "../email/address.ts";
import type { EmailMode } from "../email/config.ts";
import { BRAND_NAME, settingsCopy, unsubscribeCopy } from "../email/copy.ts";
import { EMAIL_COLORS, escapeHtml } from "../email/layout.ts";
import type { ClerkGateway } from "../gateway/auth.ts";
import { clearCookie, parseCookies, serializeCookie } from "../gateway/cookies.ts";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, SESSION_RECHECK_MS, signSession, verifySession, type FrontDoorSession } from "../gateway/session.ts";
import { errorLabel } from "../log-hygiene/filter.ts";
import type { AccountStore } from "../tenants/accounts.ts";
import { unsubscribeTokenExists } from "./store.ts";
import type { StudentDirectory } from "./students.ts";

export const REPORTS_PATH = "/account/reports";
export const UNSUBSCRIBE_PATH = "/account/unsubscribe";
const SIGN_IN_PATH = "/account/sign-in";

const MAX_FORM_BYTES = 4096;
/** The database's tokens are 64 hex characters; anything far off is refused without a query. */
const TOKEN = /^[A-Za-z0-9]{16,128}$/;

export interface ReportPagesDeps {
	/** Null in a local run without SUPABASE_DB_URL: the pages say they are unavailable. */
	db: Db | null;
	/** For the login email that fills the address box at first. Optional. */
	students?: StudentDirectory | null;
	accounts: Pick<AccountStore, "get">;
	clerk: Pick<ClerkGateway, "isSessionActive">;
	sessionSecret: Uint8Array;
	secureCookies: boolean;
	trustForwardedHeaders: boolean;
	/** "off": the page says reports start once email is set up. */
	emailMode: EmailMode;
	now?: () => number;
	/** Never given an address. */
	log?: (line: string) => void;
}

/** True when it answered the request; false for paths it does not serve. */
export type ReportPages = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

type UnsubscribeKind = "session" | "weekly";
type Scope = UnsubscribeKind | "all";

const C = EMAIL_COLORS;
const firstValue = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:${C.cream};color:${C.ink};font:16px/1.5 system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px}
.card{background:${C.card};border:1px solid ${C.line};border-top:4px solid ${C.orange};padding:20px}
.mark{font:bold 14px/1 Oswald,"Arial Narrow",Arial,sans-serif;letter-spacing:.12em;margin:0 0 16px}.mark span{color:${C.orangeText}}
h1{font:bold 26px/1.25 Oswald,"Arial Narrow",Arial,sans-serif;margin:0 0 12px}
p{margin:0 0 12px}.help{color:${C.gray};font-size:14px;margin:2px 0 0}
.label{background:${C.peachPale};padding:8px 12px;font-size:14px}
.ok{border-left:4px solid #1f5f3a;padding:8px 12px;background:#eef5ef}
.err{border-left:4px solid ${C.orangeText};padding:8px 12px;background:${C.peachPale}}
label{font-weight:bold}input[type=email]{box-sizing:border-box;width:100%;font:inherit;padding:10px;border:1px solid ${C.gray};border-radius:4px;margin-top:4px;background:#fff}
.check{display:flex;gap:10px;align-items:flex-start;margin:16px 0}.check input{width:22px;height:22px;margin:2px 0 0;accent-color:${C.orangeText}}
button{font:inherit;font-weight:bold;padding:12px 18px;border:0;border-radius:4px;background:${C.orangeText};color:#fff;cursor:pointer;margin:8px 8px 0 0}
button.second{background:${C.ink}}
a{color:${C.orangeText}}
:focus-visible{outline:3px solid ${C.orange};outline-offset:2px}
</style></head>
<body><main><div class="card"><p class="mark">NORTH AERO <span>/ GROUND TUTOR</span></p>
${body}
</div></main></body></html>`;
}

export function createReportPages(deps: ReportPagesDeps): ReportPages {
	const now = () => (deps.now ? deps.now() : Date.now());

	function proto(req: IncomingMessage): string {
		if (deps.trustForwardedHeaders) {
			const forwarded = firstValue(req.headers["x-forwarded-proto"]);
			if (forwarded === "https" || forwarded === "http") return forwarded;
		}
		return "encrypted" in req.socket && req.socket.encrypted ? "https" : "http";
	}
	const host = (req: IncomingMessage) => (deps.trustForwardedHeaders ? firstValue(req.headers["x-forwarded-host"]) : undefined) ?? req.headers.host ?? "localhost";

	function send(res: ServerResponse, status: number, html: string, headers: OutgoingHttpHeaders = {}): void {
		res.writeHead(status, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"X-Robots-Tag": "noindex",
			...headers,
		});
		res.end(html);
	}

	function redirect(res: ServerResponse, location: string, setCookie: string[] = [], status = 303): void {
		res.writeHead(status, { Location: location, "Cache-Control": "no-store", ...(setCookie.length ? { "Set-Cookie": setCookie } : {}) });
		res.end();
	}

	function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
		return new Promise((resolve, reject) => {
			let size = 0;
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_FORM_BYTES) {
					resolve(null);
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
			req.on("error", reject);
		});
	}

	const unavailable = (res: ServerResponse) => send(res, 503, page(settingsCopy.pageTitle, `<h1>${escapeHtml(settingsCopy.heading)}</h1><p>Email reports are not available right now. Try again later.</p>`));

	// ---- the login (same rule as the gateway's tutor requests) ----

	type Login = { session: FrontDoorSession; setCookie: string[] };

	async function login(req: IncomingMessage, res: ServerResponse): Promise<Login | null> {
		const session = await verifySession(parseCookies(req.headers.cookie).get(SESSION_COOKIE), deps.sessionSecret, now());
		const toSignIn = (setCookie: string[] = []) => redirect(res, `${SIGN_IN_PATH}?next=${encodeURIComponent(REPORTS_PATH)}`, setCookie, 302);
		if (!session) {
			toSignIn();
			return null;
		}
		if (now() - session.checkedAt <= SESSION_RECHECK_MS) return { session, setCookie: [] };
		let active: boolean;
		try {
			active = await deps.clerk.isSessionActive(session.sessionId);
		} catch (error) {
			deps.log?.(`login re-check failed (${errorLabel(error)})`);
			send(res, 503, page(settingsCopy.pageTitle, `<h1>${escapeHtml(settingsCopy.heading)}</h1><p>The login check is unavailable. Try again in a minute.</p>`));
			return null;
		}
		const account = active ? await deps.accounts.get(session.userId) : null;
		if (!active || account?.tenantId !== session.tenantId) {
			toSignIn([clearCookie(SESSION_COOKIE, deps.secureCookies)]);
			return null;
		}
		const current = { ...session, checkedAt: now() };
		const token = await signSession(current, deps.sessionSecret, now());
		return { session: current, setCookie: [serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_MAX_AGE_SECONDS, secure: deps.secureCookies })] };
	}

	// ---- /account/reports ----

	function settingsPage(v: { address: string; session: boolean; weekly: boolean; saved?: boolean; error?: string }): string {
		const s = settingsCopy;
		const notice = v.error
			? `<p class="err" role="alert">${escapeHtml(v.error)}</p>`
			: v.saved
				? `<p class="ok" role="status">${escapeHtml(s.saved)}${!v.session && !v.weekly ? ` ${escapeHtml(s.bothOff)}` : ""}</p>`
				: "";
		return page(
			s.pageTitle,
			`<h1>${escapeHtml(s.heading)}</h1>
${notice}
<p>${escapeHtml(s.intro)}</p>
${deps.emailMode === "off" ? `<p class="help">${escapeHtml(s.emailOff)}</p>` : ""}
<form method="post" action="${REPORTS_PATH}">
<label for="email">${escapeHtml(s.addressLabel)}</label>
<input type="email" id="email" name="email" autocomplete="email" maxlength="254" value="${escapeHtml(v.address)}" aria-describedby="email-help">
<p class="help" id="email-help">${escapeHtml(s.addressHelp)}</p>
<div class="check"><input type="checkbox" id="session" name="session" value="on"${v.session ? " checked" : ""} aria-describedby="session-help"><div><label for="session">${escapeHtml(s.sessionLabel)}</label><p class="help" id="session-help">${escapeHtml(s.sessionHelp)}</p></div></div>
<div class="check"><input type="checkbox" id="weekly" name="weekly" value="on"${v.weekly ? " checked" : ""} aria-describedby="weekly-help"><div><label for="weekly">${escapeHtml(s.weeklyLabel)}</label><p class="help" id="weekly-help">${escapeHtml(s.weeklyHelp)}</p></div></div>
<button type="submit">${escapeHtml(s.save)}</button>
</form>
<p class="help" style="margin-top:16px">${escapeHtml(s.unsubscribeNote)}</p>
<p class="label">${escapeHtml(s.label)}</p>
<p><a href="/">${escapeHtml(s.back)}</a></p>`,
		);
	}

	async function loginEmail(tenantId: string): Promise<string> {
		try {
			return (await deps.students?.get(tenantId))?.email ?? "";
		} catch {
			return "";
		}
	}

	async function showSettings(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		if (!deps.db) return unavailable(res);
		const auth = await login(req, res);
		if (!auth) return;
		const settings = await getReportSettings(deps.db, auth.session.tenantId);
		const address = settings.reportEmail ?? (await loginEmail(auth.session.tenantId));
		const html = settingsPage({ address, session: settings.sessionReportEnabled, weekly: settings.weeklyReportEnabled, saved: url.searchParams.get("saved") === "1" });
		send(res, 200, html, auth.setCookie.length ? { "Set-Cookie": auth.setCookie } : {});
	}

	async function saveSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!deps.db) return unavailable(res);
		const origin = req.headers.origin;
		const fetchSite = firstValue(req.headers["sec-fetch-site"]);
		if ((origin && origin !== `${proto(req)}://${host(req)}`) || (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")) {
			return send(res, 403, page(settingsCopy.pageTitle, "<h1>Forbidden</h1>"));
		}
		const auth = await login(req, res);
		if (!auth) return;
		const form = await readForm(req);
		if (!form) return send(res, 413, page(settingsCopy.pageTitle, "<h1>Form too large</h1>"));
		const session = form.get("session") === "on";
		const weekly = form.get("weekly") === "on";
		const raw = (form.get("email") ?? "").trim();
		const address = normalizeEmailAddress(raw);
		const headers = auth.setCookie.length ? { "Set-Cookie": auth.setCookie } : {};
		if (raw !== "" && !address) return send(res, 400, settingsPage({ address: raw, session, weekly, error: settingsCopy.badAddress }), headers);
		if ((session || weekly) && !address) return send(res, 400, settingsPage({ address: raw, session, weekly, error: settingsCopy.needAddress }), headers);
		await updateReportSettings(deps.db, auth.session.tenantId, { sessionReportEnabled: session, weeklyReportEnabled: weekly, reportEmail: address });
		redirect(res, `${REPORTS_PATH}?saved=1`, auth.setCookie);
	}

	// ---- /account/unsubscribe ----

	const kindFrom = (value: string | null): UnsubscribeKind => (value === "weekly" ? "weekly" : "session");
	const badLink = (res: ServerResponse) =>
		send(res, 404, page(unsubscribeCopy.pageTitle, `<h1>${escapeHtml(unsubscribeCopy.heading)}</h1><p>${escapeHtml(unsubscribeCopy.badLink)}</p><p class="help">${escapeHtml(unsubscribeCopy.contact)}</p>`));

	async function showUnsubscribe(res: ServerResponse, url: URL): Promise<void> {
		if (!deps.db) return unavailable(res);
		const token = url.searchParams.get("t") ?? "";
		if (!TOKEN.test(token) || !(await unsubscribeTokenExists(deps.db, token))) return badLink(res);
		const kind = kindFrom(url.searchParams.get("k"));
		const u = unsubscribeCopy;
		const action = `${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}&k=${kind}`;
		send(
			res,
			200,
			page(
				u.pageTitle,
				`<h1>${escapeHtml(u.heading)}</h1>
<p>${escapeHtml(u.question(kind))}</p>
<form method="post" action="${escapeHtml(action)}">
<button type="submit" name="scope" value="${kind}">${escapeHtml(u.turnOff(kind))}</button>
<button type="submit" name="scope" value="all" class="second">${escapeHtml(u.turnOffAll)}</button>
</form>
<p class="help" style="margin-top:16px">${escapeHtml(u.contact)}</p>`,
			),
		);
	}

	async function doUnsubscribe(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		if (!deps.db) return unavailable(res);
		const form = (await readForm(req)) ?? new URLSearchParams();
		const token = url.searchParams.get("t") ?? form.get("t") ?? "";
		const kind = kindFrom(url.searchParams.get("k"));
		const asked = form.get("scope");
		// RFC 8058: a mail app's one-click POST turns off the report the email was for.
		const scope: Scope = form.get("List-Unsubscribe") === "One-Click" ? kind : asked === "all" || asked === "weekly" || asked === "session" ? asked : kind;
		if (!TOKEN.test(token) || !(await unsubscribeByToken(deps.db, token, scope))) return badLink(res);
		send(res, 200, page(unsubscribeCopy.pageTitle, `<h1>${escapeHtml(unsubscribeCopy.heading)}</h1><p class="ok" role="status">${escapeHtml(unsubscribeCopy.done(scope))}</p><p>${escapeHtml(unsubscribeCopy.doneMore)}</p><p class="help">${escapeHtml(unsubscribeCopy.contact)}</p>`));
	}

	return async (req, res, url) => {
		const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
		if (path !== REPORTS_PATH && path !== UNSUBSCRIBE_PATH) return false;
		const method = req.method ?? "GET";
		const read = method === "GET" || method === "HEAD";
		if (!read && method !== "POST") {
			send(res, 405, page(BRAND_NAME, "<h1>Method not allowed</h1>"), { Allow: "GET, HEAD, POST" });
			return true;
		}
		if (path === REPORTS_PATH) await (read ? showSettings(req, res, url) : saveSettings(req, res));
		else await (read ? showUnsubscribe(res, url) : doUnsubscribe(req, res, url));
		return true;
	};
}

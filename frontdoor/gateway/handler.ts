/**
 * The front door's request handler (PRD X1 jobs 1 to 4, C1, X5 method A).
 * Every request reaches it first.
 *
 *   /account/age    POST  the 18+ checkbox (sets the signed fd_age cookie)
 *   /account/start  GET   where Clerk sends the student after sign-in or
 *                         sign-up: records the 18+ tick, creates and
 *                         provisions the tenant, starts its server, and sets
 *                         the front door's login cookie
 *   /account/reports, /account/unsubscribe  email report pages (W2-10,
 *                         reports/pages.ts; settings check the login there)
 *   /account/...          the front door's own Next.js pages (no login needed)
 *   public pages    GET   How it works, Help, /legal/*, robots.txt and
 *                         sitemap.xml come from the front door's app, login
 *                         or not (W2-11, marketing/public-paths.ts)
 *   /admin/...            the Owner's dashboard (frontdoor/admin): login
 *                         and Owner role checked there, 403 for anyone else
 *   /               GET   with no login: the landing page, from the front
 *                         door's app. With a login: the tutor, as below.
 *   everything else       needs the login cookie. Without it, /api gets 401
 *                         and a page redirects to sign-in. With it, the
 *                         request passes through to the tenant's server.
 *
 * Routing uses the normalized path ("..", "%2e%2e" resolved), and that same
 * path is what Next.js or the tenant receives.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { isAlwaysPublicPath, LANDING_PATH } from "../marketing/public-paths.ts";
import type { AccountStore } from "../tenants/accounts.ts";
import type { ClerkGateway } from "./auth.ts";
import { clearCookie, parseCookies, serializeCookie } from "./cookies.ts";
import { passThrough } from "./passthrough.ts";
import { FRONT_DOOR_PREFIX, safeReturnPath } from "./return-path.ts";
import {
	AGE_COOKIE,
	AGE_MAX_AGE_SECONDS,
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS,
	SESSION_RECHECK_MS,
	signAgeConfirmation,
	signSession,
	verifyAgeConfirmation,
	verifySession,
	type FrontDoorSession,
} from "./session.ts";

export interface GatewayDeps {
	/** Read on every request, so the store can be swapped (tests). */
	accounts: AccountStore;
	clerk: ClerkGateway;
	supervisor: { ensureRunning(tenantId: string): Promise<number> };
	/** Creates the tenant folder and writes the settings template (provisioning.ts). */
	provision(tenantId: string): void | Promise<void>;
	sessionSecret: Uint8Array;
	secureCookies: boolean;
	trustForwardedHeaders: boolean;
	/** The front door's Next.js request handler, for /account pages. */
	frontDoorApp(req: IncomingMessage, res: ServerResponse): unknown;
	/** W2-10: /account/reports and /account/unsubscribe (reports/pages.ts). True when it answered. */
	reportPages?(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
	now?: () => number;
	/** Never given session text or email addresses (cross-cutting req 3). */
	log?: (message: string) => void;
	/** W2-9: the front door's own routes for a signed-in student, after the login check: the study-time heartbeat (P3-02) and the session-text switch (P3-04). See admin/wiring.ts. */
	studentRoutes?: { handles(pathname: string): boolean; handle(req: IncomingMessage, res: ServerResponse, tenantId: string, pathname: string): Promise<void> };
	/** P3-01: /admin and everything under it (frontdoor/admin). Without it, /admin is 404. */
	admin?: { handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> };
}

const MAX_FORM_BYTES = 4096;

const firstValue = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();

export function createGateway(deps: GatewayDeps): (req: IncomingMessage, res: ServerResponse) => void {
	const now = () => (deps.now ? deps.now() : Date.now());
	const cookie = (name: string, value: string, maxAgeSeconds: number) => serializeCookie(name, value, { maxAgeSeconds, secure: deps.secureCookies });
	const clear = (name: string) => clearCookie(name, deps.secureCookies);

	function proto(req: IncomingMessage): string {
		if (deps.trustForwardedHeaders) {
			const forwarded = firstValue(req.headers["x-forwarded-proto"]);
			if (forwarded === "https" || forwarded === "http") return forwarded;
		}
		return "encrypted" in req.socket && req.socket.encrypted ? "https" : "http";
	}

	function host(req: IncomingMessage): string {
		return (deps.trustForwardedHeaders ? firstValue(req.headers["x-forwarded-host"]) : undefined) ?? req.headers.host ?? "localhost";
	}

	function send(res: ServerResponse, status: number, headers: OutgoingHttpHeaders, body = ""): void {
		res.writeHead(status, { "Cache-Control": "no-store", ...headers });
		res.end(body);
	}

	function sendJson(res: ServerResponse, status: number, body: object, setCookie: string[] = []): void {
		send(res, status, { "Content-Type": "application/json", ...(setCookie.length ? { "Set-Cookie": setCookie } : {}) }, JSON.stringify(body));
	}

	function redirect(res: ServerResponse, status: number, location: string, setCookie: string[] = []): void {
		send(res, status, { Location: location, ...(setCookie.length ? { "Set-Cookie": setCookie } : {}) });
	}

	const isApi = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");
	const isRead = (req: IncomingMessage) => req.method === "GET" || req.method === "HEAD";

	/** Clerk's own cookie (__client_uat, or a suffixed copy) says the browser is
	 *  still signed in to Clerk. Sign-in then forwards straight to the tutor. */
	function signedInToClerk(req: IncomingMessage): boolean {
		for (const [name, value] of parseCookies(req.headers.cookie)) {
			if (/^__client_uat(_[A-Za-z0-9-]+)?$/.test(name) && value !== "" && value !== "0") return true;
		}
		return false;
	}

	function signInRequired(req: IncomingMessage, res: ServerResponse, pathname: string, target: string, setCookie: string[] = []): void {
		if (!isApi(pathname) && (req.method === "GET" || req.method === "HEAD")) {
			return redirect(res, 302, `${FRONT_DOOR_PREFIX}/sign-in?next=${encodeURIComponent(target)}`, setCookie);
		}
		sendJson(res, 401, { error: "Sign in required." }, setCookie);
	}

	function tutorUnavailable(res: ServerResponse, api: boolean): void {
		if (api) return sendJson(res, 503, { error: "Your tutor is starting. Try again in a minute." });
		send(res, 503, { "Content-Type": "text/html; charset=utf-8", "Retry-After": "10" }, "<!doctype html><title>North Aero Ground Tutor</title><p>Your tutor is starting. Please try again in a minute.</p>");
	}

	function toWebRequest(req: IncomingMessage, target: string): Request {
		const headers = new Headers();
		for (const [name, value] of Object.entries(req.headers)) {
			if (Array.isArray(value)) for (const v of value) headers.append(name, v);
			else if (value !== undefined) headers.set(name, value);
		}
		return new Request(`${proto(req)}://${host(req)}${target}`, { method: req.method, headers });
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

	/** POST /account/age: the "I am 18 or older" checkbox (D28). */
	async function handleAge(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const origin = req.headers.origin;
		if (origin && origin !== `${proto(req)}://${host(req)}`) return sendJson(res, 403, { error: "Forbidden." });
		const form = await readForm(req);
		if (!form) return sendJson(res, 413, { error: "Form too large." });
		const next = safeReturnPath(form.get("next"), `${FRONT_DOOR_PREFIX}/sign-up`, { within: FRONT_DOOR_PREFIX });
		if (form.get("over18") !== "yes") {
			const back = safeReturnPath(form.get("back"), `${FRONT_DOOR_PREFIX}/sign-up`, { within: FRONT_DOOR_PREFIX });
			return redirect(res, 303, `${back}${back.includes("?") ? "&" : "?"}age=required`);
		}
		const token = await signAgeConfirmation(now(), deps.sessionSecret);
		redirect(res, 303, next, [cookie(AGE_COOKIE, token, AGE_MAX_AGE_SECONDS)]);
	}

	/** GET /account/start: the first page after a Clerk sign-in or sign-up. */
	async function handleStart(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const result = await deps.clerk.authenticate(toWebRequest(req, `${url.pathname}${url.search}`));
		if (result.status === "handshake") {
			const headers: OutgoingHttpHeaders = {};
			result.headers.forEach((value, name) => {
				if (name !== "set-cookie") headers[name] = value;
			});
			const setCookie = result.headers.getSetCookie();
			if (setCookie.length) headers["set-cookie"] = setCookie;
			return send(res, 307, headers);
		}
		if (result.status === "signed-out") return redirect(res, 302, `${FRONT_DOOR_PREFIX}/sign-in`);

		const clerkCookies = result.headers?.getSetCookie() ?? [];
		const next = safeReturnPath(url.searchParams.get("next"), "/");
		const accounts = deps.accounts;
		const account = await accounts.get(result.userId);
		if (!account?.ageConfirmedAt) {
			const tickedAt = await verifyAgeConfirmation(parseCookies(req.headers.cookie).get(AGE_COOKIE), deps.sessionSecret, now());
			if (tickedAt === null) return redirect(res, 302, `${FRONT_DOOR_PREFIX}/confirm-age?next=${encodeURIComponent(next)}`, clerkCookies);
			await accounts.confirmAge(result.userId, new Date(tickedAt));
		}
		const tenantId = await accounts.assignTenant(result.userId);
		try {
			await deps.provision(tenantId);
			await deps.supervisor.ensureRunning(tenantId);
		} catch (error) {
			deps.log?.(`tenant ${tenantId} could not start: ${(error as Error).message}`);
			return tutorUnavailable(res, false);
		}
		const session: FrontDoorSession = { userId: result.userId, sessionId: result.sessionId, tenantId, checkedAt: now() };
		const token = await signSession(session, deps.sessionSecret, now());
		redirect(res, 302, next, [...clerkCookies, cookie(SESSION_COOKIE, token, SESSION_MAX_AGE_SECONDS), clear(AGE_COOKIE)]);
	}

	/** Everything outside /account: login check, then pass-through. */
	async function handleTenantRequest(req: IncomingMessage, res: ServerResponse, pathname: string, target: string): Promise<void> {
		const session = await verifySession(parseCookies(req.headers.cookie).get(SESSION_COOKIE), deps.sessionSecret, now());
		if (!session) {
			// W2-11: a visitor with no login sees the landing page at "/".
			if (pathname === LANDING_PATH && isRead(req) && !signedInToClerk(req)) {
				req.url = target;
				await deps.frontDoorApp(req, res);
				return;
			}
			return signInRequired(req, res, pathname, target);
		}

		let current = session;
		const setCookie: string[] = [];
		if (now() - session.checkedAt > SESSION_RECHECK_MS) {
			let active: boolean;
			try {
				active = await deps.clerk.isSessionActive(session.sessionId);
			} catch (error) {
				deps.log?.(`login re-check failed: ${(error as Error).message}`);
				return sendJson(res, 503, { error: "The login check is unavailable. Try again in a minute." });
			}
			const account = active ? await deps.accounts.get(session.userId) : null;
			if (!active || account?.tenantId !== session.tenantId) return signInRequired(req, res, pathname, target, [clear(SESSION_COOKIE)]);
			current = { ...session, checkedAt: now() };
			setCookie.push(cookie(SESSION_COOKIE, await signSession(current, deps.sessionSecret, now()), SESSION_MAX_AGE_SECONDS));
		}

		// W2-9: study-time heartbeat (PD1) and the session-text switch, for this login's tenant.
		if (deps.studentRoutes?.handles(pathname)) return deps.studentRoutes.handle(req, res, current.tenantId, pathname);
		let port: number;
		try {
			port = await deps.supervisor.ensureRunning(current.tenantId);
		} catch (error) {
			deps.log?.(`tenant ${current.tenantId} could not start: ${(error as Error).message}`);
			return tutorUnavailable(res, isApi(pathname));
		}
		passThrough(req, res, { port, path: target, proto: proto(req), setCookie });
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const raw = req.url ?? "/";
		if (!raw.startsWith("/")) return sendJson(res, 400, { error: "Bad request." });
		const url = new URL(`http://front.door${raw}`);
		const pathname = url.pathname;
		const target = `${pathname}${url.search}`;

		if (pathname === FRONT_DOOR_PREFIX || pathname.startsWith(`${FRONT_DOOR_PREFIX}/`)) {
			req.url = target;
			if (pathname === FRONT_DOOR_PREFIX || pathname === `${FRONT_DOOR_PREFIX}/`) return redirect(res, 302, `${FRONT_DOOR_PREFIX}/sign-in`);
			if (pathname === `${FRONT_DOOR_PREFIX}/age` && req.method === "POST") return handleAge(req, res);
			if (pathname === `${FRONT_DOOR_PREFIX}/start` && (req.method === "GET" || req.method === "HEAD")) return handleStart(req, res, url);
			if (deps.reportPages && (await deps.reportPages(req, res, url))) return;
			// Set before Next.js starts the answer (Next.js custom-server guide).
			if (pathname === `${FRONT_DOOR_PREFIX}/sign-out`) res.setHeader("Set-Cookie", [clear(SESSION_COOKIE), clear(AGE_COOKIE)]);
			await deps.frontDoorApp(req, res);
			return;
		}
		// W2-11: the public pages are the front door's, login or not.
		if (isRead(req) && isAlwaysPublicPath(pathname)) {
			req.url = target;
			await deps.frontDoorApp(req, res);
			return;
		}
		// P3-01: the Owner's dashboard (frontdoor/admin checks the login and the role).
		if (pathname === "/admin" || pathname.startsWith("/admin/")) return deps.admin ? deps.admin.handle(req, res, url) : sendJson(res, 404, { error: "Not found." });
		return handleTenantRequest(req, res, pathname, target);
	}

	return (req, res) => {
		handle(req, res).catch((error: unknown) => {
			deps.log?.(`front door error: ${(error as Error).message}`);
			if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong." });
			else res.destroy();
		});
	};
}

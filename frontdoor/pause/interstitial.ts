/**
 * A front door screen shown in place of the tutor, with a "Read your
 * sessions" way through (P2-05; C3 req 6: a paused student can still read
 * their records). Built to be reused: W2-8 needs the same shape for "trial
 * time used up: show the plans, chats still readable" (C2 req 3).
 *
 * How it works, for one screen `kind` (for example "paused"):
 *  - Tutor page loads get the screen (interstitialPage) at the same address.
 *  - The screen's "Read your sessions" button is GET READ_PATH. It sets the
 *    READ_COOKIE (value = the kind, 1 hour) and a one-time cookie, then
 *    sends the student to "/". Tutor pages load again, for reading. New
 *    turns and jobs still fail: the meter refuses them, with its message.
 *  - The next visit to "/" (a full page load, not a click inside the
 *    tutor) shows the screen again.
 *  - API calls, the tutor's files (/_next) and writes are never screened
 *    here. What they may do is the meter's and the gate's business.
 *
 * The cookie only lets pages show. It grants nothing: a student who sets it
 * by hand sees a tutor that cannot take a turn. So it is not signed.
 *
 * A gate using this (gate.ts) calls interstitialDecision() for page loads,
 * answers READ_PATH with readRedirect(), and sends interstitialPage() HTML.
 */
import type { IncomingMessage } from "node:http";
import { clearCookie, parseCookies, serializeCookie } from "../gateway/cookies.ts";
import { ACTIONS, BRAND_LINES } from "./copy.ts";

/** The "Read your sessions" button. A front door path that needs the login (gate.ts owns it). */
export const READ_PATH = "/account/read-sessions";
export const READ_COOKIE = "fd_read";
const READ_ONCE_COOKIE = "fd_read_once";
export const READ_MAX_AGE_SECONDS = 60 * 60;
export const SIGN_OUT_PATH = "/account/sign-out";

const isApi = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");
const isRead = (req: IncomingMessage) => req.method === "GET" || req.method === "HEAD";

/** A browser page load: a document request, or Next.js's client navigation (RSC), which turns into a full load when it gets HTML. */
export function isPageLoad(req: IncomingMessage, pathname: string): boolean {
	if (!isRead(req) || isApi(pathname) || pathname.startsWith("/_next/")) return false;
	if (req.headers["sec-fetch-dest"] === "document" || req.headers["sec-fetch-mode"] === "navigate") return true;
	if (req.headers.rsc === "1") return true;
	return String(req.headers.accept ?? "").includes("text/html");
}

/** A full page load (typed address, reload, link from outside), not a click inside the tutor. */
function isFullLoad(req: IncomingMessage): boolean {
	return req.headers.rsc !== "1" && isPageLoad(req, "/x");
}

export type InterstitialDecision =
	/** Send the screen. */
	| { show: true }
	/** Pass the request to the tenant. setCookie: values to add to the tenant's answer. */
	| { show: false; setCookie: string[] };

/**
 * For a request while the `kind` screen applies. Call it for any request;
 * only page loads can get the screen.
 */
export function interstitialDecision(req: IncomingMessage, pathname: string, kind: string, secureCookies: boolean): InterstitialDecision {
	if (!isPageLoad(req, pathname)) return { show: false, setCookie: [] };
	const cookies = parseCookies(req.headers.cookie);
	if (cookies.get(READ_COOKIE) !== kind) return { show: true };
	if (pathname === "/" && isFullLoad(req)) {
		// The first load of "/" right after the button passes once; a later visit shows the screen again.
		if (cookies.get(READ_ONCE_COOKIE) === kind) return { show: false, setCookie: [clearCookie(READ_ONCE_COOKIE, secureCookies)] };
		return { show: true };
	}
	return { show: false, setCookie: [] };
}

/** The answer to GET READ_PATH while the `kind` screen applies: cookies, then "/". */
export function readRedirect(kind: string, secureCookies: boolean): { location: string; setCookie: string[] } {
	return {
		location: "/",
		setCookie: [
			serializeCookie(READ_COOKIE, kind, { maxAgeSeconds: READ_MAX_AGE_SECONDS, secure: secureCookies }),
			serializeCookie(READ_ONCE_COOKIE, kind, { maxAgeSeconds: 120, secure: secureCookies }),
		],
	};
}

// ---- the page ----

export interface ScreenAction {
	label: string;
	href: string;
	/** The main button; the others are plain. */
	primary?: boolean;
}

export interface ScreenContent {
	/** The browser tab title. */
	title: string;
	heading: string;
	/** The first, bold line. */
	lead: string;
	paragraphs: readonly string[];
	actions: readonly ScreenAction[];
	/** Lines after the buttons. */
	after?: readonly string[];
}

export const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const STYLE = `
:root{--cream:#faf6ec;--card:#fffdf8;--line:#e2dac6;--ink:#1a1b1d;--orange:#c4501a;--orange-deep:#a9430f}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--cream);color:var(--ink);font:17px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{max-width:34rem;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px 28px}
.brand{font-weight:700;letter-spacing:.12em;font-size:13px;line-height:1.3;margin:0 0 24px}
.brand span{display:block}.brand span+span{color:var(--orange)}
h1{font-size:26px;line-height:1.25;margin:0 0 16px}
p{margin:0 0 14px}
.lead{font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0 8px}
a.button{display:inline-block;padding:11px 18px;border-radius:9px;color:var(--ink);text-decoration:none;font-weight:600;border:1px solid var(--line)}
a.button.primary{background:var(--orange);border-color:var(--orange);color:#fff}
a.button.primary:hover,a.button.primary:focus-visible{background:var(--orange-deep)}
a.button:not(.primary):hover,a.button:not(.primary):focus-visible{border-color:var(--orange-deep)}
a{color:var(--orange-deep)}
.signout{margin-top:22px;font-size:15px}
`;

/** A whole HTML page: no script, nothing loaded from outside, no Clerk. */
export function interstitialPage(content: ScreenContent): string {
	const actions = content.actions.length
		? `<div class="actions">${content.actions
				.map((a) => `<a class="button${a.primary ? " primary" : ""}" href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a>`)
				.join("\n")}</div>`
		: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(content.title)} · North Aero Ground Tutor</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="brand">${BRAND_LINES.map((l) => `<span>${escapeHtml(l)}</span>`).join("")}</p>
<h1>${escapeHtml(content.heading)}</h1>
<p class="lead">${escapeHtml(content.lead)}</p>
${content.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")}
${actions}
${(content.after ?? []).map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")}
<p class="signout"><a href="${SIGN_OUT_PATH}">${escapeHtml(ACTIONS.signOut)}</a></p>
</main>
</body>
</html>
`;
}

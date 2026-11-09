/**
 * The pause screen and the plan-ended screen (P2-05, P1-08; C3 req 6,
 * C1 req 6). Plain HTML from the front door, shown in place of the tutor:
 * no Clerk script, no outside script or font. The one inline script only
 * adds the browser's time zone to the two links, so the dates on the study
 * record are the student's own; without it the record uses UTC.
 *
 * Text: copy.ts.
 */
import { ACTIONS, BRAND_LINES, PAUSE_SCREEN, RETENTION_SCREEN } from "./copy.ts";

export const EXPORT_PATH = "/account/export";
export const RECORD_PATH = "/account/record";
export const SIGN_OUT_PATH = "/account/sign-out";

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** "February 6, 2027", in UTC. */
export function formatDay(date: Date): string {
	return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }).format(date);
}

const STYLE = `
:root{--cream:#faf6ec;--card:#fffdf8;--line:#e2dac6;--ink:#1a1b1d;--gray:#4f5256;--orange:#c4501a;--orange-deep:#a9430f}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--cream);color:var(--ink);font:17px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{max-width:34rem;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px 28px}
.brand{font-weight:700;letter-spacing:.12em;font-size:13px;line-height:1.3;margin:0 0 24px}
.brand span{display:block}.brand span+span{color:var(--orange)}
h1{font-size:26px;line-height:1.25;margin:0 0 16px}
p{margin:0 0 14px}
.lead{font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0 8px}
a.button{display:inline-block;padding:11px 18px;border-radius:9px;background:var(--orange);color:#fff;text-decoration:none;font-weight:600}
a.button:hover,a.button:focus-visible{background:var(--orange-deep)}
a.button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
a{color:var(--orange-deep)}
.signout{margin-top:22px;font-size:15px}
@media (prefers-reduced-motion:no-preference){a.button{transition:background .15s}}
`;

const TZ_SCRIPT = `(function(){try{var z=Intl.DateTimeFormat().resolvedOptions().timeZone;if(!z)return;document.querySelectorAll("a[data-tz]").forEach(function(a){a.href=a.getAttribute("href")+"?tz="+encodeURIComponent(z)})}catch(e){}})();`;

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · North Aero Ground Tutor</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="brand">${BRAND_LINES.map((l) => `<span>${escapeHtml(l)}</span>`).join("")}</p>
${body}
<p class="signout"><a href="${SIGN_OUT_PATH}">${escapeHtml(ACTIONS.signOut)}</a></p>
</main>
<script>${TZ_SCRIPT}</script>
</body>
</html>
`;
}

function actions(): string {
	return `<div class="actions">
<a class="button" href="${EXPORT_PATH}" data-tz>${escapeHtml(ACTIONS.download)}</a>
<a class="button secondary" href="${RECORD_PATH}" data-tz>${escapeHtml(ACTIONS.print)}</a>
</div>`;
}

export function pauseScreenHtml(): string {
	const s = PAUSE_SCREEN;
	return page(
		s.pageTitle,
		`<h1>${escapeHtml(s.heading)}</h1>
<p class="lead">${escapeHtml(s.message)}</p>
<p>${escapeHtml(s.contact)}</p>
<p>${escapeHtml(s.safe)}</p>
${actions()}`,
	);
}

export function retentionScreenHtml(retentionEndsAt: Date, expired: boolean): string {
	const s = RETENTION_SCREEN;
	const body = expired
		? `<h1>${escapeHtml(s.heading)}</h1>
<p class="lead">${escapeHtml(s.expired)}</p>
<p>${escapeHtml(s.contact)}</p>`
		: `<h1>${escapeHtml(s.heading)}</h1>
<p class="lead">${escapeHtml(s.kept(formatDay(retentionEndsAt)))}</p>
<p>${escapeHtml(s.download)}</p>
${actions()}
<p>${escapeHtml(s.contact)}</p>`;
	return page(s.pageTitle, body);
}

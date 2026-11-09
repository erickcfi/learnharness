/**
 * The pause screen and the plan-ended screen (P2-05, P1-08; C3 req 6,
 * C1 req 6), built on the shared interstitial page (interstitial.ts): plain
 * HTML from the front door, no script, nothing loaded from outside, no
 * Clerk. Text: copy.ts.
 */
import { ACTIONS, PAUSE_SCREEN, RETENTION_EXTRA_ACTIONS, RETENTION_SCREEN, SCHOOL_TIME_ZONE } from "./copy.ts";
import { interstitialPage, READ_PATH, type ScreenAction } from "./interstitial.ts";

export const EXPORT_PATH = "/account/export";
export const RECORD_PATH = "/account/record";
export { READ_PATH, SIGN_OUT_PATH } from "./interstitial.ts";

/** "February 6, 2027", in the school's time zone. */
export function formatDay(date: Date): string {
	return new Intl.DateTimeFormat("en-US", { timeZone: SCHOOL_TIME_ZONE, year: "numeric", month: "long", day: "numeric" }).format(date);
}

const download: ScreenAction = { label: ACTIONS.download, href: EXPORT_PATH };
const print: ScreenAction = { label: ACTIONS.print, href: RECORD_PATH };

export function pauseScreenHtml(): string {
	const s = PAUSE_SCREEN;
	return interstitialPage({
		title: s.pageTitle,
		heading: s.heading,
		lead: s.message,
		paragraphs: [s.contact, s.safe],
		actions: [{ label: ACTIONS.read, href: READ_PATH, primary: true }, download, print],
	});
}

export function retentionScreenHtml(retentionEndsAt: Date, expired: boolean): string {
	const s = RETENTION_SCREEN;
	if (expired) return interstitialPage({ title: s.pageTitle, heading: s.heading, lead: s.expired, paragraphs: [s.contact], actions: [] });
	return interstitialPage({
		title: s.pageTitle,
		heading: s.heading,
		lead: s.kept(formatDay(retentionEndsAt)),
		paragraphs: [s.download],
		actions: [...RETENTION_EXTRA_ACTIONS.map((a, i) => ({ ...a, primary: i === 0 })), { ...download, primary: RETENTION_EXTRA_ACTIONS.length === 0 }, print],
		after: [s.contact],
	});
}

/**
 * Every word a paused student, or a student whose plan ended, sees from the
 * front door (P2-05, P1-08; C3 req 6, C1 req 6). Erick reviews and edits
 * this file before launch. Plain, short sentences, no em dashes.
 *
 * The pause sentence is the PRD's own (C3 req 6), the same text as the
 * meter's PAUSED_MESSAGE (metering/proxy.ts; a test keeps them equal), so
 * the tutor and the screen say the same thing.
 */
import { SUBSCRIBE_AGAIN_ACTION } from "../billing/copy.ts";
import { CONTACT_EMAIL } from "../marketing/site.ts";

export { CONTACT_EMAIL };

export const PAUSED_MESSAGE = "Your account is paused for a fair-use review. Contact North Aero.";

export const BRAND_LINES = ["NORTH AERO", "GROUND TUTOR"] as const;

/**
 * The school's time zone for every date on the study record and screens
 * (master decision, 2026-11-08, shared with reports). w2-email exports the
 * same constant; the master points this at it when the branches merge.
 */
export const SCHOOL_TIME_ZONE = "America/Los_Angeles";

export const PAUSE_SCREEN = {
	pageTitle: "Your tutor is paused",
	heading: "Your tutor is paused",
	message: PAUSED_MESSAGE,
	contact: `Email ${CONTACT_EMAIL} and we will sort it out.`,
	safe: "Your sessions and records are safe. You can still read your sessions, download a copy of your data and print your study record. The tutor cannot start new work while your account is paused.",
};

export const RETENTION_SCREEN = {
	pageTitle: "Your plan has ended",
	heading: "Your plan has ended",
	kept: (date: string) => `We keep your data until ${date}. Then it is deleted.`,
	download: "Download a copy before then. It has your sessions, your knowledge graph, your imported notes and your study record.",
	expired: "Your 90 days are over, so your data is being deleted.",
	contact: `Questions? Email ${CONTACT_EMAIL}.`,
};

export const ACTIONS = {
	read: "Read your sessions",
	download: "Download your data",
	print: "Print your study record",
	signOut: "Sign out",
};

/**
 * W2-8's spot: buttons shown first on the plan-ended screen, for example
 * { label: "Subscribe again", href: "<the plans page>" }. Empty until then.
 */
export const RETENTION_EXTRA_ACTIONS: ReadonlyArray<{ label: string; href: string }> = [SUBSCRIBE_AGAIN_ACTION];

/** README.txt at the top of the data export (P1-08). */
export const EXPORT_README = {
	title: "North Aero Ground Tutor: your data",
	made: (when: string) => `Made on ${when} (UTC).`,
	label: "Self-study record. Not a logbook entry or instructor endorsement.",
	contentsHeading: "What is in this file:",
	contents: [
		"sessions/: each study session as a Markdown file. Any text editor opens it.",
		"study-record.html: your study record. Open it in a web browser to read or print it.",
		"knowledge-graph.json: the facts the tutor recorded about what you learned, as data.",
		"imported-notes.json: the notes files you imported, and when.",
	],
	missingHeading: "These parts could not be included this time. Download again later to get them:",
	contact: `Questions? Email ${CONTACT_EMAIL}.`,
};

/** JSON errors for an open tutor tab, and for the export and record links. */
export const API_MESSAGES = {
	retention: "Your plan has ended. You can download your data until it is deleted.",
	expired: "Your 90 days are over, so your data is being deleted.",
	exportBusy: "Your download is already being prepared. Try again in a minute.",
	exportFailed: "Your download could not be prepared just now. Try again in a minute.",
	recordFailed: "Your study record could not be prepared just now. Try again in a minute.",
};

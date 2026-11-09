/**
 * Every word the report emails, the report settings page and the
 * unsubscribe page say, in one place for Erick's review (C6, N8, N12).
 *
 * Reports can go to the student or to their CFI (any address, D20), so the
 * emails read like a report about the student, not a letter to them.
 * Plain, short sentences. Framework-free.
 */
import { RECORD_LABEL } from "../records/build.ts";
import { CONTACT_EMAIL } from "../marketing/site.ts";

/** N8. At the top and the bottom of every report email. */
export const REPORT_LABEL = RECORD_LABEL;

export const BRAND_NAME = "North Aero Ground Tutor";

const kindName = (kind: "teach" | "practice") => (kind === "practice" ? "Practice session" : "Study session");

export const reportCopy = {
	common: {
		studentRow: "Student",
		dateRow: "Date",
		weekRow: "Week",
		studyTimeRow: "Study time",
		sessionsRow: "Sessions",
		factsRow: "New facts",
		sessionKind: kindName,
		sessionTime: (duration: string) => `Study time: ${duration}`,
		planProgress: (covered: number, total: number) => `Plan: ${covered} of ${total} topics covered.`,
		covered: (titles: string) => `Covered: ${titles}.`,
		inProgress: (title: string) => `In progress: ${title}.`,
		notYet: (count: number) => `Not yet: ${count} ${count === 1 ? "topic" : "topics"}.`,
		noPlan: "No plan yet.",
		moreTitles: (n: number) => `and ${n} more`,
		learnedHeading: "What was learned",
		moreFacts: (n: number) => `And ${n} more ${n === 1 ? "fact" : "facts"}. The study record lists them all.`,
		replyLine: `Questions? Reply to this email, or write to ${CONTACT_EMAIL}.`,
		tagline: `${BRAND_NAME}. A North Aero service. Salinas, California.`,
		settingsLink: "Report settings",
	},
	session: {
		subject: (date: string, name: string | null) => (name ? `Study report: ${name}, ${date}` : `Study report, ${date}`),
		preheader: (duration: string, date: string) => `${duration} of study on ${date}.`,
		title: "Study session report",
		studiedHeading: "What was studied",
		noFacts: "No new facts were recorded in this session.",
		noChats: "This time was spent outside a tutor session.",
		why: `Sent because session reports are turned on for this ${BRAND_NAME} account.`,
		unsubscribeLink: "Turn off session reports",
	},
	weekly: {
		subject: (from: string, to: string, name: string | null) => (name ? `Weekly study report: ${name}, ${from} to ${to}` : `Weekly study report, ${from} to ${to}`),
		preheader: (duration: string, sessions: number) => `${duration} of study in ${sessions} ${sessions === 1 ? "session" : "sessions"} this week.`,
		title: "Weekly study report",
		weekValue: (from: string, to: string) => `${from} to ${to}`,
		sessionsHeading: "Sessions this week",
		noFacts: "No new facts were recorded this week.",
		why: `Sent because weekly reports are turned on for this ${BRAND_NAME} account.`,
		unsubscribeLink: "Turn off weekly reports",
	},
	ownerAlert: {
		subject: (kind: "cost-alert" | "autopause", tenantShort: string, threshold: string) =>
			kind === "autopause" ? `Autopause: student ${tenantShort} paused at ${threshold}` : `Cost alert: student ${tenantShort} passed ${threshold}`,
		title: (kind: "cost-alert" | "autopause") => (kind === "autopause" ? "A student was paused" : "Cost alert"),
		explain: (kind: "cost-alert" | "autopause") =>
			kind === "autopause"
				? "This student's model cost passed the autopause level. The tutor is paused for them. Billing goes on. You can unpause them on the dashboard."
				: "This student's model cost passed the alert level. Nothing is paused yet.",
		tenantRow: "Tenant",
		costRow: "Model cost, last 30 days",
		thresholdRow: (kind: "cost-alert" | "autopause") => (kind === "autopause" ? "Autopause level" : "Alert level"),
		timeRow: "Time",
		dashboardLink: "Open the dashboard",
		why: `Sent to the Owner alert address of the ${BRAND_NAME} (OWNER_ALERT_EMAIL).`,
	},
} as const;

export const settingsCopy = {
	pageTitle: `Email reports | ${BRAND_NAME}`,
	heading: "Email reports",
	intro: "Get a short report by email after each study session, once a week, or both. Reports go to one address. It can be yours or your CFI's.",
	label: `Each report says: "${REPORT_LABEL}"`,
	addressLabel: "Send reports to",
	addressHelp: "One email address.",
	sessionLabel: "A report after each study session",
	sessionHelp: "Sent about 30 minutes after you stop studying.",
	weeklyLabel: "A weekly report",
	weeklyHelp: "Sent Monday morning, for the week before.",
	save: "Save",
	saved: "Saved.",
	bothOff: "Both reports are off.",
	needAddress: "Enter an email address to turn a report on.",
	badAddress: "That email address does not look right. Check it and try again.",
	unsubscribeNote: "Every report has a link to turn it off.",
	emailOff: "Email reports are not set up yet. Your choices are saved, and reports start when they are.",
	back: "Back to the tutor",
	signInAgain: "Please sign in again.",
} as const;

export const unsubscribeCopy = {
	pageTitle: `Turn off email reports | ${BRAND_NAME}`,
	heading: "Turn off email reports",
	question: (kind: "session" | "weekly") =>
		kind === "weekly" ? "Turn off the weekly study report for this account?" : "Turn off the report sent after each study session for this account?",
	turnOff: (kind: "session" | "weekly") => (kind === "weekly" ? "Turn off weekly reports" : "Turn off session reports"),
	turnOffAll: "Turn off all reports",
	done: (kind: "session" | "weekly" | "all") =>
		kind === "all" ? "Done. All email reports are off." : kind === "weekly" ? "Done. Weekly reports are off." : "Done. Session reports are off.",
	doneMore: `They can be turned back on in the ${BRAND_NAME}, under Email reports.`,
	badLink: `This link does not work. It may be old. Sign in to the ${BRAND_NAME} and open Email reports to change the settings.`,
	contact: `Questions? Write to ${CONTACT_EMAIL}.`,
} as const;

/**
 * The two report emails (C6 req 2 and 3, N8, D26), built from the study
 * record (frontdoor/records) and the front door's active time (PD1).
 * Pure: no clock, no I/O.
 *
 * Session report: one study sitting. Its date and study time, each tutor
 * session it touched (title, time, plan progress), and the facts first
 * learned in those sessions during the sitting.
 *
 * Weekly report: one Monday-to-Sunday week. Totals, each session studied
 * that week, and the facts first learned in tutor sessions that week.
 *
 * Every email carries the N8 label at the top and the bottom, a plain-text
 * part, an unsubscribe link, and the List-Unsubscribe headers (RFC 2369,
 * RFC 8058 one-click).
 */
import { reportCopy, REPORT_LABEL } from "../email/copy.ts";
import { type Block, type EmailDocument, oneLine, renderEmailHtml, renderEmailText } from "../email/layout.ts";
import type { EmailMessage } from "../email/sender.ts";
import { buildStudyRecord, formatDuration, type PlanProgress, type RecordFact, type RecordSession } from "../records/build.ts";
import type { RecordSource } from "../records/upstream.ts";
import { type EndedSitting, sittingSeconds } from "./sittings.ts";
import { displayDate, displayShortDate, type ReportWeek } from "./time.ts";

/** At most this many facts in a session email, and in a weekly email. */
export const SESSION_FACT_LIMIT = 15;
export const WEEKLY_FACT_LIMIT = 20;
/** At most this many covered topic titles on one line. */
const TITLE_LIMIT = 6;

export type ReportKind = "session" | "weekly";

export interface ReportContent {
	kind: ReportKind;
	subject: string;
	doc: EmailDocument;
}

export interface StudentInfo {
	/** From the login. Null when the account has no name. */
	name: string | null;
}

const c = reportCopy.common;

function planLines(plan: PlanProgress | null): string[] {
	if (!plan || plan.total === 0) return [c.noPlan];
	const lines = [c.planProgress(plan.covered, plan.total)];
	const covered = plan.topics.filter((t) => t.status === "covered").map((t) => oneLine(t.title));
	if (covered.length > 0) {
		const shown = covered.slice(0, TITLE_LIMIT).join(", ");
		lines.push(c.covered(covered.length > TITLE_LIMIT ? `${shown}, ${c.moreTitles(covered.length - TITLE_LIMIT)}` : shown));
	}
	if (plan.current) lines.push(c.inProgress(oneLine(plan.current)));
	const notYet = plan.topics.filter((t) => t.status === "not-yet").length;
	if (notYet > 0) lines.push(c.notYet(notYet));
	return lines;
}

function sessionCards(sessions: readonly RecordSession[], seconds: ReadonlyMap<string, number>): Block[] {
	return sessions.map((s) => ({
		kind: "card" as const,
		title: oneLine(s.title) || c.sessionKind(s.kind),
		lines: [`${c.sessionKind(s.kind)}. ${c.sessionTime(formatDuration(seconds.get(s.id) ?? 0))}`, ...planLines(s.plan)],
	}));
}

function factBlocks(facts: readonly RecordFact[], limit: number, none: string): Block[] {
	if (facts.length === 0) return [{ kind: "paragraph", text: none }];
	const blocks: Block[] = [{ kind: "list", items: facts.slice(0, limit).map((f) => ({ lead: oneLine(f.name), text: oneLine(f.statement) })) }];
	if (facts.length > limit) blocks.push({ kind: "paragraph", text: c.moreFacts(facts.length - limit) });
	return blocks;
}

/** Facts first learned (birth session) in one of `chatIds`, created in [from, to]. Oldest first. */
function factsLearned(source: RecordSource, chatIds: ReadonlySet<string>, from: Date, to: Date): RecordFact[] {
	return source.graph.propositions
		.filter((p) => {
			const birth = p.provenance[0]?.chatId;
			const at = Date.parse(p.createdAt);
			return birth !== undefined && chatIds.has(birth) && at >= from.getTime() && at <= to.getTime();
		})
		.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.name.localeCompare(b.name))
		.map((p) => ({ name: p.name, statement: p.statement }));
}

/** The record's sessions for these chats, in the given order. Chats the tutor no longer lists are left out. */
function recordSessions(source: RecordSource, chatIds: readonly string[], timeZone: string, builtAt: Date): RecordSession[] {
	const record = buildStudyRecord(source, { studentName: "", printedAt: builtAt, timeZone });
	const byId = new Map(record.sessions.map((s) => [s.id, s]));
	return chatIds.map((id) => byId.get(id)).filter((s): s is RecordSession => s !== undefined);
}

function footer(kind: ReportKind) {
	return {
		why: kind === "weekly" ? reportCopy.weekly.why : reportCopy.session.why,
		lines: [c.replyLine, c.tagline],
	};
}

export function buildSessionReport(input: {
	source: RecordSource;
	sitting: Pick<EndedSitting, "sittingStartedAt" | "chats">;
	student: StudentInfo;
	timeZone: string;
	builtAt: Date;
}): ReportContent {
	const { source, sitting, student, timeZone, builtAt } = input;
	const s = reportCopy.session;
	const date = displayDate(sitting.sittingStartedAt, timeZone);
	const duration = formatDuration(sittingSeconds(sitting));
	const name = student.name ? oneLine(student.name) : null;
	const seconds = new Map(sitting.chats.map((ch) => [ch.chatId, ch.activeSeconds]));
	const sessions = recordSessions(
		source,
		sitting.chats.map((ch) => ch.chatId),
		timeZone,
		builtAt,
	);
	const facts = factsLearned(source, new Set(sitting.chats.map((ch) => ch.chatId)), sitting.sittingStartedAt, builtAt);
	const f = footer("session");
	const doc: EmailDocument = {
		title: s.title,
		preheader: s.preheader(duration, date),
		label: REPORT_LABEL,
		blocks: [
			{
				kind: "rows",
				rows: [...(name ? [{ label: c.studentRow, value: name }] : []), { label: c.dateRow, value: date }, { label: c.studyTimeRow, value: duration }],
			},
			{ kind: "heading", text: s.studiedHeading },
			...(sessions.length > 0 ? sessionCards(sessions, seconds) : [{ kind: "paragraph" as const, text: s.noChats }]),
			{ kind: "heading", text: c.learnedHeading },
			...factBlocks(facts, SESSION_FACT_LIMIT, s.noFacts),
			{ kind: "paragraph", text: f.why },
		],
		footer: { links: [], lines: f.lines },
	};
	return { kind: "session", subject: s.subject(displayShortDate(sitting.sittingStartedAt, timeZone), name), doc };
}

export interface WeekStudy {
	week: ReportWeek;
	/** Active seconds per chat for stretches that started in the week, in first-use order. */
	chats: Array<{ chatId: string; activeSeconds: number }>;
	/** All active seconds in the week, including time outside a chat. */
	totalSeconds: number;
}

export function buildWeeklyReport(input: { source: RecordSource; study: WeekStudy; student: StudentInfo; timeZone: string; builtAt: Date }): ReportContent {
	const { source, study, student, timeZone, builtAt } = input;
	const w = reportCopy.weekly;
	const from = displayShortDate(study.week.startsAt, timeZone);
	const to = displayShortDate(new Date(study.week.endsAt.getTime() - 1), timeZone);
	const toLong = displayDate(new Date(study.week.endsAt.getTime() - 1), timeZone);
	const duration = formatDuration(study.totalSeconds);
	const name = student.name ? oneLine(student.name) : null;
	const seconds = new Map(study.chats.map((ch) => [ch.chatId, ch.activeSeconds]));
	const sessions = recordSessions(
		source,
		study.chats.map((ch) => ch.chatId),
		timeZone,
		builtAt,
	);
	const tutorChats = new Set(source.chats.map((ch) => ch.id));
	const facts = factsLearned(source, tutorChats, study.week.startsAt, new Date(study.week.endsAt.getTime() - 1));
	const f = footer("weekly");
	const doc: EmailDocument = {
		title: w.title,
		preheader: w.preheader(duration, sessions.length),
		label: REPORT_LABEL,
		blocks: [
			{
				kind: "rows",
				rows: [
					...(name ? [{ label: c.studentRow, value: name }] : []),
					{ label: c.weekRow, value: w.weekValue(from, toLong) },
					{ label: c.studyTimeRow, value: duration },
					{ label: c.sessionsRow, value: String(sessions.length) },
					{ label: c.factsRow, value: String(facts.length) },
				],
			},
			{ kind: "heading", text: w.sessionsHeading },
			...(sessions.length > 0 ? sessionCards(sessions, seconds) : [{ kind: "paragraph" as const, text: reportCopy.session.noChats }]),
			{ kind: "heading", text: c.learnedHeading },
			...factBlocks(facts, WEEKLY_FACT_LIMIT, w.noFacts),
			{ kind: "paragraph", text: f.why },
		],
		footer: { links: [], lines: f.lines },
	};
	return { kind: "weekly", subject: w.subject(from, to, name), doc };
}

export interface ReportLinks {
	publicUrl: string;
	unsubscribeToken: string;
}

export function unsubscribeUrl(links: ReportLinks, kind: ReportKind): string {
	return `${links.publicUrl}/account/unsubscribe?t=${encodeURIComponent(links.unsubscribeToken)}&k=${kind}`;
}

export const settingsUrl = (publicUrl: string) => `${publicUrl}/account/reports`;

/** The email to send: the document with its footer links, both parts, and the List-Unsubscribe headers. */
export function reportMessage(content: ReportContent, to: { address: string; tenantId: string }, links: ReportLinks): EmailMessage {
	const unsubscribe = unsubscribeUrl(links, content.kind);
	const unsubscribeText = content.kind === "weekly" ? reportCopy.weekly.unsubscribeLink : reportCopy.session.unsubscribeLink;
	const doc: EmailDocument = {
		...content.doc,
		footer: {
			links: [
				{ text: unsubscribeText, href: unsubscribe },
				{ text: c.settingsLink, href: settingsUrl(links.publicUrl) },
			],
			lines: content.doc.footer.lines,
		},
	};
	return {
		kind: content.kind === "weekly" ? "weekly-report" : "session-report",
		to: to.address,
		subject: content.subject,
		html: renderEmailHtml(doc),
		text: renderEmailText(doc),
		headers: {
			"List-Unsubscribe": `<${unsubscribe}>`,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
		tenantId: to.tenantId,
	};
}

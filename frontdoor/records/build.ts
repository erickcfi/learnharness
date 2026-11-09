/**
 * Build one student's study record from upstream's read-only API data
 * (C6 req 1, N8). Pure: no I/O, no clock, no model call.
 *
 * Owner rulings, 2026-11-08:
 *   - Session length is the front door's active time (PD1), per session.
 *     The caller passes it in; until it exists, a session shows a dash.
 *   - Topics are the session's plan topic titles, each with its status.
 *   - "What they learned" is a plain list from the graph: each fact's
 *     name and statement, grouped by the session that first taught it
 *     (upstream's birth-session rule: provenance[0]).
 *   - Facts from the student's imported notes get their own section.
 *   - The header carries the name, print date, date range and totals.
 */
import type { RecordSource, UpstreamChatRecord, UpstreamMessage, UpstreamPlanTree } from "./upstream.ts";

/** N8. Printed at the top and the bottom of every page. */
export const RECORD_LABEL = "Self-study record. Not a logbook entry or instructor endorsement.";

export type TopicStatus = "covered" | "in-progress" | "not-yet";

export interface PlanProgress {
	/** Plan topics in plan order. */
	topics: Array<{ title: string; status: TopicStatus }>;
	total: number;
	covered: number;
	/** Title of the topic in progress, or null before the first check. */
	current: string | null;
}

export interface RecordSession {
	id: string;
	title: string;
	kind: "teach" | "practice";
	/** ISO time the session started (upstream createdAt). */
	startedAt: string;
	/** Start date in the record's time zone, e.g. "Nov 3, 2026". */
	date: string;
	/** Front door active time (PD1); null when not recorded. */
	activeSeconds: number | null;
	/** null when the session has no plan yet (probe, practice). */
	plan: PlanProgress | null;
}

export interface RecordFact {
	name: string;
	statement: string;
}

export interface FactGroup {
	/** Birth session id: a chat id, or a notes source id ("src_…"). */
	sourceId: string;
	/** Session title, or the imported file's name. */
	heading: string;
	/** Session date when the session is in the record; else null. */
	date: string | null;
	facts: RecordFact[];
}

export interface StudyRecord {
	label: typeof RECORD_LABEL;
	studentName: string;
	printedOn: string;
	timeZone: string;
	firstDate: string | null;
	lastDate: string | null;
	sessionCount: number;
	studyTime: { totalSeconds: number | null; recordedSessions: number };
	sessions: RecordSession[];
	learned: {
		totalFacts: number;
		/** Facts first taught in a tutor session, in session order. */
		sessionGroups: FactGroup[];
		/** Facts from the student's imported notes, one group per file. */
		notesGroups: FactGroup[];
		/** Facts with no recorded source (legacy graph data). */
		otherFacts: RecordFact[];
	};
}

export interface BuildOptions {
	/** From the student's login. */
	studentName: string;
	printedAt: Date;
	/** IANA zone for every date on the record, e.g. "America/Los_Angeles". The caller decides. */
	timeZone: string;
	/** Front door active time per upstream chat id, in seconds (PD1). */
	activeSecondsBySession?: Readonly<Record<string, number>>;
}

/** "45 min", "1 h 5 min"; an en dash when not recorded. */
export function formatDuration(seconds: number | null): string {
	if (seconds === null) return "–";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * Plan progress by upstream's own rule (src/core/contracts/plan.ts,
 * derivePlanStatusesLh): position comes from the teacher's quiz and
 * explain CALLS tagged with a plan node id. The node of the latest call
 * is in progress; nodes of earlier stays are covered; the rest are not
 * yet. Unknown node ids move nothing. A drift guard test runs both
 * implementations on the same messages.
 */
export function planProgress(tree: UpstreamPlanTree, messages: readonly UpstreamMessage[]): PlanProgress {
	const ids = new Set(tree.nodes.map((nd) => nd.id));
	const runs: string[] = [];
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content as Array<{ type?: unknown; name?: unknown; arguments?: unknown }>) {
			if (typeof block !== "object" || block === null) continue;
			if (block.type !== "toolCall" || (block.name !== "quiz" && block.name !== "explain")) continue;
			const nodeId = (block.arguments as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof nodeId !== "string" || !ids.has(nodeId)) continue;
			if (runs.at(-1) !== nodeId) runs.push(nodeId);
		}
	}
	const current = runs.at(-1) ?? null;
	const visited = new Set(runs.slice(0, -1));
	const topics = tree.nodes.map((nd) => ({
		title: nd.title,
		status: (nd.id === current ? "in-progress" : visited.has(nd.id) ? "covered" : "not-yet") as TopicStatus,
	}));
	return {
		topics,
		total: topics.length,
		covered: topics.filter((t) => t.status === "covered").length,
		current: current === null ? null : (tree.nodes.find((nd) => nd.id === current)?.title ?? null),
	};
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
	// Throws RangeError on an unknown zone: never guess one.
	return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "short", day: "numeric" });
}

function baseName(filePath: string): string {
	const parts = filePath.split(/[\\/]/).filter((p) => p.length > 0);
	return parts.at(-1) ?? filePath;
}

function isNotesSource(id: string, fileSources: Record<string, string>): boolean {
	return Object.hasOwn(fileSources, id) || id.startsWith("src_");
}

export function buildStudyRecord(source: RecordSource, options: BuildOptions): StudyRecord {
	const fmt = dateFormatter(options.timeZone);
	const active = options.activeSecondsBySession ?? {};
	for (const [id, seconds] of Object.entries(active)) {
		if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
			throw new TypeError(`activeSecondsBySession["${id}"] must be a finite number of seconds, 0 or more`);
		}
	}

	// Sessions: listed, with messages, with a record, oldest first.
	const listed = source.chats
		.filter((c) => c.messageCount > 0)
		.map((c) => ({ summary: c, record: source.records[c.id] }))
		.filter((x): x is { summary: (typeof source.chats)[number]; record: UpstreamChatRecord } => x.record !== undefined)
		.sort((a, b) => Date.parse(a.summary.createdAt) - Date.parse(b.summary.createdAt) || a.summary.id.localeCompare(b.summary.id));

	const sessions: RecordSession[] = listed.map(({ summary, record }) => ({
		id: summary.id,
		title: summary.title,
		kind: summary.kind,
		startedAt: summary.createdAt,
		date: fmt.format(new Date(summary.createdAt)),
		activeSeconds: Object.hasOwn(active, summary.id) ? active[summary.id]! : null,
		plan: record.tree ? planProgress(record.tree, record.messages) : null,
	}));

	const recorded = sessions.filter((s) => s.activeSeconds !== null);
	const studyTime = {
		totalSeconds: recorded.length === 0 ? null : recorded.reduce((sum, s) => sum + s.activeSeconds!, 0),
		recordedSessions: recorded.length,
	};

	// What they learned: facts grouped by birth session.
	const { propositions, sessions: titles, fileSources } = source.graph;
	const byBirth = new Map<string, Array<{ fact: RecordFact; createdAt: string }>>();
	const other: Array<{ fact: RecordFact; createdAt: string }> = [];
	for (const p of propositions) {
		const entry = { fact: { name: p.name, statement: p.statement }, createdAt: p.createdAt };
		const birth = p.provenance[0]?.chatId;
		if (birth === undefined) {
			other.push(entry);
			continue;
		}
		const list = byBirth.get(birth) ?? [];
		list.push(entry);
		byBirth.set(birth, list);
	}
	const ordered = (entries: Array<{ fact: RecordFact; createdAt: string }>) =>
		[...entries]
			.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.fact.name.localeCompare(b.fact.name))
			.map((e) => e.fact);

	const sessionGroups: FactGroup[] = [];
	for (const s of sessions) {
		const entries = byBirth.get(s.id);
		if (entries) sessionGroups.push({ sourceId: s.id, heading: s.title, date: s.date, facts: ordered(entries) });
	}
	const inRecord = new Set(sessions.map((s) => s.id));
	const orphanGroups: FactGroup[] = [];
	const notesGroups: FactGroup[] = [];
	for (const [birth, entries] of byBirth) {
		if (inRecord.has(birth)) continue;
		if (isNotesSource(birth, fileSources)) {
			notesGroups.push({ sourceId: birth, heading: baseName(fileSources[birth] ?? birth), date: null, facts: ordered(entries) });
		} else {
			orphanGroups.push({ sourceId: birth, heading: titles[birth] ?? "Session no longer listed", date: null, facts: ordered(entries) });
		}
	}
	const byHeading = (a: FactGroup, b: FactGroup) => a.heading.localeCompare(b.heading) || a.sourceId.localeCompare(b.sourceId);
	orphanGroups.sort(byHeading);
	notesGroups.sort(byHeading);

	return {
		label: RECORD_LABEL,
		studentName: options.studentName,
		printedOn: fmt.format(options.printedAt),
		timeZone: options.timeZone,
		firstDate: sessions[0]?.date ?? null,
		lastDate: sessions.at(-1)?.date ?? null,
		sessionCount: sessions.length,
		studyTime,
		sessions,
		learned: {
			totalFacts: propositions.length,
			sessionGroups: [...sessionGroups, ...orphanGroups],
			notesGroups,
			otherFacts: ordered(other),
		},
	};
}

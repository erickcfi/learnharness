/**
 * One student's page on the dashboard (C7 req 2 and 3): the table row, each
 * session with its study time, plan topics and non-aviation label, consent,
 * alerts and pauses. Session titles and topics come live from the tenant's
 * own server (C7 req 6); session text never comes through here.
 */
import { type Alert, type Db, getTenant, getTopicLabels, listAlerts, listPauses, type Pause } from "../db/index.ts";
import { listSessionStudy } from "../study-time/queries.ts";
import type { StudentDirectory } from "./directory.ts";
import { buildOverview, type TenantRow } from "./overview.ts";
import type { PeriodKey } from "./period.ts";
import { consentState, type ConsentState } from "./session-text.ts";
import { fetchSessions, fetchSessionTopics, type TenantFetch } from "./tenant-api.ts";

export interface StudentSession {
	chatId: string;
	title: string | null;
	createdAt: string | null;
	phase: string | null;
	kind: string | null;
	activeSeconds: number;
	lastActiveAt: Date | null;
	/** Plan topic titles, when known. */
	topics: string[] | null;
	/** N7 label; null until the session has ended and been labeled. */
	isAviation: boolean | null;
}

export interface StudentDetail {
	row: TenantRow;
	sessions: StudentSession[];
	/** Set when the tenant's server did not answer: sessions then come from study time only. */
	sessionsError: string | null;
	consent: ConsentState;
	canShowText: boolean;
	alerts: Alert[];
	pauses: Pause[];
}

/** Sessions whose plan topics are fetched live when they have no stored label. */
const LIVE_TOPIC_SESSIONS = 8;

export async function buildStudentDetail(
	deps: { db: Db; tenantFetch: TenantFetch; directory?: StudentDirectory },
	tenantId: string,
	options: { period: PeriodKey; now?: Date },
): Promise<StudentDetail | null> {
	if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !(await getTenant(deps.db, tenantId))) return null;
	const [overview, study, labels, consent, alerts, pauses] = await Promise.all([
		buildOverview(deps.db, { period: options.period, now: options.now, directory: deps.directory, tenantIds: [tenantId] }),
		listSessionStudy(deps.db, tenantId),
		getTopicLabels(deps.db, tenantId),
		consentState(deps.db, tenantId),
		listAlerts(deps.db, tenantId),
		listPauses(deps.db, tenantId),
	]);
	const row = overview.rows[0];
	if (!row) return null;

	let live: Awaited<ReturnType<typeof fetchSessions>> = [];
	let sessionsError: string | null = null;
	try {
		live = await fetchSessions(deps.tenantFetch, tenantId);
	} catch {
		sessionsError = "The student's tutor did not answer, so session titles are missing.";
	}
	const studyBy = new Map(study.map((s) => [s.chatId, s]));
	const labelBy = new Map(labels.map((l) => [l.chatId, l]));
	const ids = [...new Set([...live.map((c) => c.id), ...study.map((s) => s.chatId)])];
	const liveBy = new Map(live.map((c) => [c.id, c]));

	const sessions: StudentSession[] = ids.map((chatId) => {
		const c = liveBy.get(chatId);
		const s = studyBy.get(chatId);
		const found = labelBy.get(chatId);
		// isAviation null: the tutor had no such chat when the sweep asked (flags.ts).
		const missing = found?.isAviation === null;
		const l = missing ? undefined : found;
		const stored = l?.topic.split(" | ")[1];
		return {
			chatId,
			title: c?.title ?? l?.topic.split(" | ")[0] ?? (missing ? "Session not found in the tutor" : null),
			createdAt: c?.createdAt ?? null,
			phase: c?.phase ?? null,
			kind: c?.kind ?? null,
			activeSeconds: s?.activeSeconds ?? 0,
			lastActiveAt: s?.lastActiveAt ?? null,
			topics: stored ? stored.split("; ") : l || missing ? [] : null,
			isAviation: l ? l.isAviation : null,
		};
	});
	const sortKey = (x: StudentSession) => Math.max(x.lastActiveAt?.getTime() ?? 0, x.createdAt ? Date.parse(x.createdAt) : 0);
	sessions.sort((a, b) => sortKey(b) - sortKey(a));

	if (!sessionsError) {
		const need = sessions.filter((x) => x.topics === null).slice(0, LIVE_TOPIC_SESSIONS);
		await Promise.all(
			need.map(async (x) => {
				try {
					x.topics = (await fetchSessionTopics(deps.tenantFetch, tenantId, x.chatId)).topics;
				} catch {
					// Leave topics unknown; the page shows a dash.
				}
			}),
		);
	}
	return { row, sessions, sessionsError, consent, canShowText: consent.optedIn || consent.testerWrittenOk, alerts, pauses };
}

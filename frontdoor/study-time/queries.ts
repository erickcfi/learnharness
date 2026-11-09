/**
 * Reading study time back (P3-02, PD1): per session for the study record and
 * the dashboard, and which sessions have ended.
 *
 * A session is one upstream chat (chat id). A session has ended when its
 * chat has had no active time for SESSION_END_MINUTES. The non-aviation
 * labels (admin/flags.ts) use this rule; the session-end email can too.
 */
import type { Db } from "../db/index.ts";

/** A session ends after this many minutes with no active time in its chat. */
export const SESSION_END_MINUTES = 30;

const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
const toDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

/**
 * Active seconds per upstream chat id for one tenant, for the record builder
 * (frontdoor/records, `activeSecondsBySession`). Time outside any chat is
 * left out. Optional range: stretches that started in [since, until).
 */
export async function activeSecondsBySession(db: Db, tenantId: string, range: { since?: Date; until?: Date } = {}): Promise<Record<string, number>> {
	const rows = await db.query(
		`select chat_id, sum(active_seconds) as s from study_time
		 where tenant_id = $1 and chat_id is not null and started_at >= $2 and started_at < $3
		 group by chat_id`,
		[tenantId, range.since ?? new Date(0), range.until ?? new Date("9999-12-31T00:00:00Z")],
	);
	const out: Record<string, number> = {};
	for (const r of rows) out[String(r.chat_id)] = num(r.s);
	return out;
}

export interface SessionStudy {
	chatId: string;
	activeSeconds: number;
	firstActiveAt: Date;
	lastActiveAt: Date;
}

/** One tenant's sessions with study time, newest activity first. */
export async function listSessionStudy(db: Db, tenantId: string): Promise<SessionStudy[]> {
	const rows = await db.query(
		`select chat_id, sum(active_seconds) as s, min(started_at) as first_at, max(last_active_at) as last_at
		 from study_time where tenant_id = $1 and chat_id is not null
		 group by chat_id order by max(last_active_at) desc`,
		[tenantId],
	);
	return rows.map((r) => ({ chatId: String(r.chat_id), activeSeconds: num(r.s), firstActiveAt: toDate(r.first_at), lastActiveAt: toDate(r.last_at) }));
}

export interface TenantStudy {
	tenantId: string;
	activeSeconds: number;
	/** Distinct chats with active time. */
	sessions: number;
}

/** Study time and session count per tenant for stretches that started in [since, until). Only tenants who studied appear. */
export async function studyByTenant(db: Db, range: { since?: Date; until?: Date } = {}): Promise<Map<string, TenantStudy>> {
	const rows = await db.query(
		`select tenant_id, sum(active_seconds) as s, count(distinct chat_id) as chats
		 from study_time where started_at >= $1 and started_at < $2 group by tenant_id`,
		[range.since ?? new Date(0), range.until ?? new Date("9999-12-31T00:00:00Z")],
	);
	return new Map(rows.map((r) => [String(r.tenant_id), { tenantId: String(r.tenant_id), activeSeconds: num(r.s), sessions: num(r.chats) }]));
}

export interface EndedSession {
	tenantId: string;
	chatId: string;
	lastActiveAt: Date;
}

/**
 * Sessions whose chat has had no active time for `idleMinutes`, with their
 * last active time. `unlabeledOnly` keeps those with no non-aviation label
 * made after that time (a chat studied again later is labeled again).
 */
export async function listEndedSessions(
	db: Db,
	options: { now?: Date; idleMinutes?: number; unlabeledOnly?: boolean; limit?: number } = {},
): Promise<EndedSession[]> {
	const now = options.now ?? new Date();
	const cutoff = new Date(now.getTime() - (options.idleMinutes ?? SESSION_END_MINUTES) * 60_000);
	const rows = await db.query(
		`select s.tenant_id, s.chat_id, s.last_at from (
		   select tenant_id, chat_id, max(last_active_at) as last_at from study_time
		   where chat_id is not null group by tenant_id, chat_id
		 ) s
		 left join topic_labels l on l.tenant_id = s.tenant_id and l.chat_id = s.chat_id
		 where s.last_at <= $1 ${options.unlabeledOnly ? "and (l.labeled_at is null or l.labeled_at < s.last_at)" : ""}
		 order by s.last_at limit $2`,
		[cutoff, options.limit ?? 200],
	);
	return rows.map((r) => ({ tenantId: String(r.tenant_id), chatId: String(r.chat_id), lastActiveAt: toDate(r.last_at) }));
}

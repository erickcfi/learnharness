/**
 * Active study time (PD1, X4), measured by the front door: the tab is
 * visible and the student acted in the last 5 minutes. The front door turns
 * that into heartbeats of active seconds; this module stores them as
 * stretches of activity per tenant and chat.
 */

import { date, type Db, must, num, one, type Row, strOrNull } from "./db.ts";

export interface StudyStretch {
	id: number;
	tenantId: string;
	chatId: string | null;
	startedAt: Date;
	lastActiveAt: Date;
	activeSeconds: number;
}

const COLS = "id, tenant_id, chat_id, started_at, last_active_at, active_seconds";

function toStretch(r: Row): StudyStretch {
	return {
		id: num(r.id),
		tenantId: String(r.tenant_id),
		chatId: strOrNull(r.chat_id),
		startedAt: date(r.started_at),
		lastActiveAt: date(r.last_active_at),
		activeSeconds: num(r.active_seconds),
	};
}

/**
 * Add `seconds` of active time ending at `at`. If the tenant's newest stretch
 * in the same chat (or outside any chat) was active within `maxGapSeconds`,
 * it grows; otherwise a new stretch starts. Seconds are rounded to whole
 * seconds.
 */
export async function addActiveStudyTime(
	db: Db,
	s: { tenantId: string; chatId?: string | null; at?: Date; seconds: number; maxGapSeconds: number },
): Promise<StudyStretch> {
	if (!Number.isFinite(s.seconds) || s.seconds < 0) throw new RangeError(`study seconds must be 0 or more, got ${s.seconds}`);
	const seconds = Math.round(s.seconds);
	const at = s.at ?? new Date();
	const chatId = s.chatId ?? null;
	return db.transaction(async (tx) => {
		const open = await one<{ id: unknown }>(
			tx,
			`select id from study_time
			 where tenant_id = $1 and chat_id is not distinct from $2::text and last_active_at >= $3
			 order by last_active_at desc limit 1 for update`,
			[s.tenantId, chatId, new Date(at.getTime() - s.maxGapSeconds * 1000)],
		);
		if (open) {
			return toStretch(
				await must(
					tx,
					`update study_time set last_active_at = greatest(last_active_at, $2), active_seconds = active_seconds + $3 where id = $1 returning ${COLS}`,
					[open.id, at, seconds],
				),
			);
		}
		return toStretch(
			await must(tx, `insert into study_time (tenant_id, chat_id, started_at, last_active_at, active_seconds) values ($1, $2, $3, $4, $5) returning ${COLS}`, [
				s.tenantId,
				chatId,
				new Date(at.getTime() - seconds * 1000),
				at,
				seconds,
			]),
		);
	});
}

/** Active seconds in stretches that started at or after `since` (for the trial's 2 hours). */
export async function studySecondsSince(db: Db, tenantId: string, since: Date): Promise<number> {
	const r = await must(db, "select coalesce(sum(active_seconds), 0) as s from study_time where tenant_id = $1 and started_at >= $2", [tenantId, since]);
	return num(r.s);
}

export interface StudySummary {
	tenantId: string;
	activeSeconds: number;
	stretches: number;
	chats: number;
}

/** Study time per tenant for stretches that started in the range. Only tenants who studied appear. */
export async function studySummary(db: Db, range: { since?: Date; until?: Date } = {}): Promise<StudySummary[]> {
	const rows = await db.query(
		`select tenant_id, sum(active_seconds) as s, count(*) as stretches, count(distinct chat_id) as chats
		 from study_time where started_at >= $1 and started_at < $2 group by tenant_id order by tenant_id`,
		[range.since ?? new Date(0), range.until ?? new Date("9999-12-31T00:00:00Z")],
	);
	return rows.map((r) => ({ tenantId: String(r.tenant_id), activeSeconds: num(r.s), stretches: num(r.stretches), chats: num(r.chats) }));
}

export async function listStudyStretches(db: Db, tenantId: string): Promise<StudyStretch[]> {
	return (await db.query(`select ${COLS} from study_time where tenant_id = $1 order by started_at, id`, [tenantId])).map(toStretch);
}

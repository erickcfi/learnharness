/**
 * Course Leg starts (master, 2026-11-11): when a student starts a Leg on
 * /course, which chat it opened. The page shows "Started" on that Leg and a
 * "Continue" link to the newest chat that still exists. "Done" is not
 * tracked yet.
 *
 * Table course_leg_starts (migration 20261111000100). The front door must
 * work before that migration is applied: frontdoor/course/marks.ts catches
 * the missing table.
 */
import { date, type Db } from "./db.ts";

export interface LegStart {
	tenantId: string;
	legId: string;
	chatId: string;
	startedAt: Date;
}

/** Records one start. A chat is started for one Leg only, so the same chat twice is ignored. */
export async function recordLegStart(db: Db, input: { tenantId: string; legId: string; chatId: string; at?: Date }): Promise<void> {
	await db.query(
		`insert into course_leg_starts (tenant_id, leg_id, chat_id, started_at) values ($1, $2, $3, coalesce($4, now()))
		 on conflict (tenant_id, chat_id) do nothing`,
		[input.tenantId, input.legId, input.chatId, input.at ?? null],
	);
}

/** One tenant's starts, newest first. */
export async function listLegStarts(db: Db, tenantId: string): Promise<LegStart[]> {
	const rows = await db.query(`select tenant_id, leg_id, chat_id, started_at from course_leg_starts where tenant_id = $1 order by started_at desc, chat_id`, [tenantId]);
	return rows.map((r) => ({ tenantId: String(r.tenant_id), legId: String(r.leg_id), chatId: String(r.chat_id), startedAt: date(r.started_at) }));
}

/**
 * Course lesson starts (docs/decisions/2026-11-17-course-outline.md): when a
 * student starts a lesson on /course, which chat it opened. The page shows
 * "Started" on that lesson and a "Continue" link to the newest chat that
 * still exists. "Done" is not tracked yet.
 *
 * Table course_leg_starts (migration 20261111000100, already applied). The
 * table and its leg_id column keep the names they were made with: leg_id
 * now holds the course file's lesson id (l05). Starts stored under an
 * earlier course design's ids simply match no lesson. The front door must
 * still work without the table: frontdoor/course/marks.ts catches it.
 */
import { date, type Db } from "./db.ts";

export interface LessonStart {
	tenantId: string;
	lessonId: string;
	chatId: string;
	startedAt: Date;
}

/** Records one start. A chat is started for one lesson only, so the same chat twice is ignored. */
export async function recordLessonStart(db: Db, input: { tenantId: string; lessonId: string; chatId: string; at?: Date }): Promise<void> {
	await db.query(
		`insert into course_leg_starts (tenant_id, leg_id, chat_id, started_at) values ($1, $2, $3, coalesce($4, now()))
		 on conflict (tenant_id, chat_id) do nothing`,
		[input.tenantId, input.lessonId, input.chatId, input.at ?? null],
	);
}

/** One tenant's starts, newest first. */
export async function listLessonStarts(db: Db, tenantId: string): Promise<LessonStart[]> {
	const rows = await db.query(`select tenant_id, leg_id, chat_id, started_at from course_leg_starts where tenant_id = $1 order by started_at desc, chat_id`, [tenantId]);
	return rows.map((r) => ({ tenantId: String(r.tenant_id), lessonId: String(r.leg_id), chatId: String(r.chat_id), startedAt: date(r.started_at) }));
}

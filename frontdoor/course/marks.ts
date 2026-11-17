/**
 * The "Started" marks on /course, over frontdoor/db/course.ts. Each start
 * is stored with the lesson's id from the course file (in the table's
 * leg_id column, see db/course.ts). The page must work without the table
 * course_leg_starts: then no marks are shown, nothing is stored, and one
 * line is logged (once per process). Any other database trouble is logged
 * too and never stops the page or a lesson start.
 */
import { type Db, listLessonStarts, recordLessonStart } from "../db/index.ts";

export interface StartMark {
	chatId: string;
	startedAt: Date;
}

export interface LessonStartMarks {
	record(input: { tenantId: string; lessonId: string; chatId: string; at?: Date }): Promise<void>;
	/** Every start per lesson id, newest first. Empty with no database or no table. */
	startsByLesson(tenantId: string): Promise<Map<string, StartMark[]>>;
}

/** Postgres's "undefined_table". */
const UNDEFINED_TABLE = "42P01";

const codeOf = (error: unknown): string => {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "unknown";
};

export const MISSING_TABLE_LINE = "course: the course_leg_starts table is missing, so Started marks are off until its migration is applied";

export function lessonStartMarks(db: Db | null, log?: (line: string) => void): LessonStartMarks {
	let warned = false;
	const trouble = (what: string, error: unknown) => {
		const code = codeOf(error);
		if (code === UNDEFINED_TABLE) {
			if (!warned) log?.(MISSING_TABLE_LINE);
			warned = true;
			return;
		}
		// The error code only: a database message can hold the values it was given.
		log?.(`course: could not ${what} (error code ${code})`);
	};
	return {
		async record(input) {
			if (!db) return;
			try {
				await recordLessonStart(db, input);
			} catch (error) {
				trouble("record a lesson start", error);
			}
		},
		async startsByLesson(tenantId) {
			const out = new Map<string, StartMark[]>();
			if (!db) return out;
			try {
				// listLessonStarts is newest first, so each lesson's list is too.
				for (const row of await listLessonStarts(db, tenantId)) {
					const starts = out.get(row.lessonId) ?? [];
					starts.push({ chatId: row.chatId, startedAt: row.startedAt });
					out.set(row.lessonId, starts);
				}
			} catch (error) {
				trouble("read lesson starts", error);
				out.clear();
			}
			return out;
		},
	};
}

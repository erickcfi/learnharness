/**
 * The "Started" marks on /course (master, 2026-11-11), over
 * frontdoor/db/course.ts. The page must work before the migration that
 * makes course_leg_starts is applied: then no marks are shown, nothing is
 * stored, and one line is logged (once per process). Any other database
 * trouble is logged too and never stops the page or a lesson start.
 */
import { type Db, listLegStarts, recordLegStart } from "../db/index.ts";

export interface LatestStart {
	chatId: string;
	startedAt: Date;
}

export interface LegStartMarks {
	record(input: { tenantId: string; legId: string; chatId: string; at?: Date }): Promise<void>;
	/** The newest start per Leg id. Empty with no database or no table. */
	latestByLeg(tenantId: string): Promise<Map<string, LatestStart>>;
}

/** Postgres's "undefined_table". */
const UNDEFINED_TABLE = "42P01";

const codeOf = (error: unknown): string => {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "unknown";
};

export const MISSING_TABLE_LINE = "course: the course_leg_starts table is missing, so Started marks are off until its migration is applied";

export function legStartMarks(db: Db | null, log?: (line: string) => void): LegStartMarks {
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
				await recordLegStart(db, input);
			} catch (error) {
				trouble("record a Leg start", error);
			}
		},
		async latestByLeg(tenantId) {
			const out = new Map<string, LatestStart>();
			if (!db) return out;
			try {
				for (const row of await listLegStarts(db, tenantId)) {
					if (!out.has(row.legId)) out.set(row.legId, { chatId: row.chatId, startedAt: row.startedAt });
				}
			} catch (error) {
				trouble("read Leg starts", error);
				out.clear();
			}
			return out;
		},
	};
}

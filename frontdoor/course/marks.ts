/**
 * The "Started" marks on /course (master, 2026-11-11), over
 * frontdoor/db/course.ts. The page must work before the migration that
 * makes course_leg_starts is applied: then no marks are shown, nothing is
 * stored, and one line is logged (once per process). Any other database
 * trouble is logged too and never stops the page or a lesson start.
 */
import { type Db, listLegStarts, recordLegStart } from "../db/index.ts";

export interface StartMark {
	chatId: string;
	startedAt: Date;
}

export interface LegStartMarks {
	record(input: { tenantId: string; legId: string; chatId: string; at?: Date }): Promise<void>;
	/** Every start per Leg id, newest first. Empty with no database or no table. */
	startsByLeg(tenantId: string): Promise<Map<string, StartMark[]>>;
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
		async startsByLeg(tenantId) {
			const out = new Map<string, StartMark[]>();
			if (!db) return out;
			try {
				// listLegStarts is newest first, so each Leg's list is too.
				for (const row of await listLegStarts(db, tenantId)) {
					const starts = out.get(row.legId) ?? [];
					starts.push({ chatId: row.chatId, startedAt: row.startedAt });
					out.set(row.legId, starts);
				}
			} catch (error) {
				trouble("read Leg starts", error);
				out.clear();
			}
			return out;
		},
	};
}

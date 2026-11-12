/**
 * When a student cannot start a lesson now: paused (C3 req 6), or, with
 * billing on, the trial used up, the plan ended, or no plan. /course then
 * shows a plain sentence instead of "Start lesson", and /course/start opens
 * no chat (the trial gate would refuse its first turn anyway).
 *
 * Cards fallback (Erick, 2026-11-11): pre-written question cards are a
 * fallback only, for when the model cannot be reached or the student has hit
 * a budget cap. They are not built in this version. When they are, these
 * are the cases that would offer them (see course-screen.tsx and
 * endpoint.ts for the two places).
 *
 * If the database cannot answer, the lesson may start: the meter refuses
 * model calls it cannot account for (as the billing gate does).
 */
import { accessFor } from "../billing/access.ts";
import { type Db, isPaused } from "../db/index.ts";

export type StartBlock = "paused" | "trial-used" | "plan-ended" | "no-plan";
export type StartBlockCheck = (tenantId: string) => Promise<StartBlock | null>;

export const noStartBlock: StartBlockCheck = async () => null;

export function databaseStartBlock(db: Db, options: { billing: boolean; now?: () => number; log?: (line: string) => void }): StartBlockCheck {
	return async (tenantId) => {
		try {
			if (await isPaused(db, tenantId)) return "paused";
			if (!options.billing) return null;
			const access = await accessFor(db, tenantId, new Date(options.now ? options.now() : Date.now()));
			if (access.state === "trial-used") return "trial-used";
			if (access.state === "ended") return "plan-ended";
			if (access.state === "no-plan") return "no-plan";
			return null;
		} catch (error) {
			options.log?.(`course: could not check whether tenant ${tenantId} may start a lesson (${(error as { code?: string }).code ?? "error"})`);
			return null;
		}
	};
}

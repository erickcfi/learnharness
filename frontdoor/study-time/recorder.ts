/**
 * Writes credited heartbeats into study_time, per student and per upstream
 * chat (PD1; master decision 2026-11-08: chat_id is the upstream chat id, so
 * the study record can show length per session).
 *
 * A write that fails (database down) is kept in memory and added to the next
 * write for the same student and chat, so a short outage loses nothing. At
 * most MAX_PENDING_SECONDS wait per student and chat.
 */
import { addActiveStudyTime, type Db } from "../db/index.ts";
import { createActivityCredit, STRETCH_GAP_SECONDS, type ActivityCredit } from "./credit.ts";

const MAX_PENDING_SECONDS = 6 * 3600;

export interface StudyTimeRecorder {
	/** One heartbeat from a student's page. Resolves to the seconds stored now (0 if none). */
	beat(tenantId: string, chatId: string | null): Promise<number>;
	/** Seconds still waiting to be written, for tests and shutdown logs. */
	pendingSeconds(): number;
}

export interface StudyTimeRecorderOptions {
	db: Db;
	credit?: ActivityCredit;
	now?: () => number;
	/** Operational lines. Never given session text or email addresses. */
	log?: (line: string) => void;
}

export function createStudyTimeRecorder(options: StudyTimeRecorderOptions): StudyTimeRecorder {
	const credit = options.credit ?? createActivityCredit();
	const now = options.now ?? Date.now;
	const pending = new Map<string, { tenantId: string; chatId: string | null; seconds: number }>();
	return {
		async beat(tenantId, chatId) {
			const at = now();
			const earned = credit.credit(tenantId, at);
			const key = `${tenantId}\u0000${chatId ?? ""}`;
			const waiting = pending.get(key)?.seconds ?? 0;
			const seconds = Math.min(MAX_PENDING_SECONDS, earned + waiting);
			if (seconds <= 0) return 0;
			try {
				await addActiveStudyTime(options.db, { tenantId, chatId, at: new Date(at), seconds, maxGapSeconds: STRETCH_GAP_SECONDS });
				pending.delete(key);
				return seconds;
			} catch (error) {
				// A data error (for example a tenant deleted on day 91) never succeeds on retry.
				const code = String((error as { code?: unknown }).code ?? "");
				if (code.startsWith("23")) {
					pending.delete(key);
					options.log?.(`study time for tenant ${tenantId} refused by the database (code ${code}), not kept`);
					return 0;
				}
				pending.set(key, { tenantId, chatId, seconds });
				options.log?.(`study time for tenant ${tenantId} not saved yet (${seconds}s waiting): ${(error as Error).message}`);
				return 0;
			}
		},
		pendingSeconds() {
			let total = 0;
			for (const p of pending.values()) total += p.seconds;
			return total;
		},
	};
}

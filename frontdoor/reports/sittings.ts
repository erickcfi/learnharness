/**
 * When does a study session end? (C6 req 3, PD1)
 *
 * The front door logs active study time in `study_time` (P3-02): a browser
 * heartbeat every 30 seconds while the tab is visible and the student acted
 * in the last 5 minutes, written per chat id. A sitting is a run of a
 * tenant's study, in any chat, with no gap over SESSION_IDLE_MINUTES. It
 * has ended once the student has been idle that long. One session report
 * goes out per ended sitting, listing every tutor session (chat) it touched.
 *
 * One 30-minute rule for the whole front door (master, 2026-11-08):
 * w2-dashboard's frontdoor/study-time/ exports the ended sittings. The
 * report loop reads them through EndedSittingsSource; the master wires
 * study-time's export at merge. Until then, studyTimeSittings() in
 * study-time-stand-in.ts reads study_time with groupSittings() below.
 *
 * This file is pure: no clock, no I/O.
 */

/** No study activity for this long ends a sitting. */
export const SESSION_IDLE_MINUTES = 30;
/** Sittings shorter than this get no report (a quick look is not a session). */
export const MIN_REPORT_SECONDS = 5 * 60;
/** Only sittings that ended this recently get a report, so a restart sends nothing old. */
export const SESSION_LOOKBACK_HOURS = 12;

/** One ended study sitting: the shape frontdoor/study-time exports. */
export interface EndedSitting {
	tenantId: string;
	/** The sitting's first moment: its key in report_sends. */
	sittingStartedAt: Date;
	/** The last activity. */
	endedAt: Date;
	/** Each tutor session (chat) used, with its active seconds, in first-use order. */
	chats: Array<{ chatId: string; activeSeconds: number }>;
}

/** The tenant's sittings that ended (30 idle minutes) at or after `endedSince`. */
export type EndedSittingsSource = (query: { tenantId: string; endedSince: Date; now: Date }) => Promise<EndedSitting[]>;

/** Active seconds in the sitting's tutor sessions. */
export const sittingSeconds = (s: Pick<EndedSitting, "chats">) => s.chats.reduce((sum, c) => sum + c.activeSeconds, 0);

/** The chat with the most time in the sitting (report_sends.chat_id). */
export function mainChat(sitting: Pick<EndedSitting, "chats">): string | null {
	let best: { chatId: string; activeSeconds: number } | null = null;
	for (const c of sitting.chats) if (!best || c.activeSeconds > best.activeSeconds) best = c;
	return best?.chatId ?? null;
}

export interface ReportableOptions {
	lookbackHours?: number;
	minSeconds?: number;
}

/** The report rules on top of "ended": ended within the lookback, at least the minimum, with a tutor session. */
export function reportableSittings(sittings: readonly EndedSitting[], now: Date, options: ReportableOptions = {}): EndedSitting[] {
	const lookbackMs = (options.lookbackHours ?? SESSION_LOOKBACK_HOURS) * 3600_000;
	const minSeconds = options.minSeconds ?? MIN_REPORT_SECONDS;
	return sittings.filter((s) => now.getTime() - s.endedAt.getTime() <= lookbackMs && s.chats.length > 0 && sittingSeconds(s) >= minSeconds);
}

/** Where the report loop starts looking: ended sittings since then can still get a report. */
export const reportWindowStart = (now: Date, lookbackHours = SESSION_LOOKBACK_HOURS) => new Date(now.getTime() - lookbackHours * 3600_000);

// ---- the stand-in's grouping (study_time stretches -> sittings) ----

export interface Stretch {
	chatId: string | null;
	startedAt: Date;
	lastActiveAt: Date;
	activeSeconds: number;
}

export interface Sitting {
	startedAt: Date;
	endedAt: Date;
	/** All active seconds, including time outside a chat. */
	activeSeconds: number;
	/** Active seconds per chat, in first-use order. Time outside a chat is left out. */
	chats: Array<{ chatId: string; activeSeconds: number }>;
}

/** Groups stretches into sittings, oldest first. */
export function groupSittings(stretches: readonly Stretch[], idleMinutes = SESSION_IDLE_MINUTES): Sitting[] {
	const idleMs = idleMinutes * 60_000;
	const sorted = [...stretches].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.lastActiveAt.getTime() - b.lastActiveAt.getTime());
	const sittings: Sitting[] = [];
	let current: { startedAt: Date; endedAt: Date; activeSeconds: number; chats: Map<string, number> } | null = null;
	const close = () => {
		if (current) {
			sittings.push({
				startedAt: current.startedAt,
				endedAt: current.endedAt,
				activeSeconds: current.activeSeconds,
				chats: [...current.chats].map(([chatId, activeSeconds]) => ({ chatId, activeSeconds })),
			});
		}
	};
	for (const s of sorted) {
		if (!current || s.startedAt.getTime() - current.endedAt.getTime() > idleMs) {
			close();
			current = { startedAt: s.startedAt, endedAt: s.lastActiveAt, activeSeconds: 0, chats: new Map() };
		}
		if (s.lastActiveAt > current.endedAt) current.endedAt = s.lastActiveAt;
		current.activeSeconds += s.activeSeconds;
		if (s.chatId !== null) current.chats.set(s.chatId, (current.chats.get(s.chatId) ?? 0) + s.activeSeconds);
	}
	close();
	return sittings;
}

/** Grouped sittings that have ended: idle for at least `idleMinutes` at `now`. */
export function endedOnly(sittings: readonly Sitting[], now: Date, idleMinutes = SESSION_IDLE_MINUTES): Sitting[] {
	return sittings.filter((s) => now.getTime() - s.endedAt.getTime() >= idleMinutes * 60_000);
}

/**
 * How far back the stand-in reads stretches so a sitting that ended after
 * `endedSince` is read whole (its start is its key): a day before it.
 */
export const stretchWindowStart = (endedSince: Date) => new Date(endedSince.getTime() - 24 * 3600_000);

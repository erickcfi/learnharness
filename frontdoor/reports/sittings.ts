/**
 * When does a study session end? (C6 req 3, PD1)
 *
 * The front door logs active study time in `study_time` (P3-02): stretches
 * of activity per tenant and chat. A sitting is a run of a tenant's
 * stretches, in any chat, with no gap longer than SESSION_IDLE_MINUTES. It
 * has ended once the student has been idle that long. One session report
 * goes out per ended sitting, listing every tutor session (chat) it touched.
 *
 * Pure: no clock, no I/O.
 */

/** No study activity for this long ends a sitting. */
export const SESSION_IDLE_MINUTES = 30;
/** Sittings shorter than this get no report (a quick look is not a session). */
export const MIN_REPORT_SECONDS = 5 * 60;
/** Only sittings that ended this recently get a report, so a restart sends nothing old. */
export const SESSION_LOOKBACK_HOURS = 12;

export interface Stretch {
	chatId: string | null;
	startedAt: Date;
	lastActiveAt: Date;
	activeSeconds: number;
}

export interface Sitting {
	/** The first stretch's start: the sitting's key in report_sends. */
	startedAt: Date;
	/** The last activity. */
	endedAt: Date;
	activeSeconds: number;
	/** Active seconds per chat, in the order the chats were first used. Time outside a chat is left out. */
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

export interface EndedSittingOptions {
	idleMinutes?: number;
	lookbackHours?: number;
	minSeconds?: number;
}

/**
 * Sittings that have ended (idle long enough), ended within the lookback,
 * lasted at least the minimum, and touched at least one tutor session.
 */
export function endedSittings(stretches: readonly Stretch[], now: Date, options: EndedSittingOptions = {}): Sitting[] {
	const idleMinutes = options.idleMinutes ?? SESSION_IDLE_MINUTES;
	const lookbackMs = (options.lookbackHours ?? SESSION_LOOKBACK_HOURS) * 3600_000;
	const minSeconds = options.minSeconds ?? MIN_REPORT_SECONDS;
	return groupSittings(stretches, idleMinutes).filter((s) => {
		const idleFor = now.getTime() - s.endedAt.getTime();
		return idleFor >= idleMinutes * 60_000 && idleFor <= lookbackMs && s.activeSeconds >= minSeconds && s.chats.length > 0;
	});
}

/** The chat with the most time in the sitting (report_sends.chat_id). */
export function mainChat(sitting: Sitting): string | null {
	let best: { chatId: string; activeSeconds: number } | null = null;
	for (const c of sitting.chats) if (!best || c.activeSeconds > best.activeSeconds) best = c;
	return best?.chatId ?? null;
}

/**
 * How far back to read stretches so that every sitting that could still
 * get a report is read whole (its start is its key): the lookback, plus a
 * day for the sitting itself.
 */
export function stretchWindowStart(now: Date, lookbackHours = SESSION_LOOKBACK_HOURS): Date {
	return new Date(now.getTime() - (lookbackHours + 24) * 3600_000);
}

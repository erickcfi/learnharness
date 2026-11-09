/**
 * Active study time (PD1): "the tab is visible, and the student acted in the
 * last 5 minutes". Only the student's browser can see that, so a small
 * script on the tutor's pages (script.ts) sends a heartbeat every
 * HEARTBEAT_SECONDS while both are true. This file turns heartbeats into
 * seconds of study time.
 *
 * Each heartbeat earns the time since the student's last credited heartbeat,
 * capped at one interval. So:
 *  - two open tabs never count twice (they share one clock per student);
 *  - a script that beats faster than it should still earns only real time;
 *  - the first beat after a pause earns one interval (the script only beats
 *    when the student acted in the last 5 minutes and the tab is in view).
 */

/** How often the page script beats while the student is active. */
export const HEARTBEAT_SECONDS = 30;
/** PD1: the student acted in the last 5 minutes. */
export const ACTIVE_WINDOW_SECONDS = 5 * 60;
/** A stretch in study_time ends after this long with no active time. */
export const STRETCH_GAP_SECONDS = ACTIVE_WINDOW_SECONDS + HEARTBEAT_SECONDS;

export interface ActivityCredit {
	/** Seconds this heartbeat earns for the student (0 when it earns nothing). */
	credit(tenantId: string, atMs: number): number;
}

export function createActivityCredit(options: { intervalSeconds?: number; maxTenants?: number } = {}): ActivityCredit {
	const interval = options.intervalSeconds ?? HEARTBEAT_SECONDS;
	const maxTenants = options.maxTenants ?? 10_000;
	const last = new Map<string, number>();
	return {
		credit(tenantId, atMs) {
			const previous = last.get(tenantId);
			let seconds: number;
			if (previous === undefined || atMs - previous > 2 * interval * 1000) seconds = interval;
			else seconds = Math.min(interval, Math.max(0, (atMs - previous) / 1000));
			seconds = Math.floor(seconds);
			if (seconds <= 0) return 0;
			last.delete(tenantId);
			last.set(tenantId, atMs);
			// Keep memory bounded: the oldest entries go first (a Map keeps insertion order).
			while (last.size > maxTenants) last.delete(last.keys().next().value as string);
			return seconds;
		},
	};
}

/**
 * The dashboard's money period and its dates, in the school's time zone
 * (North Aero is at KSNS, Salinas, California).
 */

export const DASHBOARD_TIME_ZONE = "America/Los_Angeles";

export const PERIODS = ["30d", "month", "all"] as const;
export type PeriodKey = (typeof PERIODS)[number];

export const PERIOD_LABELS: Record<PeriodKey, string> = {
	"30d": "Last 30 days",
	month: "This month",
	all: "All time",
};

export function parsePeriod(value: unknown): PeriodKey {
	return typeof value === "string" && (PERIODS as readonly string[]).includes(value) ? (value as PeriodKey) : "30d";
}

const DAY_MS = 24 * 3600 * 1000;

/** The zone's offset from UTC at `at`, in ms (positive east of Greenwich). */
function zoneOffsetMs(at: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(at));
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant of local midnight on the first of the month that `at` falls in, in the zone. */
export function startOfMonthIn(at: Date, timeZone: string): Date {
	const local = new Date(at.getTime() + zoneOffsetMs(at.getTime(), timeZone));
	const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
	// Two passes settle the offset across a daylight-saving change.
	let instant = guess - zoneOffsetMs(guess, timeZone);
	instant = guess - zoneOffsetMs(instant, timeZone);
	return new Date(instant);
}

/** [since, until) for a period ending now. */
export function periodRange(key: PeriodKey, now: Date, timeZone = DASHBOARD_TIME_ZONE): { since: Date; until: Date } {
	const until = new Date(now.getTime() + 1);
	if (key === "all") return { since: new Date(0), until };
	if (key === "month") return { since: startOfMonthIn(now, timeZone), until };
	return { since: new Date(now.getTime() - 30 * DAY_MS), until };
}

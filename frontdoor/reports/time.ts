/**
 * Dates and weeks for the reports (C6 req 3, D26).
 *
 * Every date in a report, and the weekly report's week, use the school's
 * time zone: North Aero is at the Salinas Airport (KSNS), California
 * (marketing/copy.ts). The record builder needs a zone and never guesses
 * one, so it is fixed here.
 *
 * A report week runs Monday 00:00 to the next Monday 00:00, school time.
 * The weekly report for a week is due the Monday after it, at 08:00
 * school time, and may still go out for WEEKLY_SEND_WINDOW_HOURS after that.
 */

export const REPORT_TIME_ZONE = "America/Los_Angeles";
export const WEEKLY_SEND_HOUR = 8;
export const WEEKLY_SEND_WINDOW_HOURS = 48;

const DAY_MS = 24 * 3600 * 1000;

interface ZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	/** 1 = Monday ... 7 = Sunday */
	isoWeekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
	let f = formatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			weekday: "short",
		});
		formatters.set(timeZone, f);
	}
	return f;
}

export function zonedParts(at: Date, timeZone: string): ZonedParts {
	const out: Record<string, string> = {};
	for (const p of partsFormatter(timeZone).formatToParts(at)) out[p.type] = p.value;
	return {
		year: Number(out.year),
		month: Number(out.month),
		day: Number(out.day),
		hour: Number(out.hour),
		minute: Number(out.minute),
		second: Number(out.second),
		isoWeekday: WEEKDAYS[out.weekday ?? ""] ?? 0,
	};
}

/** The zone's offset from UTC at that moment, in ms (local = UTC + offset). */
function offsetMs(at: Date, timeZone: string): number {
	const p = zonedParts(at, timeZone);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The moment a wall-clock time happens in the zone (the earlier one in a DST overlap). */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
	const guess = Date.UTC(year, month - 1, day, hour, minute);
	let t = guess - offsetMs(new Date(guess), timeZone);
	t = guess - offsetMs(new Date(t), timeZone);
	return new Date(t);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD in the zone. */
export function localDate(at: Date, timeZone: string): string {
	const p = zonedParts(at, timeZone);
	return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function addDays(ymd: string, days: number): string {
	const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
	const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
	return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function startOf(ymd: string, timeZone: string, hour = 0): Date {
	const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
	return zonedTime(y, m, d, hour, 0, timeZone);
}

export interface ReportWeek {
	/** Monday, YYYY-MM-DD (report_sends.week_start). */
	weekStart: string;
	/** Sunday, YYYY-MM-DD. */
	weekEnd: string;
	/** Monday 00:00 school time. */
	startsAt: Date;
	/** The next Monday 00:00 school time (not included). */
	endsAt: Date;
	/** The next Monday at 08:00 school time. */
	dueAt: Date;
}

/** The report week (Monday to Sunday) that contains `at`. */
export function weekContaining(at: Date, timeZone: string): ReportWeek {
	const p = zonedParts(at, timeZone);
	const weekStart = addDays(`${p.year}-${pad(p.month)}-${pad(p.day)}`, 1 - p.isoWeekday);
	const next = addDays(weekStart, 7);
	return {
		weekStart,
		weekEnd: addDays(weekStart, 6),
		startsAt: startOf(weekStart, timeZone),
		endsAt: startOf(next, timeZone),
		dueAt: startOf(next, timeZone, WEEKLY_SEND_HOUR),
	};
}

/**
 * The week whose weekly report may go out now: the week before this one,
 * from its due time (Monday 08:00) for WEEKLY_SEND_WINDOW_HOURS. Null
 * outside that window.
 */
export function weekDueNow(now: Date, timeZone: string, windowHours = WEEKLY_SEND_WINDOW_HOURS): ReportWeek | null {
	const thisWeek = weekContaining(now, timeZone);
	const lastWeek = weekContaining(new Date(thisWeek.startsAt.getTime() - 1), timeZone);
	const since = now.getTime() - lastWeek.dueAt.getTime();
	return since >= 0 && since < windowHours * 3600 * 1000 ? lastWeek : null;
}

/** "Nov 8, 2026" in the zone. */
export function displayDate(at: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "short", day: "numeric" }).format(at);
}

/** "Nov 8" in the zone. */
export function displayShortDate(at: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(at);
}

/** Plain formatting for the dashboard. */
import type { Conversion } from "../../../admin/overview.ts";
import type { DashboardStatus, Plan } from "../../../db/index.ts";

export function usd(value: number): string {
	if (value > 0 && value < 0.01) return "<$0.01";
	return value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function duration(seconds: number): string {
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function hours(seconds: number): string {
	return `${(seconds / 3600).toFixed(1)} h`;
}

export function day(value: Date | string | null, timeZone: string): string {
	if (!value) return "–";
	return new Date(value).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
}

export function dayTime(value: Date | string | null, timeZone: string): string {
	if (!value) return "–";
	return new Date(value).toLocaleString("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function bytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const STATUS_LABELS: Record<DashboardStatus, string> = {
	trial: "Trial",
	active: "Active",
	paused: "Paused",
	canceled: "Canceled",
	retention: "Retention",
	none: "No plan yet",
};

export const PLAN_LABELS: Record<Plan, string> = { monthly: "Monthly", three_month: "3-month", annual: "Annual" };

export const CONVERSION_LABELS: Record<Conversion, string> = {
	converted: "Paid after trial",
	"in-trial": "In trial",
	"not-converted": "Did not pay",
	"no-trial": "–",
};

export const ALERT_LABELS = { cost_alert: "Cost alert", autopause: "Autopause" } as const;

export const DONE_MESSAGES: Record<string, string> = {
	paused: "Paused. The tutor stops taking new turns for this student.",
	unpaused: "Unpaused. The student can study again.",
	"alert-cleared": "Alert cleared.",
	"thresholds-saved": "Thresholds saved.",
	"consent-recorded": "Tester's written OK recorded.",
	"consent-revoked": "Tester's written OK revoked.",
	"file-removed": "File removed from the library.",
	uploaded: "File added to the library.",
};

export const BILLING_PENDING = "After billing is connected";

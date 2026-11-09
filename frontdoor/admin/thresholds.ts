/**
 * The Owner's alert and autopause thresholds (C3 req 5, C7 req 5, from
 * P3-06). Stored in owner_settings; W2-7's alert and autopause read them
 * from there (getOwnerSettings).
 */
import { type Db, getOwnerSettings, type OwnerSettings, updateOwnerSettings } from "../db/index.ts";

export const MAX_THRESHOLD_USD = 10_000;

export type ThresholdInput = { alertUsd: number; autopauseUsd: number };

function money(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string") return null;
	const text = value.trim().replace(/^\$/, "");
	if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) return null;
	return Number(text);
}

/** Check the form's two values. Errors are plain words for the page. */
export function parseThresholds(input: { alertUsd?: unknown; autopauseUsd?: unknown }): { ok: true; value: ThresholdInput } | { ok: false; error: string } {
	const alertUsd = money(input.alertUsd);
	const autopauseUsd = money(input.autopauseUsd);
	if (alertUsd === null || autopauseUsd === null) return { ok: false, error: "Enter dollar amounts, for example 60 or 89.50." };
	if (alertUsd <= 0) return { ok: false, error: "The alert must be more than $0." };
	if (autopauseUsd > MAX_THRESHOLD_USD) return { ok: false, error: `Autopause can be at most $${MAX_THRESHOLD_USD.toLocaleString("en-US")}.` };
	if (alertUsd >= autopauseUsd) return { ok: false, error: "The alert must be lower than autopause." };
	return { ok: true, value: { alertUsd: Math.round(alertUsd * 100) / 100, autopauseUsd: Math.round(autopauseUsd * 100) / 100 } };
}

export async function readThresholds(db: Db): Promise<OwnerSettings> {
	return getOwnerSettings(db);
}

export async function saveThresholds(db: Db, value: ThresholdInput, by: string): Promise<OwnerSettings> {
	return updateOwnerSettings(db, { alertUsd: value.alertUsd, autopauseUsd: value.autopauseUsd, updatedBy: by });
}

/**
 * The cost count, the alert and autopause (P2-05; C3 req 5, D15).
 *
 * After each metered model call the meter asks the watch to check the
 * tenant (meter.ts). The check reads the Owner's thresholds from
 * owner_settings (w2-dashboard edits them) and the tenant's model cost:
 *  - at or above the alert threshold: one open cost alert;
 *  - at or above the autopause threshold: the tenant is paused (a pauses
 *    row, reason autopause) with an autopause alert. The meter refuses a
 *    paused tenant's calls on its next pause check.
 * Alerts live in the alerts table only, for w2-dashboard to show (PRD D15:
 * alerts show on the dashboard only; there is no alert email). Each newly
 * opened alert is also passed to onAlert once; data-safety.ts uses that to
 * show an autopause on the screens at once.
 *
 * The count (the unpause hold, master decision 2026-11-08): model cost in
 * the last 30 days, but never from before the tenant's latest unpause. So
 * an unpause starts a fresh count, and the student's next call does not
 * pause them again at once. 30 days after the unpause the normal rolling
 * window is back. Unpriced calls (no list price) add nothing.
 *
 * Logs carry tenant ids, amounts and error codes only.
 */
import {
	type AlertKind,
	type Db,
	getOwnerSettings,
	modelCostSince,
	openAlert,
	pauseTenant as dbPauseTenant,
	rollingModelCost,
} from "../db/index.ts";
import { one } from "../db/db.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The rolling window for both thresholds (D15). */
export const WINDOW_DAYS = 30;

export interface CostTowardLimits {
	/** North Aero's model cost in the last 30 days, whatever happened. What the dashboard shows.
	 *  Calls on the student's own key are left out here and in countedUsd (2026-11-13). */
	rollingUsd: number;
	/** The cost the thresholds compare: since countedSince. */
	countedUsd: number;
	/** The later of "30 days ago" and the latest unpause. */
	countedSince: Date;
	lastUnpausedAt: Date | null;
}

/** The latest time this tenant was unpaused, or null. */
export async function lastUnpause(db: Db, tenantId: string): Promise<Date | null> {
	const row = await one(db, "select max(unpaused_at) as at from pauses where tenant_id = $1", [tenantId]);
	const at = row?.at;
	if (at === null || at === undefined) return null;
	return at instanceof Date ? at : new Date(String(at));
}

export async function costTowardLimits(db: Db, tenantId: string, now: Date = new Date()): Promise<CostTowardLimits> {
	const windowStart = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
	const lastUnpausedAt = await lastUnpause(db, tenantId);
	const countedSince = lastUnpausedAt && lastUnpausedAt > windowStart ? lastUnpausedAt : windowStart;
	// Only North Aero's cost: calls on the student's own key are the student's to pay (2026-11-13).
	const rollingUsd = await rollingModelCost(db, tenantId, now, WINDOW_DAYS, "north-aero");
	const countedUsd = countedSince === windowStart ? rollingUsd : await modelCostSince(db, tenantId, countedSince, now, "north-aero");
	return { rollingUsd, countedUsd, countedSince, lastUnpausedAt };
}

/** One newly opened alert. No email address and no session text. */
export interface AlertEvent {
	alertId: number;
	tenantId: string;
	kind: AlertKind;
	thresholdUsd: number;
	/** The counted cost when it fired. */
	windowCostUsd: number;
	countedSince: Date;
	createdAt: Date;
}

export type AlertListener = (event: AlertEvent) => void | Promise<void>;

export interface CheckResult {
	countedUsd: number;
	/** A cost alert or an autopause alert was opened by this check. */
	alertOpened: boolean;
	/** This check paused the tenant. */
	paused: boolean;
}

export interface CostWatchOptions {
	db: Db;
	now?: () => Date;
	/** Called once for each alert this watch opens. Errors are logged, never thrown. */
	onAlert?: AlertListener;
	log?: (line: string) => void;
}

export interface CostWatch {
	/** Checks one tenant now. Throws when the database cannot be read. */
	check(tenantId: string): Promise<CheckResult>;
	/** Runs a check in the background after a metered call. Never throws; failures are logged. */
	afterCall(tenantId: string): void;
	/** Resolves when no background check is running (tests, shutdown). */
	idle(): Promise<void>;
}

function errorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : ((error as Error | null)?.name ?? "Error");
}

export function createCostWatch(options: CostWatchOptions): CostWatch {
	const { db } = options;
	const now = options.now ?? (() => new Date());
	const log = options.log ?? ((line: string) => console.error(line));

	async function report(event: AlertEvent): Promise<void> {
		log(`alert: ${event.kind} for tenant ${event.tenantId} at $${event.windowCostUsd.toFixed(2)} (threshold $${event.thresholdUsd.toFixed(2)})`);
		if (!options.onAlert) return;
		try {
			await options.onAlert(event);
		} catch (error) {
			log(`alert: the alert listener failed for tenant ${event.tenantId} (${errorCode(error)})`);
		}
	}

	async function check(tenantId: string): Promise<CheckResult> {
		const at = now();
		const settings = await getOwnerSettings(db);
		const cost = await costTowardLimits(db, tenantId, at);
		const result: CheckResult = { countedUsd: cost.countedUsd, alertOpened: false, paused: false };
		const opened: AlertEvent[] = [];
		const event = (alert: { id: number; kind: AlertKind; thresholdUsd: number; windowCostUsd: number; createdAt: Date }): AlertEvent => ({
			alertId: alert.id,
			tenantId,
			kind: alert.kind,
			thresholdUsd: alert.thresholdUsd,
			windowCostUsd: alert.windowCostUsd,
			countedSince: cost.countedSince,
			createdAt: alert.createdAt,
		});

		if (cost.countedUsd >= settings.alertUsd) {
			const r = await openAlert(db, { tenantId, kind: "cost_alert", thresholdUsd: settings.alertUsd, windowCostUsd: cost.countedUsd, at });
			if (r.created) opened.push(event(r.alert));
		}
		if (cost.countedUsd >= settings.autopauseUsd) {
			const p = await dbPauseTenant(db, { tenantId, reason: "autopause", at });
			if (p.created) {
				result.paused = true;
				const r = await openAlert(db, { tenantId, kind: "autopause", thresholdUsd: settings.autopauseUsd, windowCostUsd: cost.countedUsd, at });
				opened.push(event(r.alert));
			}
		}
		result.alertOpened = opened.length > 0;
		for (const e of opened) await report(e);
		return result;
	}

	// One background check per tenant at a time; a call that lands meanwhile asks for one more.
	const running = new Map<string, Promise<void>>();
	const again = new Set<string>();

	function runInBackground(tenantId: string): void {
		const work = (async () => {
			do {
				again.delete(tenantId);
				try {
					await check(tenantId);
				} catch (error) {
					log(`alert: the cost check could not run for tenant ${tenantId} (${errorCode(error)})`);
					break;
				}
			} while (again.has(tenantId));
		})().finally(() => {
			running.delete(tenantId);
			again.delete(tenantId);
		});
		running.set(tenantId, work);
	}

	return {
		check,
		afterCall(tenantId) {
			if (running.has(tenantId)) again.add(tenantId);
			else runInBackground(tenantId);
		},
		async idle() {
			while (running.size > 0) await Promise.all([...running.values()]);
		},
	};
}

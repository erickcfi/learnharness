/**
 * The dashboard's pause and unpause buttons (C3 req 6, C7 req 2, D16).
 *
 * W2-7 (frontdoor/pause) owns what a pause does: its pauseTenant(tenantId,
 * reason, by) and unpauseTenant(tenantId, by) are wired in at merge, through
 * this interface. Until then databasePauseActions writes the pause row
 * directly, which the meter already obeys (frontdoor/metering).
 */
import { clearAlert, type Db, pauseTenant, unpauseTenant } from "../db/index.ts";

export interface PauseActions {
	/** `by` is the Owner's account id. */
	pauseTenant(tenantId: string, reason: "owner", by: string): Promise<unknown>;
	unpauseTenant(tenantId: string, by: string): Promise<unknown>;
}

export interface AlertActions {
	clearAlert(alertId: number, by: string): Promise<boolean>;
}

export function databasePauseActions(db: Db): PauseActions {
	return {
		pauseTenant: (tenantId, reason, by) => pauseTenant(db, { tenantId, reason, pausedBy: by }),
		unpauseTenant: (tenantId, by) => unpauseTenant(db, { tenantId, unpausedBy: by }),
	};
}

export function databaseAlertActions(db: Db): AlertActions {
	return { clearAlert: (alertId, by) => clearAlert(db, alertId, by) };
}

/** A stand-in for tests: records each call and does nothing else. */
export function createPauseStandIn(): PauseActions & { calls: Array<{ action: "pause" | "unpause"; tenantId: string; by: string; reason?: string }> } {
	const calls: Array<{ action: "pause" | "unpause"; tenantId: string; by: string; reason?: string }> = [];
	return {
		calls,
		async pauseTenant(tenantId, reason, by) {
			calls.push({ action: "pause", tenantId, by, reason });
		},
		async unpauseTenant(tenantId, by) {
			calls.push({ action: "unpause", tenantId, by });
		},
	};
}

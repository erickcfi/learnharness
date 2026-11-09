/**
 * The Owner's pause and unpause (P2-05; C3 req 6, C7 req 2, D16), for
 * w2-dashboard's buttons:
 *
 *   const controls = createPauseControls({ db });
 *   await controls.pauseTenant(tenantId, "owner", ownerAccountId);
 *   await controls.unpauseTenant(tenantId, ownerAccountId);
 *
 * A pause stops the tutor only: the meter refuses the tenant's model calls
 * and searches on its next check (it reads the database on every call), and
 * tutor pages show the pause screen (gate.ts). Billing goes on and the
 * student can still export and print.
 *
 * An unpause lets calls through at once and starts a fresh cost count
 * (limits.ts), so the student is not paused again by their next call. It
 * also clears the open autopause alert, by the same person; a cost alert
 * stays open until the Owner clears it on the dashboard.
 */
import { clearAlert, type Db, listAlerts, type Pause, type PauseReason, pauseTenant as dbPauseTenant, unpauseTenant as dbUnpauseTenant } from "../db/index.ts";
import { assertTenantId } from "../tenants/paths.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASONS: readonly PauseReason[] = ["autopause", "owner"];

function assertAccountId(by: string | null): void {
	if (by !== null && !UUID.test(by)) throw new Error("The account id of the person pausing must be a UUID (or null).");
}

export interface PauseControls {
	/** Pause a tenant. `by` is the Owner's account id, or null for the system. Already paused: created is false. */
	pauseTenant(tenantId: string, reason: PauseReason, by: string | null): Promise<{ pause: Pause; created: boolean }>;
	/** Unpause a tenant. False when it was not paused. */
	unpauseTenant(tenantId: string, by: string | null): Promise<boolean>;
}

export function createPauseControls(options: { db: Db; now?: () => Date }): PauseControls {
	const { db } = options;
	const now = options.now ?? (() => new Date());
	return {
		async pauseTenant(tenantId, reason, by) {
			assertTenantId(tenantId);
			assertAccountId(by);
			if (!REASONS.includes(reason)) throw new Error(`Unknown pause reason: ${String(reason).slice(0, 20)}`);
			return dbPauseTenant(db, { tenantId, reason, ...(by ? { pausedBy: by } : {}), at: now() });
		},
		async unpauseTenant(tenantId, by) {
			assertTenantId(tenantId);
			assertAccountId(by);
			const at = now();
			return db.transaction(async (tx) => {
				const unpaused = await dbUnpauseTenant(tx, { tenantId, ...(by ? { unpausedBy: by } : {}), at });
				if (!unpaused) return false;
				for (const alert of await listAlerts(tx, tenantId)) {
					if (alert.kind === "autopause" && alert.clearedAt === null) await clearAlert(tx, alert.id, by ?? undefined, at);
				}
				return true;
			});
		},
	};
}

/**
 * The pause rules on the meter's store (P2-05; C3 req 5 and 6, C1 req 6).
 * wiring wraps the meter's store with this, so metering's own code stays
 * as it is:
 *
 *  - recordCall: after each metered call is stored, the cost watch checks
 *    the tenant in the background (alert, autopause; limits.ts). The
 *    student's answer is never held up by it.
 *  - isPaused: the store's own pause check first, with its database-outage
 *    rules (it fails closed). Then a tenant in retention, or one deleted on
 *    day 91, is refused too, so a plan that ended stops costing money. If
 *    that second read fails, the call is not refused for it: the pause
 *    check already decided, and retention is never a surprise.
 */
import type { MeteringStore } from "../metering/store.ts";
import type { AccessReader } from "./access.ts";
import type { CostWatch } from "./limits.ts";

export function withPauseRules<S extends MeteringStore>(store: S, rules: { watch?: CostWatch; access?: AccessReader }): S {
	return {
		...store,
		async isPaused(tenantId: string): Promise<boolean> {
			if (await store.isPaused(tenantId)) return true;
			if (!rules.access) return false;
			try {
				const access = await rules.access.read(tenantId);
				return access.state === "retention" || access.state === "gone";
			} catch {
				return false;
			}
		},
		async recordCall(call) {
			await store.recordCall(call);
			// A call on the student's own key costs North Aero nothing, so it cannot move the count (2026-11-13).
			if (!call.ownKey) rules.watch?.afterCall(call.tenantId);
		},
	};
}

/**
 * What a student may do now, from their subscription (P4-03, C2 req 3).
 *
 *   open        studying: a live subscription, a running trial, or a tester
 *   trial-used  trialing, and 2 hours of study or $10 of model cost reached
 *   ended       the plan ended (retention, C1 req 6), or payment stopped
 *               (unpaid, paused). Chats and records stay readable.
 *   no-plan     never subscribed (or only a refused trial): the plans screen
 *
 * The Owner's own tenant (owner role, db/accounts.ts isOwnerTenant) is
 * always open, with or without a subscription: accessFor checks the role
 * whenever the plan alone would not be open. The plans screen shows the
 * plan as it is (planAccessFor). Staff is not exempt.
 *
 * The gateway asks on page loads and on requests that start model work, so
 * the answer is remembered for a few seconds per tenant, and forgotten at
 * once when a webhook or a billing action changes that tenant.
 */
import { type Db, getCurrentSubscription, getTenant, isOwnerTenant, type Subscription } from "../db/index.ts";
import { LIVE_STATUSES } from "./sync.ts";
import { skipsTrialGate, type TrialLimits, TRIAL_LIMITS, type TrialUsage, trialUsage } from "./trial.ts";

/** What the subscription alone allows. */
export type PlanAccess =
	| { state: "open"; subscription: Subscription; tester: boolean; usage: TrialUsage | null }
	| { state: "trial-used"; subscription: Subscription; usage: TrialUsage }
	| { state: "ended"; subscription: Subscription | null; retentionEndsAt: Date | null }
	| { state: "no-plan"; subscription: Subscription | null };

/** The Owner's own tenant: open whatever the plan says. */
export type OwnerAccess = { state: "open"; owner: true; subscription: Subscription | null; tester: false; usage: null };

export type Access = PlanAccess | OwnerAccess;

/** What the gates use: the plan's answer, except that the Owner's own tenant is always open. */
export async function accessFor(db: Db, tenantId: string, now: Date, limits: TrialLimits = TRIAL_LIMITS): Promise<Access> {
	const access = await planAccessFor(db, tenantId, now, limits);
	if (access.state !== "open" && (await isOwnerTenant(db, tenantId))) return { state: "open", owner: true, subscription: access.subscription, tester: false, usage: null };
	return access;
}

/** What the subscription alone allows, with no Owner exemption (the plans screen's status). */
export async function planAccessFor(db: Db, tenantId: string, now: Date, limits: TrialLimits = TRIAL_LIMITS): Promise<PlanAccess> {
	const [tenant, sub] = await Promise.all([getTenant(db, tenantId), getCurrentSubscription(db, tenantId)]);
	if (tenant?.status === "retention") return { state: "ended", subscription: sub, retentionEndsAt: tenant.retentionEndsAt };
	if (!sub) return { state: "no-plan", subscription: null };
	if (sub.status === "trialing") {
		if (skipsTrialGate(sub)) return { state: "open", subscription: sub, tester: true, usage: null };
		const usage = await trialUsage(db, sub, now, limits);
		return usage.usedUp ? { state: "trial-used", subscription: sub, usage } : { state: "open", subscription: sub, tester: false, usage };
	}
	if (LIVE_STATUSES.has(sub.status)) return { state: "open", subscription: sub, tester: skipsTrialGate(sub), usage: null };
	if (sub.status === "unpaid" || sub.status === "paused") return { state: "ended", subscription: sub, retentionEndsAt: null };
	// canceled with no retention (a refused trial), incomplete, incomplete_expired
	return { state: "no-plan", subscription: sub };
}

/** accessFor, remembered per tenant for `ttlMs`. */
export class AccessCache {
	#db: Db;
	#ttlMs: number;
	#now: () => number;
	#limits: TrialLimits;
	#entries = new Map<string, { at: number; value: Promise<Access> }>();

	constructor(db: Db, options: { ttlMs?: number; now?: () => number; limits?: TrialLimits } = {}) {
		this.#db = db;
		this.#ttlMs = options.ttlMs ?? 10_000;
		this.#now = options.now ?? Date.now;
		this.#limits = options.limits ?? TRIAL_LIMITS;
	}

	get(tenantId: string): Promise<Access> {
		const hit = this.#entries.get(tenantId);
		if (hit && this.#now() - hit.at < this.#ttlMs) return hit.value;
		const value = accessFor(this.#db, tenantId, new Date(this.#now()), this.#limits);
		this.#entries.set(tenantId, { at: this.#now(), value });
		value.catch(() => this.#entries.delete(tenantId));
		return value;
	}

	forget(tenantId: string): void {
		this.#entries.delete(tenantId);
	}
}

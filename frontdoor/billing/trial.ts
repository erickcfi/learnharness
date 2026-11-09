/**
 * The trial (P4-02, P4-03; PRD C2 req 2 and 3, D10, PD1, PD2, X4).
 *
 *  - One trial per email and per card. The email is checked before Checkout
 *    (a keyed one-way hash, never the address); the card's fingerprint is
 *    known only after Checkout, so the webhook claims both at once
 *    (claimTrial) and refuses the trial when either was used.
 *  - A student whose tenant ever had a subscription gets no new trial.
 *  - The trial ends early at 2 hours of active study (study_time, PD1) or
 *    $10 of model cost (PD2), whichever first. Testers skip this (D14).
 */
import { type Db, isTrialUsed, listSubscriptions, modelCostSince, type Subscription, studySecondsSince } from "../db/index.ts";
import { TRIAL, TRIAL_COST_CAP_USD } from "../plans/index.ts";
import { isTesterCoupon } from "./sync.ts";

export interface TrialLimits {
	studySeconds: number;
	costUsd: number;
}

export const TRIAL_LIMITS: TrialLimits = { studySeconds: TRIAL.studyHours * 3600, costUsd: TRIAL_COST_CAP_USD };

export type TrialEligibility = { eligible: true } | { eligible: false; reason: "email" | "returning" };

/** Whether a new Checkout for this tenant may include the trial. */
export async function trialEligibility(db: Db, input: { tenantId: string; email: string | null; hashEmail: (email: string) => string }): Promise<TrialEligibility> {
	if ((await listSubscriptions(db, input.tenantId)).length > 0) return { eligible: false, reason: "returning" };
	if (input.email && (await isTrialUsed(db, { emailHash: input.hashEmail(input.email) }))) return { eligible: false, reason: "email" };
	return { eligible: true };
}

export interface TrialUsage {
	studySeconds: number;
	costUsd: number;
	/** Which limit ended the trial, or null while it runs. */
	usedUp: "time" | "cost" | null;
}

/** Study time and model cost since the trial began, and whether a limit is reached. */
export async function trialUsage(db: Db, sub: Pick<Subscription, "tenantId" | "trialStart">, now: Date, limits: TrialLimits = TRIAL_LIMITS): Promise<TrialUsage> {
	const since = sub.trialStart ?? new Date(0);
	const [studySeconds, costUsd] = await Promise.all([studySecondsSince(db, sub.tenantId, since), modelCostSince(db, sub.tenantId, since, now)]);
	const usedUp = studySeconds >= limits.studySeconds ? "time" : costUsd >= limits.costUsd ? "cost" : null;
	return { studySeconds, costUsd, usedUp };
}

/** True when this trialing subscription has no study limit (tester coupon). */
export function skipsTrialGate(sub: Pick<Subscription, "couponId">): boolean {
	return isTesterCoupon(sub.couponId);
}

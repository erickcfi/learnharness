/**
 * What the plans screen shows (P4-03, P4-04, P4-05). GET /account/billing/state
 * answers with a BillingView; app/account/plans renders it. Plain data, no
 * framework, so the page and the gateway share the type.
 */
import type { PlanId } from "../plans/index.ts";

export type BillingStatus =
	/** No subscription yet (or only a refused trial). */
	| "none"
	| "trialing"
	/** Trialing, and 2 hours of study or $10 of model cost reached. */
	| "trial-used"
	| "active"
	/** A payment failed; Stripe is retrying. The tutor still works. */
	| "past-due"
	/** The student canceled; the plan runs to endsAt. */
	| "canceling"
	/** Payments stopped (unpaid or paused). Reads only. */
	| "unpaid"
	/** The plan ended; data kept until retentionEndsAt. Reads only. */
	| "ended";

export type BillingNotice =
	/** Back from Checkout; the webhook has not arrived yet. The page asks again. */
	| "finishing"
	| "welcome"
	| "trial-refused-card"
	| "trial-refused-email"
	| "checkout-canceled"
	/** Back from Buy now; waiting for Stripe to confirm the new plan. */
	| "buy-now-pending"
	| "bought"
	| "error-card"
	| "error-consent"
	| "error-already-subscribed"
	| "error-not-trialing"
	| "error-unavailable";

export interface BillingViewOn {
	billing: "on";
	status: BillingStatus;
	plan: PlanId | null;
	tester: boolean;
	/** The student's discount (20 for the North Aero code), or null. */
	discountPercent: number | null;
	/** True when a new Checkout would include the free trial. */
	trialEligible: boolean;
	/** ISO times, or null. */
	trialEndsAt: string | null;
	trialStudyMinutes: number | null;
	trialStudyLimitMinutes: number;
	/** Which trial limit ended the trial early. */
	trialUsedUp: "time" | "cost" | null;
	renewsAt: string | null;
	endsAt: string | null;
	retentionEndsAt: string | null;
	/** True when the student has a Stripe customer, so "Manage billing" works. */
	canManageBilling: boolean;
	notice: BillingNotice | null;
}

export type BillingView = BillingViewOn | { billing: "off" };

/** A price after a percent-off discount, in cents (Stripe rounds the discount to the cent). */
export function discountedCents(listCents: number, percentOff: number | null): number {
	if (!percentOff) return listCents;
	return listCents - Math.round((listCents * percentOff) / 100);
}

/** The notice a ?error= or ?bought= value on the plans page names. */
export function noticeFromQuery(query: { error?: string | null; bought?: string | null; checkout?: string | null }): BillingNotice | null {
	if (query.checkout === "canceled") return "checkout-canceled";
	switch (query.error) {
		case "card":
			return "error-card";
		case "consent":
			return "error-consent";
		case "already-subscribed":
			return "error-already-subscribed";
		case "not-trialing":
			return "error-not-trialing";
		case "unavailable":
			return "error-unavailable";
	}
	return null;
}

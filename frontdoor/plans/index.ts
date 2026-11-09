/**
 * Plans and trial: the ONE place prices live (PRD C2, D8, D10, D11, D34).
 *
 * Erick changes prices here. Every page that shows a price reads it from
 * this file, so no page text holds a dollar amount. The Stripe package
 * (W2-8) adds each plan's Stripe price id beside these values.
 *
 * D34: these are starting prices. The Owner sets them and changes them
 * after real users have tested the service.
 *
 * Framework-free and runnable by plain Node (type stripping).
 */

export type PlanId = "monthly" | "quarterly" | "annual";

export interface Plan {
	id: PlanId;
	/** Short name on the plan card. */
	name: string;
	/** Whole US dollars charged each billing period. */
	priceUsd: number;
	/** Length of one billing period, in months. */
	months: number;
}

export interface Trial {
	/** Days before the first charge (D10, D11). */
	days: number;
	/** Study hours the trial allows (D10, X4). */
	studyHours: number;
	/** The trial needs a card (C2 req 2). */
	cardRequired: boolean;
	/** The plan the trial turns into on its last day (D11). */
	convertsTo: PlanId;
}

export const PLANS: readonly Plan[] = [
	{ id: "monthly", name: "Monthly", priceUsd: 69, months: 1 },
	{ id: "quarterly", name: "3 months", priceUsd: 179, months: 3 },
	{ id: "annual", name: "Annual", priceUsd: 588, months: 12 },
];

export const TRIAL: Trial = {
	days: 7,
	studyHours: 2,
	cardRequired: true,
	convertsTo: "monthly",
};

/**
 * Model cost that also ends trial use, even before the study hours (PD2,
 * approved 2026-11-07). The trial gate (billing/trial.ts) reads it.
 */
export const TRIAL_COST_CAP_USD = 10;

/**
 * Each plan's Stripe price lookup key (W2-8). Price ids differ between
 * Stripe's test mode and live mode; a lookup key is the same in both. The
 * setup script (billing/setup.ts) creates each price from PLANS and gives it
 * this key; the front door finds the price by the key at run time.
 */
export const STRIPE_LOOKUP_KEYS: Readonly<Record<PlanId, string>> = {
	monthly: "ground_tutor_monthly",
	quarterly: "ground_tutor_quarterly",
	annual: "ground_tutor_annual",
};

/** "$69", or "$59.67" when cents are needed. */
export function formatUsd(amount: number): string {
	const whole = Number.isInteger(amount);
	return `$${amount.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** The plan's price spread over its months, rounded down to whole dollars. */
export function monthlyEquivalentUsd(plan: Plan): number {
	return Math.floor(plan.priceUsd / plan.months);
}

/** The plan the trial turns into. */
export function trialPlan(plans: readonly Plan[], trial: Trial): Plan {
	const plan = plans.find((p) => p.id === trial.convertsTo);
	if (!plan) throw new Error(`The trial converts to "${trial.convertsTo}", which is not in the plan list.`);
	return plan;
}

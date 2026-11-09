/**
 * What Stripe must hold (P4-01, PRD C2 plans, req 7 and 8): one product,
 * one price per plan, the two coupons. Built from plans/index.ts, the one
 * place prices and trial terms live.
 */
import type Stripe from "stripe";
import type { Plan as DbPlan } from "../db/index.ts";
import { type Plan, type PlanId, PLANS, STRIPE_LOOKUP_KEYS } from "../plans/index.ts";
import { PRODUCT_ID, STUDENT_COUPON_ID, TESTER_COUPON_ID } from "./config.ts";
import type { StripeApi } from "./stripe-api.ts";

export const PRODUCT_NAME = "North Aero Ground Tutor";
export const CURRENCY = "usd";

export interface PriceSpec {
	planId: PlanId;
	lookupKey: string;
	/** Cents. */
	unitAmount: number;
	interval: "month" | "year";
	intervalCount: number;
	nickname: string;
}

/** Stripe's recurring settings for a plan length: 1 → month, 3 → 3 months, 12 → year (C2 plans table). */
export function recurringFor(months: number): { interval: "month" | "year"; intervalCount: number } {
	if (!Number.isInteger(months) || months < 1) throw new RangeError(`A plan must last a whole number of months, got ${months}`);
	return months % 12 === 0 ? { interval: "year", intervalCount: months / 12 } : { interval: "month", intervalCount: months };
}

export function priceSpecs(plans: readonly Plan[] = PLANS, keys: Readonly<Record<PlanId, string>> = STRIPE_LOOKUP_KEYS): PriceSpec[] {
	return plans.map((plan) => ({
		planId: plan.id,
		lookupKey: keys[plan.id],
		unitAmount: Math.round(plan.priceUsd * 100),
		...recurringFor(plan.months),
		nickname: plan.name,
	}));
}

export interface CouponSpec {
	id: string;
	name: string;
	percentOff: number;
	/** Coupon-level limit across all customers. */
	maxRedemptions?: number;
	/** Where the setup script reads the customer-facing code (never stored in the repo, which is public). */
	codeEnv: string;
}

export const COUPONS: readonly CouponSpec[] = [
	// D13: 20% off, all plans, for as long as they subscribe. "First-time order only" stays off.
	{ id: STUDENT_COUPON_ID, name: "North Aero student 20%", percentOff: 20, codeEnv: "STRIPE_STUDENT_PROMO_CODE" },
	// D14: 100% off while they train; the code works 3 times only.
	{ id: TESTER_COUPON_ID, name: "Ground Tutor tester 100%", percentOff: 100, maxRedemptions: 3, codeEnv: "STRIPE_TESTER_PROMO_CODE" },
];

/** The plan whose lookup key this is, or null. */
export function planIdForLookupKey(lookupKey: string | null | undefined, keys: Readonly<Record<PlanId, string>> = STRIPE_LOOKUP_KEYS): PlanId | null {
	if (!lookupKey) return null;
	for (const [planId, key] of Object.entries(keys) as [PlanId, string][]) if (key === lookupKey) return planId;
	return null;
}

/** The database's plan name (subscriptions.plan) for a plan id. */
export function dbPlanFor(planId: PlanId): DbPlan {
	return planId === "quarterly" ? "three_month" : planId;
}

export function planById(planId: PlanId, plans: readonly Plan[] = PLANS): Plan {
	const plan = plans.find((p) => p.id === planId);
	if (!plan) throw new Error(`No plan "${planId}" in plans/index.ts`);
	return plan;
}

export function isPlanId(value: unknown): value is PlanId {
	return value === "monthly" || value === "quarterly" || value === "annual";
}

/**
 * Finds each plan's current Stripe price by lookup key, and remembers it for
 * 10 minutes. The same code works in test mode and live mode.
 */
export class PriceBook {
	#stripe: StripeApi;
	#keys: Readonly<Record<PlanId, string>>;
	#now: () => number;
	#cached: { at: number; byPlan: Map<PlanId, Stripe.Price> } | undefined;
	static readonly TTL_MS = 10 * 60 * 1000;

	constructor(stripe: StripeApi, options: { keys?: Readonly<Record<PlanId, string>>; now?: () => number } = {}) {
		this.#stripe = stripe;
		this.#keys = options.keys ?? STRIPE_LOOKUP_KEYS;
		this.#now = options.now ?? Date.now;
	}

	async price(planId: PlanId): Promise<Stripe.Price> {
		const byPlan = await this.#load();
		const price = byPlan.get(planId);
		if (!price) throw new Error(`Stripe has no active price with lookup key "${this.#keys[planId]}". Run the setup script (billing/README.md).`);
		return price;
	}

	async #load(): Promise<Map<PlanId, Stripe.Price>> {
		if (this.#cached && this.#now() - this.#cached.at < PriceBook.TTL_MS) return this.#cached.byPlan;
		const list = await this.#stripe.prices.list({ lookup_keys: Object.values(this.#keys), active: true, limit: 10 });
		const byPlan = new Map<PlanId, Stripe.Price>();
		for (const price of list.data) {
			const planId = planIdForLookupKey(price.lookup_key, this.#keys);
			if (planId) byPlan.set(planId, price);
		}
		this.#cached = { at: this.#now(), byPlan };
		return byPlan;
	}
}

/**
 * Stripe objects to database rows (P4-06, C2 req 9, C7 req 2 and 6).
 *
 * API version 2026-10-28.endive (stripe 23.1.0), checked 2026-11-08 in the
 * SDK's types: a subscription's period dates live on its item
 * (items.data[].current_period_start/end); its discounts are `discounts`, an
 * array of ids unless expanded, and each discount names its coupon in
 * source.coupon; an invoice names its subscription in
 * parent.subscription_details.subscription.
 */
import type Stripe from "stripe";
import type { InvoiceInput, SubscriptionInput } from "../db/index.ts";
import { COUPONS, dbPlanFor, planIdForLookupKey } from "./catalog.ts";
import { TESTER_COUPON_ID } from "./config.ts";
import { idOf } from "./stripe-api.ts";

const at = (seconds: number | null | undefined): Date | null => (typeof seconds === "number" ? new Date(seconds * 1000) : null);

/** Statuses that give the student the tutor (with the trial gate while trialing). */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["trialing", "active", "past_due"]);

export interface AppliedDiscount {
	couponId: string | null;
	promotionCodeId: string | null;
	percentOff: number | null;
}

/** The first discount on a subscription, from an expanded `discounts` list. Ids alone give nothing. */
export function appliedDiscount(sub: Pick<Stripe.Subscription, "discounts">): AppliedDiscount {
	for (const d of sub.discounts ?? []) {
		if (typeof d === "string") continue;
		const source = d.source?.coupon ?? null;
		const couponId = idOf(source);
		const percentOff = source && typeof source !== "string" ? source.percent_off : (COUPONS.find((c) => c.id === couponId)?.percentOff ?? null);
		return { couponId, promotionCodeId: idOf(d.promotion_code as string | { id: string } | null), percentOff: percentOff ?? null };
	}
	return { couponId: null, promotionCodeId: null, percentOff: null };
}

/** True when the subscription carries the tester coupon (D14): no trial gate. */
export function isTesterCoupon(couponId: string | null | undefined): boolean {
	return couponId === TESTER_COUPON_ID;
}

/** The subscription's one item (the front door makes one-item subscriptions only). */
export function mainItem(sub: Pick<Stripe.Subscription, "items">): Stripe.SubscriptionItem | null {
	return sub.items?.data?.[0] ?? null;
}

/** The row for subscriptions (db/billing.ts). `sub` should have `discounts` expanded. */
export function subscriptionInput(sub: Stripe.Subscription, tenantId: string, eventCreatedAt: Date): SubscriptionInput {
	const item = mainItem(sub);
	const planId = planIdForLookupKey(item?.price?.lookup_key) ?? planIdForLookupKey(planKeyFromMetadata(item?.price));
	const discount = appliedDiscount(sub);
	return {
		stripeSubscriptionId: sub.id,
		tenantId,
		status: sub.status,
		plan: planId ? dbPlanFor(planId) : null,
		priceId: item?.price?.id ?? null,
		trialStart: at(sub.trial_start),
		trialEnd: at(sub.trial_end),
		currentPeriodStart: at(item?.current_period_start),
		currentPeriodEnd: at(item?.current_period_end),
		// A cancellation the student scheduled (portal) shows as cancel_at_period_end, or as a cancel_at date.
		cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end) || (sub.cancel_at !== null && sub.cancel_at !== undefined && sub.status !== "canceled"),
		canceledAt: at(sub.canceled_at),
		endedAt: at(sub.ended_at),
		couponId: discount.couponId,
		promotionCodeId: discount.promotionCodeId,
		percentOff: discount.percentOff,
		eventCreatedAt,
	};
}

/** Our setup script puts the plan id in each price's metadata; a fallback if a lookup key moved. */
function planKeyFromMetadata(price: Stripe.Price | undefined): string | null {
	const plan = price?.metadata?.plan;
	if (plan === "monthly") return "ground_tutor_monthly";
	if (plan === "quarterly") return "ground_tutor_quarterly";
	if (plan === "annual") return "ground_tutor_annual";
	return null;
}

/** The subscription id an invoice belongs to, or null. */
export function invoiceSubscriptionId(inv: Pick<Stripe.Invoice, "parent">): string | null {
	return idOf((inv.parent?.subscription_details?.subscription ?? null) as string | { id: string } | null);
}

/** The row for invoices (db/billing.ts): revenue and conversion. */
export function invoiceInput(inv: Stripe.Invoice, tenantId: string): InvoiceInput {
	const paidAt = at(inv.status_transitions?.paid_at);
	return {
		stripeInvoiceId: inv.id,
		tenantId,
		stripeSubscriptionId: invoiceSubscriptionId(inv),
		status: inv.status ?? "draft",
		billingReason: inv.billing_reason ?? null,
		amountPaidCents: inv.amount_paid ?? 0,
		currency: inv.currency ?? "usd",
		paidAt: inv.status === "paid" ? (paidAt ?? at(inv.created)) : paidAt,
		periodStart: at(inv.period_start),
		periodEnd: at(inv.period_end),
	};
}

/** Why the front door refused this subscription's trial, from its metadata, or null. */
export function trialRefusal(sub: Pick<Stripe.Subscription, "metadata">): "email" | "card" | null {
	const reason = sub.metadata?.trial_refused;
	return reason === "email" || reason === "card" ? reason : null;
}

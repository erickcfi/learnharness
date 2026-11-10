/**
 * What a student does on the plans screen, and the Owner's tester step
 * (P4-02, P4-04, P4-05, P4-07; PRD C2 req 1, 2, 4, 7, 8).
 *
 * Checkout settings (Stripe docs, 2026-11-08):
 *  - mode "subscription"; payment_method_collection "always" collects a card
 *    even with a trial or a 100% code (C2 req 2: card required).
 *  - subscription_data.trial_period_days: the 7-day trial, only on the
 *    monthly price and only when the student may have one.
 *  - allow_promotion_codes: the box for the student and tester codes.
 *  - consent_collection.terms_of_service "required": the student must tick
 *    the terms (California automatic renewal law needs affirmative consent).
 *    Needs a terms URL in Stripe's Public details first.
 *  - customer: our own Customer with the Clerk email, so Checkout shows it
 *    read-only and the email trial check means something.
 *  - managed_payments.enabled false: North Aero is the seller. Stripe turns
 *    Managed Payments (Stripe as merchant of record) on by default for new
 *    accounts, and then refuses custom_text, so Checkout failed for every
 *    student (staging, 2026-11-10). Using Managed Payments is Erick's call.
 *
 * Buy now (C2 req 4) is one subscription update: trial_end "now", the new
 * price, proration_behavior "always_invoice" (so the charge is made now, in
 * any billing mode), payment_behavior "pending_if_incomplete" (a refused
 * card changes nothing; 3D Secure goes to Stripe's hosted invoice page).
 */
import type Stripe from "stripe";
import { getCurrentSubscription, getTenant, listSubscriptions, setStripeCustomerId } from "../db/index.ts";
import { type PlanId, TRIAL } from "../plans/index.ts";
import { accessFor } from "./access.ts";
import { isPlanId, planById } from "./catalog.ts";
import { PLANS_PATH, TESTER_COUPON_ID } from "./config.ts";
import { checkoutTermsText } from "./copy.ts";
import type { BillingCore } from "./core.ts";
import { idOf, isCardError } from "./stripe-api.ts";
import { LIVE_STATUSES, trialRefusal } from "./sync.ts";
import { trialEligibility, TRIAL_LIMITS } from "./trial.ts";
import type { BillingNotice, BillingStatus, BillingViewOn } from "./view.ts";

export type ActionResult = { redirect: string } | { error: "card" | "consent" | "already-subscribed" | "not-trialing" | "unavailable" | "bad-plan" };

/** The plan's Checkout page. The trial is added when the student may have one and picks the trial plan. */
export async function startCheckout(core: BillingCore, input: { tenantId: string; email: string; planId: PlanId; origin: string }): Promise<ActionResult> {
	if (!isPlanId(input.planId)) return { error: "bad-plan" };
	const tenant = await getTenant(core.db, input.tenantId);
	if (!tenant) return { error: "unavailable" };
	const current = await getCurrentSubscription(core.db, input.tenantId);
	if (current && LIVE_STATUSES.has(current.status)) return { error: "already-subscribed" };

	const eligibility = await trialEligibility(core.db, { tenantId: input.tenantId, email: input.email, hashEmail: core.hashEmail });
	const trial = eligibility.eligible && input.planId === TRIAL.convertsTo;
	const price = await core.prices.price(input.planId);

	let customerId = tenant.stripeCustomerId;
	if (!customerId) {
		customerId = (await core.stripe.customers.create({ email: input.email, metadata: { tenant_id: tenant.id } })).id;
		await setStripeCustomerId(core.db, tenant.id, customerId);
	}
	const plan = planById(input.planId);
	const session = await core.stripe.checkout.sessions.create({
		mode: "subscription",
		customer: customerId,
		client_reference_id: tenant.id,
		line_items: [{ price: price.id, quantity: 1 }],
		payment_method_collection: "always",
		allow_promotion_codes: true,
		consent_collection: { terms_of_service: "required" },
		custom_text: {
			terms_of_service_acceptance: {
				message: checkoutTermsText(input.origin, plan.months),
			},
		},
		managed_payments: { enabled: false },
		subscription_data: {
			...(trial ? { trial_period_days: TRIAL.days } : {}),
			metadata: { tenant_id: tenant.id, trial: trial ? "granted" : "none" },
		},
		metadata: { tenant_id: tenant.id },
		success_url: `${input.origin}${PLANS_PATH}?checkout={CHECKOUT_SESSION_ID}`,
		cancel_url: `${input.origin}${PLANS_PATH}?checkout=canceled`,
		// 1 hour, so an old tab cannot start a second subscription much later (Stripe allows 30 minutes to 24 hours).
		expires_at: Math.floor(core.now() / 1000) + 3600,
	});
	if (!session.url) return { error: "unavailable" };
	return { redirect: session.url };
}

/** Buy now: ends the trial, charges at once, and switches to the chosen plan in the same update. */
export async function buyNow(core: BillingCore, input: { tenantId: string; planId: PlanId; agreed: boolean }): Promise<ActionResult> {
	if (!isPlanId(input.planId)) return { error: "bad-plan" };
	if (!input.agreed) return { error: "consent" };
	const current = await getCurrentSubscription(core.db, input.tenantId);
	if (!current || current.status !== "trialing") return { error: "not-trialing" };
	const price = await core.prices.price(input.planId);
	const live = await core.stripe.subscriptions.retrieve(current.stripeSubscriptionId);
	const item = live.items.data[0];
	if (!item || live.status !== "trialing") return { error: "not-trialing" };
	let updated: Stripe.Subscription;
	try {
		updated = await core.stripe.subscriptions.update(live.id, {
			trial_end: "now",
			items: [{ id: item.id, price: price.id }],
			proration_behavior: "always_invoice",
			payment_behavior: "pending_if_incomplete",
			metadata: { bought_now: input.planId },
			expand: ["latest_invoice"],
		});
	} catch (error) {
		if (isCardError(error)) return { error: "card" };
		throw error;
	} finally {
		core.access.forget(input.tenantId);
	}
	if (updated.pending_update) {
		const invoice = updated.latest_invoice;
		const url = invoice && typeof invoice !== "string" ? invoice.hosted_invoice_url : null;
		return url ? { redirect: url } : { error: "card" };
	}
	return { redirect: `${PLANS_PATH}?bought=${input.planId}` };
}

/** Stripe's customer portal: card changes, invoices, cancellation (C2 req 1). */
export async function openPortal(core: BillingCore, input: { tenantId: string; origin: string }): Promise<ActionResult> {
	const tenant = await getTenant(core.db, input.tenantId);
	if (!tenant?.stripeCustomerId) return { error: "unavailable" };
	const session = await core.stripe.billingPortal.sessions.create({ customer: tenant.stripeCustomerId, return_url: `${input.origin}${PLANS_PATH}` });
	return { redirect: session.url };
}

/**
 * The Owner's step when a tester's training ends (C2 req 8, D14): removes
 * the 100% discount, so the next invoice is at the plan's price and the
 * trial gate applies again. False when the tenant has no tester discount.
 * For a dashboard button (w2-dashboard); the Stripe Dashboard steps are in
 * billing/README.md.
 */
export async function removeTesterDiscount(core: BillingCore, tenantId: string): Promise<boolean> {
	const current = await getCurrentSubscription(core.db, tenantId);
	if (!current || current.couponId !== TESTER_COUPON_ID) return false;
	await core.stripe.subscriptions.deleteDiscount(current.stripeSubscriptionId);
	core.access.forget(tenantId);
	return true;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The plans screen's data. `checkoutSessionId` is set when the student comes back from Checkout. */
export async function billingState(
	core: BillingCore,
	input: { tenantId: string; email: string | null; checkoutSessionId?: string | null; notice?: BillingNotice | null; bought?: string | null },
): Promise<BillingViewOn> {
	const now = new Date(core.now());
	const access = await accessFor(core.db, input.tenantId, now);
	const tenant = await getTenant(core.db, input.tenantId);
	const sub = access.subscription;
	let notice: BillingNotice | null = input.notice ?? null;

	if (input.checkoutSessionId && input.checkoutSessionId !== "canceled") {
		const session = await core.stripe.checkout.sessions.retrieve(input.checkoutSessionId).catch(() => null);
		if (session && session.client_reference_id === input.tenantId && session.status === "complete") {
			const subId = idOf(session.subscription as string | { id: string } | null);
			const row = subId ? (await listSubscriptions(core.db, input.tenantId)).find((s) => s.stripeSubscriptionId === subId) : undefined;
			if (!row) notice = "finishing";
			else if (row.status === "canceled" && subId) {
				const reason = trialRefusal(await core.stripe.subscriptions.retrieve(subId));
				notice = reason === "card" ? "trial-refused-card" : reason === "email" ? "trial-refused-email" : null;
			} else notice = "welcome";
		}
	}
	if (input.bought && isPlanId(input.bought) && !notice) {
		const done = sub?.status === "active" && (sub.plan === input.bought || (sub.plan === "three_month" && input.bought === "quarterly"));
		notice = done ? "bought" : "buy-now-pending";
	}

	let status: BillingStatus;
	switch (access.state) {
		case "no-plan":
			status = "none";
			break;
		case "trial-used":
			status = "trial-used";
			break;
		case "ended":
			status = access.subscription && (access.subscription.status === "unpaid" || access.subscription.status === "paused") ? "unpaid" : "ended";
			break;
		case "open":
			status = access.subscription.status === "trialing" ? "trialing" : access.subscription.status === "past_due" ? "past-due" : access.subscription.cancelAtPeriodEnd ? "canceling" : "active";
			break;
	}
	const usage = access.state === "trial-used" ? access.usage : access.state === "open" ? access.usage : null;
	const trialEligible = status === "none" ? (await trialEligibility(core.db, { tenantId: input.tenantId, email: input.email, hashEmail: core.hashEmail })).eligible : false;
	const plan = sub?.plan === "three_month" ? "quarterly" : (sub?.plan ?? null);

	return {
		billing: "on",
		status,
		plan: status === "none" ? null : plan,
		tester: sub?.couponId === TESTER_COUPON_ID,
		discountPercent: status === "none" ? null : (sub?.percentOff ?? null),
		trialEligible,
		trialEndsAt: sub?.status === "trialing" ? iso(sub.trialEnd) : null,
		trialStudyMinutes: usage ? Math.floor(usage.studySeconds / 60) : null,
		trialStudyLimitMinutes: TRIAL_LIMITS.studySeconds / 60,
		trialUsedUp: usage?.usedUp ?? null,
		renewsAt: status === "active" || status === "past-due" ? iso(sub?.currentPeriodEnd) : status === "trialing" || status === "trial-used" ? iso(sub?.trialEnd) : null,
		endsAt: status === "canceling" ? iso(sub?.currentPeriodEnd) : null,
		retentionEndsAt: iso(tenant?.retentionEndsAt),
		canManageBilling: Boolean(tenant?.stripeCustomerId),
		notice,
	};
}

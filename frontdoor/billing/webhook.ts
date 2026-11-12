/**
 * Stripe webhooks (P4-06, PRD C2 req 9; C7 req 2 and 6).
 *
 *  - The signature is checked with Stripe's own code (constructEvent, raw
 *    body, 300-second tolerance). A bad or missing signature gets 400.
 *  - Each event id is stored once (stripe_events) in the same transaction as
 *    its writes: a repeat changes nothing, and a failure leaves no trace, so
 *    Stripe's retry runs it again (it retries for up to 3 days).
 *  - Stripe does not deliver events in order, so subscriptions and invoices
 *    are read fresh from Stripe and written as they are now; an event older
 *    than the one already applied is skipped (upsertSubscription).
 *  - checkout.session.completed claims the one trial per email and card
 *    (trial_claims). A repeat email or card: the new subscription is
 *    canceled at once, nothing charged, and the reason is kept in its
 *    metadata (trial_refused) for the plans screen.
 *  - A subscription that really ends starts retention (C1 req 6); one that
 *    starts again during retention ends it. Those calls run after the
 *    transaction commits (w2-pause writes through its own database handle).
 *    If one fails, the event is forgotten and Stripe's retry runs it again;
 *    every write of a subscription event is safe to repeat.
 *  - Billing emails (confirmation, annual renewal notice) are sent inside the
 *    same step: if sending fails, the event fails and Stripe retries it.
 */
import type Stripe from "stripe";
import {
	claimTrial,
	type Db,
	getTenant,
	getTenantByStripeCustomerId,
	isTrialUsed,
	listSubscriptions,
	processStripeEventOnce,
	setStripeCustomerId,
	type Tenant,
	upsertInvoice,
	upsertSubscription,
} from "../db/index.ts";
import { normalizeEmailAddress } from "../email/address.ts";
import { InvalidEmailMessageError } from "../email/sender.ts";
import { errorLabel } from "../log-hygiene/filter.ts";
import type { PlanId } from "../plans/index.ts";
import { COUPONS, isPlanId, planIdForLookupKey } from "./catalog.ts";
import type { BillingCore } from "./core.ts";
import { confirmationEmail, renewalNoticeEmail } from "./emails.ts";
import type { EmailMessage } from "./hooks.ts";
import { idOf, type StripeApi } from "./stripe-api.ts";
import { invoiceInput, invoiceSubscriptionId, LIVE_STATUSES, mainItem, subscriptionInput, trialRefusal } from "./sync.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WebhookResult {
	status: number;
	body: { received: true; duplicate?: boolean } | { error: string };
}

/** Checks the signature and applies the event once. */
export async function receiveWebhook(core: BillingCore, rawBody: Buffer, signature: string | undefined): Promise<WebhookResult> {
	if (!signature) return { status: 400, body: { error: "Missing Stripe-Signature." } };
	let event: Stripe.Event;
	try {
		event = core.stripe.webhooks.constructEvent(rawBody, signature, core.webhookSecret);
	} catch {
		return { status: 400, body: { error: "Invalid signature." } };
	}
	const afterCommit: AfterCommit = [];
	try {
		const outcome = await processStripeEventOnce(core.db, { id: event.id, type: event.type, createdAt: new Date(event.created * 1000) }, (tx) => applyEvent(core, tx, event, afterCommit));
		if (outcome === "duplicate") return { status: 200, body: { received: true, duplicate: true } };
	} catch (error) {
		core.log(`stripe event ${event.id} (${event.type}) failed, Stripe will retry (${errorLabel(error)})`);
		return { status: 500, body: { error: "Not processed. Stripe will retry." } };
	}
	try {
		for (const step of afterCommit) await step();
	} catch (error) {
		// Forget the event so Stripe's retry runs it again (its writes are safe to repeat).
		await core.db.query("delete from stripe_events where id = $1", [event.id]).catch(() => {});
		core.log(`stripe event ${event.id} (${event.type}): retention step failed, Stripe will retry (${errorLabel(error)})`);
		return { status: 500, body: { error: "Not processed. Stripe will retry." } };
	}
	return { status: 200, body: { received: true } };
}

/** Steps that run once the event's transaction has committed. */
type AfterCommit = (() => Promise<unknown>)[];

async function applyEvent(core: BillingCore, tx: Db, event: Stripe.Event, afterCommit: AfterCommit): Promise<void> {
	const createdAt = new Date(event.created * 1000);
	const object = event.data.object as unknown as { id?: string; object?: string };
	if (event.type === "checkout.session.completed") return checkoutCompleted(core, tx, object as Stripe.Checkout.Session, createdAt);
	if (event.type.startsWith("customer.subscription.") && object.id) {
		await syncSubscription(core, tx, object.id, createdAt, afterCommit);
		return;
	}
	if (event.type === "invoice.upcoming") return upcomingRenewal(core, tx, object as Stripe.Invoice);
	if (event.type.startsWith("invoice.") && object.id) return syncInvoice(core, tx, object.id);
	// Other events are acknowledged and ignored.
}

async function tenantForCustomer(tx: Db, customerId: string | null): Promise<Tenant | null> {
	return customerId ? getTenantByStripeCustomerId(tx, customerId) : null;
}

/** Fills each discount's coupon when Stripe gave only its id (the coupon does not expand by itself since API 2025-09-30). */
async function withCoupons(stripe: StripeApi, sub: Stripe.Subscription): Promise<Stripe.Subscription> {
	for (const d of sub.discounts ?? []) {
		if (typeof d === "string" || !d.source || typeof d.source.coupon !== "string") continue;
		if (COUPONS.some((c) => c.id === d.source.coupon)) continue;
		d.source.coupon = await stripe.coupons.retrieve(d.source.coupon);
	}
	return sub;
}

async function retrieveSubscription(stripe: StripeApi, id: string, extra: string[] = []): Promise<Stripe.Subscription> {
	return withCoupons(stripe, await stripe.subscriptions.retrieve(id, { expand: ["discounts", ...extra] }));
}

function planOf(sub: Stripe.Subscription): PlanId | null {
	return planIdForLookupKey(mainItem(sub)?.price?.lookup_key);
}

const dateOf = (seconds: number | null | undefined) => (typeof seconds === "number" ? new Date(seconds * 1000) : null);

async function send(core: BillingCore, tenantId: string, message: EmailMessage): Promise<void> {
	if (!core.email) {
		core.log(`billing email not sent (no email sender wired): ${message.kind} for tenant ${tenantId}`);
		return;
	}
	try {
		await core.email.send(message);
	} catch (error) {
		// A bad address will never send: log it and go on. Anything else (SES down) fails the event, so Stripe retries.
		if (error instanceof InvalidEmailMessageError) {
			core.log(`billing email not sent (${errorLabel(error)}): ${message.kind} for tenant ${tenantId}`);
			return;
		}
		throw error;
	}
	core.log(`billing email sent: ${message.kind} for tenant ${tenantId}`);
}

/** The address Stripe holds, trimmed and checked, or null. */
const cleanAddress = (value: string | null | undefined) => normalizeEmailAddress(value);

/** Reads the subscription from Stripe and writes it. Plans the retention call (after commit) when it ended or came back. */
export async function syncSubscription(
	core: BillingCore,
	tx: Db,
	subscriptionId: string,
	createdAt: Date,
	afterCommit: AfterCommit,
): Promise<{ tenant: Tenant; sub: Stripe.Subscription } | null> {
	const sub = await retrieveSubscription(core.stripe, subscriptionId);
	let tenant = await tenantForCustomer(tx, idOf(sub.customer));
	const metaTenant = sub.metadata?.tenant_id;
	if (!tenant && metaTenant && UUID.test(metaTenant)) tenant = await getTenant(tx, metaTenant);
	if (!tenant) {
		core.log(`stripe subscription ${sub.id} belongs to no tenant; skipped`);
		return null;
	}
	const before = (await listSubscriptions(tx, tenant.id)).find((s) => s.stripeSubscriptionId === sub.id) ?? null;
	const { applied } = await upsertSubscription(tx, subscriptionInput(sub, tenant.id, createdAt));

	const ended = sub.status === "canceled" || sub.status === "incomplete_expired";
	if (ended && sub.ended_at && trialRefusal(sub) === null && tenant.status !== "retention") {
		const others = (await listSubscriptions(tx, tenant.id)).filter((s) => s.stripeSubscriptionId !== sub.id && LIVE_STATUSES.has(s.status));
		const endedAt = new Date(sub.ended_at * 1000);
		const tenantId = tenant.id;
		if (others.length === 0) afterCommit.push(() => core.retention.startRetention(tenantId, endedAt));
	}
	if (LIVE_STATUSES.has(sub.status) && tenant.status === "retention") {
		const tenantId = tenant.id;
		afterCommit.push(() => core.retention.endRetention(tenantId));
	}
	afterCommit.push(async () => core.access.forget(tenant.id));

	// A plan change on a live subscription (Buy now): send the new terms (California automatic renewal law).
	const plan = planOf(sub);
	const beforePlan = before?.plan === "three_month" ? "quarterly" : before?.plan;
	if (applied && plan && isPlanId(beforePlan) && beforePlan !== plan && LIVE_STATUSES.has(sub.status) && sub.status !== "trialing") {
		const to = cleanAddress(await customerEmailFromInvoice(core.stripe, sub));
		if (to) {
			const item = mainItem(sub);
			await send(
				core,
				tenant.id,
				confirmationEmail({
					tenantId: tenant.id,
					to,
					siteUrl: core.siteUrl,
					planId: plan,
					percentOff: subscriptionInput(sub, tenant.id, createdAt).percentOff ?? null,
					trialEndsAt: null,
					nextChargeAt: dateOf(item?.current_period_end),
					chargedTodayCents: await latestPaidCents(core.stripe, sub),
					reason: "change",
				}),
			);
		} else core.log(`plan change for tenant ${tenant.id}: no email address on the latest invoice; confirmation not sent`);
	}
	core.access.forget(tenant.id);
	return { tenant, sub };
}

async function customerEmailFromInvoice(stripe: StripeApi, sub: Stripe.Subscription): Promise<string | null> {
	const id = idOf(sub.latest_invoice as string | { id: string } | null);
	if (!id) return null;
	return (await stripe.invoices.retrieve(id)).customer_email ?? null;
}

async function latestPaidCents(stripe: StripeApi, sub: Stripe.Subscription): Promise<number | null> {
	const id = idOf(sub.latest_invoice as string | { id: string } | null);
	if (!id) return null;
	const inv = await stripe.invoices.retrieve(id);
	return inv.status === "paid" ? inv.amount_paid : null;
}

/** The card's fingerprint: the subscription's default card, else the customer's newest saved card. */
export async function cardFingerprint(stripe: StripeApi, sub: Stripe.Subscription, customerId: string | null): Promise<string | null> {
	const pm = sub.default_payment_method;
	if (pm && typeof pm !== "string") return pm.card?.fingerprint ?? null;
	if (typeof pm === "string") return (await stripe.paymentMethods.retrieve(pm)).card?.fingerprint ?? null;
	if (!customerId) return null;
	const saved = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
	return saved.data[0]?.card?.fingerprint ?? null;
}

async function checkoutCompleted(core: BillingCore, tx: Db, session: Stripe.Checkout.Session, createdAt: Date): Promise<void> {
	if (session.mode !== "subscription") return;
	const tenantId = session.client_reference_id;
	const tenant = tenantId && UUID.test(tenantId) ? await getTenant(tx, tenantId) : null;
	if (!tenant) {
		core.log(`checkout ${session.id} names no known tenant; skipped`);
		return;
	}
	const customerId = idOf(session.customer as string | { id: string } | null);
	if (customerId && !tenant.stripeCustomerId) await setStripeCustomerId(tx, tenant.id, customerId);
	else if (customerId && tenant.stripeCustomerId !== customerId) core.log(`checkout ${session.id}: customer differs from tenant ${tenant.id}'s customer`);

	const subscriptionId = idOf(session.subscription as string | { id: string } | null);
	if (!subscriptionId) return;
	let sub = await retrieveSubscription(core.stripe, subscriptionId, ["default_payment_method"]);
	await upsertSubscription(tx, subscriptionInput(sub, tenant.id, createdAt));
	const email = cleanAddress(session.customer_details?.email);

	let refused = trialRefusal(sub);
	if (sub.status === "trialing" && refused === null) {
		const fingerprint = await cardFingerprint(core.stripe, sub, customerId);
		const keys = { ...(email ? { emailHash: core.hashEmail(email) } : {}), ...(fingerprint ? { cardFingerprint: fingerprint } : {}) };
		if (!keys.emailHash && !keys.cardFingerprint) core.log(`checkout ${session.id}: no email and no card fingerprint, so the one-trial check could not run`);
		else if (!(await claimTrial(tx, keys))) {
			refused = keys.cardFingerprint && (await isTrialUsed(tx, { cardFingerprint: keys.cardFingerprint })) ? "card" : "email";
			await core.stripe.subscriptions.update(sub.id, { metadata: { trial_refused: refused } });
			sub = await core.stripe.subscriptions.cancel(sub.id);
			await upsertSubscription(tx, subscriptionInput(sub, tenant.id, createdAt));
			core.log(`tenant ${tenant.id}: trial refused (this ${refused} already had one); subscription ${sub.id} canceled, nothing charged`);
		} else if (!fingerprint) core.log(`checkout ${session.id}: no card fingerprint found; only the email was claimed`);
	}

	if (refused === null && email && LIVE_STATUSES.has(sub.status)) {
		const plan = planOf(sub);
		if (plan) {
			const item = mainItem(sub);
			const trialEndsAt = sub.status === "trialing" ? dateOf(sub.trial_end) : null;
			await send(
				core,
				tenant.id,
				confirmationEmail({
					tenantId: tenant.id,
					to: email,
					siteUrl: core.siteUrl,
					planId: plan,
					percentOff: subscriptionInput(sub, tenant.id, createdAt).percentOff ?? null,
					trialEndsAt,
					nextChargeAt: trialEndsAt ?? dateOf(item?.current_period_end),
					chargedTodayCents: trialEndsAt ? null : await latestPaidCents(core.stripe, sub),
					reason: "start",
				}),
			);
		}
	}
	core.access.forget(tenant.id);
}

async function syncInvoice(core: BillingCore, tx: Db, invoiceId: string): Promise<void> {
	const inv = await core.stripe.invoices.retrieve(invoiceId);
	const tenant = await tenantForCustomer(tx, idOf(inv.customer as string | { id: string } | null));
	if (!tenant) {
		core.log(`stripe invoice ${inv.id} belongs to no tenant; skipped`);
		return;
	}
	await upsertInvoice(tx, invoiceInput(inv, tenant.id));
	core.access.forget(tenant.id);
}

/** invoice.upcoming: the renewal notice for plans of 12 months or more (California automatic renewal law). */
async function upcomingRenewal(core: BillingCore, tx: Db, inv: Stripe.Invoice): Promise<void> {
	// Endpoints on an API version before 2025-03-31 put the id at invoice.subscription.
	const subscriptionId = invoiceSubscriptionId(inv) ?? ((inv as unknown as { subscription?: string }).subscription || null);
	if (!subscriptionId) return;
	const sub = await core.stripe.subscriptions.retrieve(subscriptionId);
	const recurring = mainItem(sub)?.price?.recurring;
	const months = recurring ? (recurring.interval === "year" ? 12 * recurring.interval_count : recurring.interval === "month" ? recurring.interval_count : 0) : 0;
	if (months < 12 || sub.status !== "active" || sub.cancel_at_period_end || sub.cancel_at) return;
	const tenant = await tenantForCustomer(tx, idOf(sub.customer));
	if (!tenant) return;
	const renewsAt = dateOf(mainItem(sub)?.current_period_end) ?? dateOf(inv.next_payment_attempt);
	const to = cleanAddress(inv.customer_email);
	if (!to || !renewsAt) {
		core.log(`renewal notice for tenant ${tenant.id} not sent: ${to ? "no renewal date" : "no usable email address on the invoice"}`);
		return;
	}
	await send(core, tenant.id, renewalNoticeEmail({ tenantId: tenant.id, to, siteUrl: core.siteUrl, amountCents: inv.amount_due, renewsAt, months }));
}

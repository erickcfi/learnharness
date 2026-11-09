/**
 * Stripe webhook state: event dedupe, subscriptions, invoices, the Stripe
 * customer link, and trial claims (C2 req 2, 4, 5, 9; C7 req 2; D10).
 */

import { createHmac } from "node:crypto";
import { type Tenant, toTenant } from "./accounts.ts";
import { date, dateOrNull, type Db, must, num, numOrNull, one, type Row, strOrNull } from "./db.ts";

// ---- webhook events (C2 req 9) ----

export interface StripeEventRef {
	id: string;
	type: string;
	/** The event's own `created` time from Stripe. */
	createdAt: Date;
}

/**
 * Apply a verified Stripe event once. The event ID and the handler's writes
 * land in one transaction: a repeated event returns "duplicate" and runs
 * nothing, and a handler that throws leaves no trace, so Stripe's retry runs
 * it again. Verify the signature before calling this.
 */
export async function processStripeEventOnce(
	db: Db,
	event: StripeEventRef,
	handler: (tx: Db) => Promise<void>,
): Promise<"processed" | "duplicate"> {
	return db.transaction(async (tx) => {
		const fresh = await tx.query("insert into stripe_events (id, type, stripe_created_at) values ($1, $2, $3) on conflict (id) do nothing returning id", [
			event.id,
			event.type,
			event.createdAt,
		]);
		if (fresh.length === 0) return "duplicate";
		await handler(tx);
		return "processed";
	});
}

// ---- subscriptions ----

export type Plan = "monthly" | "three_month" | "annual";

export interface SubscriptionInput {
	stripeSubscriptionId: string;
	tenantId: string;
	/** Stripe's status string: trialing, active, past_due, canceled, ... */
	status: string;
	plan?: Plan | null;
	priceId?: string | null;
	trialStart?: Date | null;
	trialEnd?: Date | null;
	currentPeriodStart?: Date | null;
	currentPeriodEnd?: Date | null;
	cancelAtPeriodEnd?: boolean;
	canceledAt?: Date | null;
	endedAt?: Date | null;
	couponId?: string | null;
	promotionCodeId?: string | null;
	percentOff?: number | null;
	/** The `created` time of the Stripe event carrying this state. */
	eventCreatedAt: Date;
}

export interface Subscription {
	stripeSubscriptionId: string;
	tenantId: string;
	status: string;
	plan: Plan | null;
	priceId: string | null;
	trialStart: Date | null;
	trialEnd: Date | null;
	currentPeriodStart: Date | null;
	currentPeriodEnd: Date | null;
	cancelAtPeriodEnd: boolean;
	canceledAt: Date | null;
	endedAt: Date | null;
	couponId: string | null;
	promotionCodeId: string | null;
	percentOff: number | null;
	lastEventCreatedAt: Date;
	createdAt: Date;
	updatedAt: Date;
}

const SUB_COLS =
	"stripe_subscription_id, tenant_id, status, plan, price_id, trial_start, trial_end, current_period_start, current_period_end, cancel_at_period_end, canceled_at, ended_at, coupon_id, promotion_code_id, percent_off, last_event_created_at, created_at, updated_at";

function toSubscription(r: Row): Subscription {
	return {
		stripeSubscriptionId: String(r.stripe_subscription_id),
		tenantId: String(r.tenant_id),
		status: String(r.status),
		plan: (r.plan as Plan | null) ?? null,
		priceId: strOrNull(r.price_id),
		trialStart: dateOrNull(r.trial_start),
		trialEnd: dateOrNull(r.trial_end),
		currentPeriodStart: dateOrNull(r.current_period_start),
		currentPeriodEnd: dateOrNull(r.current_period_end),
		cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
		canceledAt: dateOrNull(r.canceled_at),
		endedAt: dateOrNull(r.ended_at),
		couponId: strOrNull(r.coupon_id),
		promotionCodeId: strOrNull(r.promotion_code_id),
		percentOff: numOrNull(r.percent_off),
		lastEventCreatedAt: date(r.last_event_created_at),
		createdAt: date(r.created_at),
		updatedAt: date(r.updated_at),
	};
}

/**
 * Write the subscription state an event carries. An event older than the one
 * already applied is skipped (`applied` false), so late deliveries cannot
 * undo newer state. Events with the same `created` second apply in arrival
 * order.
 */
export async function upsertSubscription(db: Db, s: SubscriptionInput): Promise<{ applied: boolean }> {
	const rows = await db.query(
		`insert into subscriptions (stripe_subscription_id, tenant_id, status, plan, price_id, trial_start, trial_end,
		   current_period_start, current_period_end, cancel_at_period_end, canceled_at, ended_at,
		   coupon_id, promotion_code_id, percent_off, last_event_created_at)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
		 on conflict (stripe_subscription_id) do update set
		   tenant_id = excluded.tenant_id, status = excluded.status, plan = excluded.plan, price_id = excluded.price_id,
		   trial_start = excluded.trial_start, trial_end = excluded.trial_end,
		   current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
		   cancel_at_period_end = excluded.cancel_at_period_end, canceled_at = excluded.canceled_at, ended_at = excluded.ended_at,
		   coupon_id = excluded.coupon_id, promotion_code_id = excluded.promotion_code_id, percent_off = excluded.percent_off,
		   last_event_created_at = excluded.last_event_created_at, updated_at = now()
		 where subscriptions.last_event_created_at <= excluded.last_event_created_at
		 returning stripe_subscription_id`,
		[
			s.stripeSubscriptionId,
			s.tenantId,
			s.status,
			s.plan ?? null,
			s.priceId ?? null,
			s.trialStart ?? null,
			s.trialEnd ?? null,
			s.currentPeriodStart ?? null,
			s.currentPeriodEnd ?? null,
			s.cancelAtPeriodEnd ?? false,
			s.canceledAt ?? null,
			s.endedAt ?? null,
			s.couponId ?? null,
			s.promotionCodeId ?? null,
			s.percentOff ?? null,
			s.eventCreatedAt,
		],
	);
	return { applied: rows.length > 0 };
}

/** The tenant's newest subscription, or null. */
export async function getCurrentSubscription(db: Db, tenantId: string): Promise<Subscription | null> {
	const r = await one(db, `select ${SUB_COLS} from subscriptions where tenant_id = $1 order by created_at desc, last_event_created_at desc limit 1`, [tenantId]);
	return r ? toSubscription(r) : null;
}

export async function listSubscriptions(db: Db, tenantId: string): Promise<Subscription[]> {
	return (await db.query(`select ${SUB_COLS} from subscriptions where tenant_id = $1 order by created_at, last_event_created_at`, [tenantId])).map(toSubscription);
}

// ---- Stripe customer link ----

export async function setStripeCustomerId(db: Db, tenantId: string, stripeCustomerId: string): Promise<void> {
	await must(db, "update tenants set stripe_customer_id = $2 where id = $1 returning id", [tenantId, stripeCustomerId]);
}

export async function getTenantByStripeCustomerId(db: Db, stripeCustomerId: string): Promise<Tenant | null> {
	const r = await one(
		db,
		"select id, account_id, folder, status, stripe_customer_id, created_at, ready_at, retention_ends_at from tenants where stripe_customer_id = $1",
		[stripeCustomerId],
	);
	return r ? toTenant(r) : null;
}

// ---- invoices (revenue, conversion) ----

export interface InvoiceInput {
	stripeInvoiceId: string;
	tenantId: string;
	stripeSubscriptionId?: string | null;
	status: string;
	billingReason?: string | null;
	amountPaidCents: number;
	currency?: string;
	paidAt?: Date | null;
	periodStart?: Date | null;
	periodEnd?: Date | null;
}

export interface Invoice {
	stripeInvoiceId: string;
	tenantId: string;
	stripeSubscriptionId: string | null;
	status: string;
	billingReason: string | null;
	amountPaidCents: number;
	currency: string;
	paidAt: Date | null;
	periodStart: Date | null;
	periodEnd: Date | null;
}

function toInvoice(r: Row): Invoice {
	return {
		stripeInvoiceId: String(r.stripe_invoice_id),
		tenantId: String(r.tenant_id),
		stripeSubscriptionId: strOrNull(r.stripe_subscription_id),
		status: String(r.status),
		billingReason: strOrNull(r.billing_reason),
		amountPaidCents: num(r.amount_paid_cents),
		currency: String(r.currency),
		paidAt: dateOrNull(r.paid_at),
		periodStart: dateOrNull(r.period_start),
		periodEnd: dateOrNull(r.period_end),
	};
}

export async function upsertInvoice(db: Db, inv: InvoiceInput): Promise<void> {
	await db.query(
		`insert into invoices (stripe_invoice_id, tenant_id, stripe_subscription_id, status, billing_reason, amount_paid_cents, currency, paid_at, period_start, period_end)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		 on conflict (stripe_invoice_id) do update set
		   tenant_id = excluded.tenant_id, stripe_subscription_id = excluded.stripe_subscription_id, status = excluded.status,
		   billing_reason = excluded.billing_reason, amount_paid_cents = excluded.amount_paid_cents, currency = excluded.currency,
		   paid_at = excluded.paid_at, period_start = excluded.period_start, period_end = excluded.period_end, updated_at = now()`,
		[
			inv.stripeInvoiceId,
			inv.tenantId,
			inv.stripeSubscriptionId ?? null,
			inv.status,
			inv.billingReason ?? null,
			inv.amountPaidCents,
			inv.currency ?? "usd",
			inv.paidAt ?? null,
			inv.periodStart ?? null,
			inv.periodEnd ?? null,
		],
	);
}

export async function listInvoices(db: Db, tenantId: string): Promise<Invoice[]> {
	return (
		await db.query(
			`select stripe_invoice_id, tenant_id, stripe_subscription_id, status, billing_reason, amount_paid_cents, currency, paid_at, period_start, period_end
			 from invoices where tenant_id = $1 order by created_at, stripe_invoice_id`,
			[tenantId],
		)
	).map(toInvoice);
}

/** Amounts paid per tenant, by paid date, for the dashboard. Only tenants with payments appear. */
export async function revenueTotals(db: Db, range: { since?: Date; until?: Date }): Promise<{ tenantId: string; amountPaidCents: number }[]> {
	const rows = await db.query(
		`select tenant_id, sum(amount_paid_cents) as cents from invoices
		 where paid_at is not null and paid_at >= $1 and paid_at < $2 group by tenant_id order by tenant_id`,
		[range.since ?? new Date(0), range.until ?? new Date("9999-12-31T00:00:00Z")],
	);
	return rows.map((r) => ({ tenantId: String(r.tenant_id), amountPaidCents: num(r.cents) }));
}

// ---- trial claims (C2 req 2, D10) ----

/**
 * A keyed one-way hash of an email (HMAC-SHA256, hex), so the address cannot
 * be read back, and cannot be guessed from a list of addresses without the
 * key. Case and outer spaces are ignored. The key comes from a server
 * secret; changing it makes earlier claims unmatchable.
 */
export function hashEmailForTrial(email: string, key: string): string {
	if (!key) throw new Error("hashEmailForTrial needs a non-empty key");
	return createHmac("sha256", key).update(email.trim().toLowerCase()).digest("hex");
}

export interface TrialKeys {
	emailHash?: string;
	cardFingerprint?: string;
}

/** True if this email or this card already had a trial. */
export async function isTrialUsed(db: Db, keys: TrialKeys): Promise<boolean> {
	if (!keys.emailHash && !keys.cardFingerprint) return false;
	return (
		(await one(db, "select 1 from trial_claims where email_hash = $1 or card_fingerprint = $2 limit 1", [keys.emailHash ?? null, keys.cardFingerprint ?? null])) !==
		null
	);
}

/** Claim the one trial for this email and card. False, with nothing stored, if either already had one. */
export async function claimTrial(db: Db, keys: TrialKeys): Promise<boolean> {
	const rows = await db.query("insert into trial_claims (email_hash, card_fingerprint) values ($1, $2) on conflict do nothing returning id", [
		keys.emailHash ?? null,
		keys.cardFingerprint ?? null,
	]);
	return rows.length > 0;
}

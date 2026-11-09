/**
 * Billing numbers for the Owner's dashboard (P4-06, C7 req 2 and 6): plan,
 * status, coupon, revenue and trial-to-paid conversion, all from what the
 * Stripe webhooks stored. For w2-dashboard's tenant table.
 */
import { num } from "../db/db.ts";
import { type Db, type DashboardStatus, listTenantOverview } from "../db/index.ts";
import type { PlanId } from "../plans/index.ts";
import { STUDENT_COUPON_ID, TESTER_COUPON_ID } from "./config.ts";

export type CouponKind = "student" | "tester" | "other";

export interface TenantBilling {
	tenantId: string;
	plan: PlanId | null;
	status: DashboardStatus;
	coupon: CouponKind | null;
	couponId: string | null;
	percentOff: number | null;
	/** Paid in the range, in cents. */
	revenueCents: number;
	/** Had a trial that ran (a trial the front door refused at once does not count). */
	hadTrial: boolean;
	/** Paid at least once after a trial. Testers are not counted as trials. */
	convertedFromTrial: boolean;
}

export interface Range {
	since?: Date;
	until?: Date;
}

const FAR_PAST = new Date(0);
const FAR_FUTURE = new Date("9999-12-31T00:00:00Z");

export function couponKind(couponId: string | null): CouponKind | null {
	if (!couponId) return null;
	return couponId === STUDENT_COUPON_ID ? "student" : couponId === TESTER_COUPON_ID ? "tester" : "other";
}

/**
 * A trial "ran" unless its subscription ended within an hour of starting:
 * that is the front door refusing a repeat email or card (webhook.ts), which
 * cancels at once. The refusal reason itself lives in Stripe's metadata.
 */
const TRIAL_RAN = `s.trial_start is not null and not (s.ended_at is not null and s.ended_at < s.trial_start + interval '1 hour') and coalesce(s.coupon_id, '') <> $3`;

async function trialFacts(db: Db, range: Range): Promise<Map<string, { hadTrial: boolean; converted: boolean }>> {
	const rows = await db.query(
		`select t.id as tenant_id,
		   exists (select 1 from subscriptions s where s.tenant_id = t.id and ${TRIAL_RAN} and s.trial_start >= $1 and s.trial_start < $2) as had_trial,
		   exists (
		     select 1 from subscriptions s join invoices i on i.stripe_subscription_id = s.stripe_subscription_id
		     where s.tenant_id = t.id and ${TRIAL_RAN} and s.trial_start >= $1 and s.trial_start < $2
		       and i.status = 'paid' and i.amount_paid_cents > 0
		   ) as converted
		 from tenants t`,
		[range.since ?? FAR_PAST, range.until ?? FAR_FUTURE, TESTER_COUPON_ID],
	);
	return new Map(rows.map((r) => [String(r.tenant_id), { hadTrial: Boolean(r.had_trial), converted: Boolean(r.converted) }]));
}

async function revenue(db: Db, range: Range): Promise<Map<string, number>> {
	const rows = await db.query(
		`select tenant_id, coalesce(sum(amount_paid_cents), 0) as cents from invoices
		 where status = 'paid' and paid_at >= $1 and paid_at < $2 group by tenant_id`,
		[range.since ?? FAR_PAST, range.until ?? FAR_FUTURE],
	);
	return new Map(rows.map((r) => [String(r.tenant_id), num(r.cents)]));
}

/** One row per tenant: plan, status, coupon, revenue in the range, trial and conversion. */
export async function tenantBilling(db: Db, range: Range = {}): Promise<TenantBilling[]> {
	const [overview, paid, trials] = await Promise.all([listTenantOverview(db), revenue(db, range), trialFacts(db, range)]);
	return overview.map((o) => ({
		tenantId: o.tenantId,
		plan: o.plan === "three_month" ? "quarterly" : o.plan,
		status: o.dashboardStatus,
		coupon: couponKind(o.couponId),
		couponId: o.couponId,
		percentOff: o.percentOff,
		revenueCents: paid.get(o.tenantId) ?? 0,
		hadTrial: trials.get(o.tenantId)?.hadTrial ?? false,
		convertedFromTrial: trials.get(o.tenantId)?.converted ?? false,
	}));
}

/** Trial-to-paid conversion for trials that started in the range. Rate is null with no trials. */
export async function trialConversion(db: Db, range: Range = {}): Promise<{ trials: number; converted: number; rate: number | null }> {
	const facts = [...(await trialFacts(db, range)).values()];
	const trials = facts.filter((f) => f.hadTrial).length;
	const converted = facts.filter((f) => f.converted).length;
	return { trials, converted, rate: trials === 0 ? null : converted / trials };
}

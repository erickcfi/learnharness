/**
 * The Owner's thresholds (C3 req 5, C7 req 5) and the dashboard status view
 * (C7 req 2).
 */

import { date, dateOrNull, type Db, must, numOrNull, num, one, type Row, strOrNull } from "./db.ts";
import type { TenantStatus } from "./accounts.ts";
import type { Plan } from "./billing.ts";

// ---- Owner's thresholds ----

export interface OwnerSettings {
	/** Rolling 30-day model cost that opens an alert. Default $60. */
	alertUsd: number;
	/** Rolling 30-day model cost that pauses the tenant. Default $89. */
	autopauseUsd: number;
	updatedAt: Date;
	updatedBy: string | null;
}

const OWNER_COLS = "alert_usd, autopause_usd, updated_at, updated_by";

function toOwnerSettings(r: Row): OwnerSettings {
	return {
		alertUsd: num(r.alert_usd),
		autopauseUsd: num(r.autopause_usd),
		updatedAt: date(r.updated_at),
		updatedBy: strOrNull(r.updated_by),
	};
}

export async function getOwnerSettings(db: Db): Promise<OwnerSettings> {
	return toOwnerSettings(await must(db, `select ${OWNER_COLS} from owner_settings where id = 1`));
}

/** Change one or both thresholds. The alert must stay below autopause, or the update fails. */
export async function updateOwnerSettings(db: Db, patch: { alertUsd?: number; autopauseUsd?: number; updatedBy?: string }): Promise<OwnerSettings> {
	return toOwnerSettings(
		await must(
			db,
			`update owner_settings set alert_usd = coalesce($1::numeric, alert_usd), autopause_usd = coalesce($2::numeric, autopause_usd),
			   updated_at = now(), updated_by = $3 where id = 1 returning ${OWNER_COLS}`,
			[patch.alertUsd ?? null, patch.autopauseUsd ?? null, patch.updatedBy ?? null],
		),
	);
}

// ---- dashboard status (tenant_overview view) ----

export type DashboardStatus = "trial" | "active" | "paused" | "canceled" | "retention" | "none";

export interface TenantOverview {
	tenantId: string;
	accountId: string;
	lifecycleStatus: TenantStatus;
	retentionEndsAt: Date | null;
	stripeSubscriptionId: string | null;
	subscriptionStatus: string | null;
	plan: Plan | null;
	couponId: string | null;
	promotionCodeId: string | null;
	percentOff: number | null;
	trialEnd: Date | null;
	currentPeriodEnd: Date | null;
	cancelAtPeriodEnd: boolean;
	paused: boolean;
	dashboardStatus: DashboardStatus;
}

const OVERVIEW_COLS =
	"tenant_id, account_id, lifecycle_status, retention_ends_at, stripe_subscription_id, subscription_status, plan, coupon_id, promotion_code_id, percent_off, trial_end, current_period_end, cancel_at_period_end, paused, dashboard_status";

function toOverview(r: Row): TenantOverview {
	return {
		tenantId: String(r.tenant_id),
		accountId: String(r.account_id),
		lifecycleStatus: r.lifecycle_status as TenantStatus,
		retentionEndsAt: dateOrNull(r.retention_ends_at),
		stripeSubscriptionId: strOrNull(r.stripe_subscription_id),
		subscriptionStatus: strOrNull(r.subscription_status),
		plan: (r.plan as Plan | null) ?? null,
		couponId: strOrNull(r.coupon_id),
		promotionCodeId: strOrNull(r.promotion_code_id),
		percentOff: numOrNull(r.percent_off),
		trialEnd: dateOrNull(r.trial_end),
		currentPeriodEnd: dateOrNull(r.current_period_end),
		cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
		paused: Boolean(r.paused),
		dashboardStatus: r.dashboard_status as DashboardStatus,
	};
}

export async function listTenantOverview(db: Db): Promise<TenantOverview[]> {
	return (await db.query(`select ${OVERVIEW_COLS} from tenant_overview order by tenant_id`)).map(toOverview);
}

export async function getTenantOverview(db: Db, tenantId: string): Promise<TenantOverview | null> {
	const r = await one(db, `select ${OVERVIEW_COLS} from tenant_overview where tenant_id = $1`, [tenantId]);
	return r ? toOverview(r) : null;
}

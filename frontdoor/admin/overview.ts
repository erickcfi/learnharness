/**
 * The dashboard's tenant table and totals (P3-03, C7 req 2 and 6).
 *
 * One row per student. Each number has one source (C7 req 6):
 *  - plan, status, coupon, revenue, conversion: Stripe webhooks, stored in
 *    subscriptions and invoices (W2-8 fills them; until then the page says
 *    "After billing is connected");
 *  - model cost, unpriced calls, searches and fees, alerts, pause state: the
 *    meter (model_usage, search_usage, alerts, pauses);
 *  - study time and sessions: the front door (study_time, PD1);
 *  - topics and non-aviation flags: topic_labels (N7).
 */
import {
	type Alert,
	type DashboardStatus,
	type Db,
	listOpenAlerts,
	listTenantOverview,
	type Plan,
	revenueTotals,
	type Role,
	usageTotals,
} from "../db/index.ts";
import { studyByTenant } from "../study-time/queries.ts";
import { noDirectory, type StudentDirectory } from "./directory.ts";
import { DASHBOARD_TIME_ZONE, type PeriodKey, periodRange } from "./period.ts";

export type Conversion = "converted" | "in-trial" | "not-converted" | "no-trial";

export interface TenantRow {
	tenantId: string;
	/** First 8 characters of the tenant id, when no name is known. */
	shortId: string;
	name: string | null;
	email: string | null;
	/** Owner or staff accounts that also study. Empty for students. */
	roles: Role[];
	status: DashboardStatus;
	paused: boolean;
	plan: Plan | null;
	/** Promotion code or coupon, with its percent off, for example "20% off". Null when none. */
	coupon: string | null;
	modelCostUsd: number;
	modelCalls: number;
	/** Calls to a model missing from the price list: stored with no dollar amount. */
	unpricedCalls: number;
	searchCount: number;
	searchFeeUsd: number;
	/** Model cost plus search fees. */
	costUsd: number;
	revenueUsd: number;
	studySeconds: number;
	sessions: number;
	conversion: Conversion;
	/** Open alert kinds: cost_alert, autopause. */
	alerts: Alert["kind"][];
	/** Sessions labeled not aviation (N7). */
	nonAviationSessions: number;
	/** The newest labeled session titles. */
	recentTopics: string[];
	createdAt: Date;
}

export interface OverviewTotals {
	students: number;
	byStatus: Record<DashboardStatus, number>;
	modelCostUsd: number;
	searchFeeUsd: number;
	costUsd: number;
	revenueUsd: number;
	/** Revenue minus cost. */
	marginUsd: number;
	unpricedCalls: number;
	searchCount: number;
	studySeconds: number;
	sessions: number;
	trialsEnded: number;
	converted: number;
	/** Converted / trials ended, 0 to 1; null before any trial has ended. */
	conversionRate: number | null;
	openAlerts: number;
	nonAviationSessions: number;
}

export interface Overview {
	period: PeriodKey;
	since: Date;
	until: Date;
	timeZone: string;
	/** False until W2-8 stores Stripe data: plan, coupon, revenue and conversion are then blank. */
	billingConnected: boolean;
	totals: OverviewTotals;
	rows: TenantRow[];
	openAlerts: Alert[];
}

export interface OverviewOptions {
	period: PeriodKey;
	now?: Date;
	timeZone?: string;
	directory?: StudentDirectory;
	/** W2-8 sets this. Default: true once any subscription or invoice is stored. */
	billingConnected?: boolean;
	/** Only these tenants (the student page). */
	tenantIds?: readonly string[];
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
const ALL_STATUSES: DashboardStatus[] = ["trial", "active", "paused", "canceled", "retention", "none"];

interface TenantMeta {
	clerkUserId: string;
	roles: Role[];
	createdAt: Date;
	trialStarted: boolean;
	trialEnded: boolean;
	paid: boolean;
	nonAviation: number;
	recentTopics: string[];
}

async function tenantMeta(db: Db, now: Date): Promise<Map<string, TenantMeta>> {
	const rows = await db.query(
		`select t.id as tenant_id, a.clerk_user_id, t.created_at,
		        coalesce((select string_agg(r.role, ',' order by r.role) from account_roles r where r.account_id = a.id), '') as roles,
		        exists (select 1 from subscriptions s where s.tenant_id = t.id and s.trial_start is not null) as trial_started,
		        exists (select 1 from subscriptions s where s.tenant_id = t.id and s.trial_end is not null and s.trial_end <= $1) as trial_ended,
		        exists (select 1 from invoices i where i.tenant_id = t.id and i.status = 'paid' and i.amount_paid_cents > 0) as paid,
		        (select count(*) from topic_labels l where l.tenant_id = t.id and l.is_aviation = false) as non_aviation,
		        coalesce((select string_agg(x.topic, E'\\n') from (select topic from topic_labels l where l.tenant_id = t.id and l.is_aviation is not null order by l.labeled_at desc limit 3) x), '') as topics
		 from tenants t join accounts a on a.id = t.account_id`,
		[now],
	);
	const out = new Map<string, TenantMeta>();
	for (const r of rows) {
		out.set(String(r.tenant_id), {
			clerkUserId: String(r.clerk_user_id),
			roles: String(r.roles ?? "")
				.split(",")
				.filter((x): x is Role => x === "owner" || x === "staff"),
			createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
			trialStarted: Boolean(r.trial_started),
			trialEnded: Boolean(r.trial_ended),
			paid: Boolean(r.paid),
			nonAviation: num(r.non_aviation),
			recentTopics: String(r.topics ?? "")
				.split("\n")
				.map((s) => s.split(" | ")[0]?.trim() ?? "")
				.filter(Boolean),
		});
	}
	return out;
}

async function billingDataExists(db: Db): Promise<boolean> {
	const rows = await db.query("select (exists (select 1 from subscriptions) or exists (select 1 from invoices)) as any");
	return Boolean(rows[0]?.any);
}

function couponLabel(o: { promotionCodeId: string | null; couponId: string | null; percentOff: number | null }): string | null {
	if (!o.promotionCodeId && !o.couponId) return null;
	if (o.percentOff !== null) return `${Number(o.percentOff.toFixed(2))}% off`;
	return o.promotionCodeId ?? o.couponId;
}

function conversionOf(m: TenantMeta | undefined): Conversion {
	if (!m?.trialStarted) return m?.paid ? "converted" : "no-trial";
	if (m.paid) return "converted";
	return m.trialEnded ? "not-converted" : "in-trial";
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export async function buildOverview(db: Db, options: OverviewOptions): Promise<Overview> {
	const now = options.now ?? new Date();
	const timeZone = options.timeZone ?? DASHBOARD_TIME_ZONE;
	const { since, until } = periodRange(options.period, now, timeZone);
	const [overview, usage, revenue, study, meta, openAlerts, billingConnected] = await Promise.all([
		listTenantOverview(db),
		usageTotals(db, { since, until }),
		revenueTotals(db, { since, until }),
		studyByTenant(db, { since, until }),
		tenantMeta(db, now),
		listOpenAlerts(db),
		options.billingConnected ?? billingDataExists(db),
	]);
	const only = options.tenantIds ? new Set(options.tenantIds) : null;
	const tenants = overview.filter((o) => !only || only.has(o.tenantId));
	const usageBy = new Map(usage.map((u) => [u.tenantId, u]));
	const revenueBy = new Map(revenue.map((r) => [r.tenantId, r.amountPaidCents]));
	const alertsBy = new Map<string, Alert["kind"][]>();
	for (const a of openAlerts) alertsBy.set(a.tenantId, [...(alertsBy.get(a.tenantId) ?? []), a.kind]);
	const names = await (options.directory ?? noDirectory).lookup(tenants.map((o) => meta.get(o.tenantId)?.clerkUserId).filter((x): x is string => !!x));

	const rows: TenantRow[] = tenants.map((o) => {
		const m = meta.get(o.tenantId);
		const u = usageBy.get(o.tenantId);
		const s = study.get(o.tenantId);
		const who = m ? names.get(m.clerkUserId) : undefined;
		const modelCostUsd = round6(u?.modelCostUsd ?? 0);
		const searchFeeUsd = round6(u?.searchFeeUsd ?? 0);
		return {
			tenantId: o.tenantId,
			shortId: o.tenantId.slice(0, 8),
			name: who?.name ?? null,
			email: who?.email ?? null,
			roles: m?.roles ?? [],
			status: o.dashboardStatus,
			paused: o.paused,
			plan: o.plan,
			coupon: couponLabel(o),
			modelCostUsd,
			modelCalls: u?.modelCalls ?? 0,
			unpricedCalls: u?.unpricedCalls ?? 0,
			searchCount: u?.searchCount ?? 0,
			searchFeeUsd,
			costUsd: round6(modelCostUsd + searchFeeUsd),
			revenueUsd: (revenueBy.get(o.tenantId) ?? 0) / 100,
			studySeconds: s?.activeSeconds ?? 0,
			sessions: s?.sessions ?? 0,
			conversion: conversionOf(m),
			alerts: alertsBy.get(o.tenantId) ?? [],
			nonAviationSessions: m?.nonAviation ?? 0,
			recentTopics: m?.recentTopics ?? [],
			createdAt: m?.createdAt ?? new Date(0),
		};
	});
	// Alerts first, then paused, then the costliest.
	rows.sort((a, b) => b.alerts.length - a.alerts.length || Number(b.paused) - Number(a.paused) || b.costUsd - a.costUsd || a.tenantId.localeCompare(b.tenantId));

	const byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<DashboardStatus, number>;
	for (const r of rows) byStatus[r.status] += 1;
	const sum = (f: (r: TenantRow) => number) => rows.reduce((acc, r) => acc + f(r), 0);
	const trialsEnded = rows.filter((r) => r.conversion === "converted" || r.conversion === "not-converted").filter((r) => meta.get(r.tenantId)?.trialStarted).length;
	const converted = rows.filter((r) => r.conversion === "converted" && meta.get(r.tenantId)?.trialStarted).length;
	const costUsd = round6(sum((r) => r.costUsd));
	const revenueUsd = round6(sum((r) => r.revenueUsd));
	return {
		period: options.period,
		since,
		until,
		timeZone,
		billingConnected,
		totals: {
			students: rows.length,
			byStatus,
			modelCostUsd: round6(sum((r) => r.modelCostUsd)),
			searchFeeUsd: round6(sum((r) => r.searchFeeUsd)),
			costUsd,
			revenueUsd,
			marginUsd: round6(revenueUsd - costUsd),
			unpricedCalls: sum((r) => r.unpricedCalls),
			searchCount: sum((r) => r.searchCount),
			studySeconds: sum((r) => r.studySeconds),
			sessions: sum((r) => r.sessions),
			trialsEnded,
			converted,
			conversionRate: trialsEnded > 0 ? converted / trialsEnded : null,
			openAlerts: openAlerts.filter((a) => !only || only.has(a.tenantId)).length,
			nonAviationSessions: sum((r) => r.nonAviationSessions),
		},
		rows,
		openAlerts: openAlerts.filter((a) => !only || only.has(a.tenantId)),
	};
}

/**
 * Metered usage, search counts, alerts and pause state (C3 req 4 to 7,
 * D15, D16, D29, X2). The metering proxy writes the rows; the dashboard reads
 * them.
 */

import { date, dateOrNull, type Db, must, num, numOrNull, one, type Row, strOrNull } from "./db.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tavily's fee per basic search (C3 req 7, K5). */
export const TAVILY_SEARCH_FEE_USD = 0.008;

// ---- model usage (C3 req 4) ----

export interface ModelUsageInput {
	tenantId: string;
	occurredAt?: Date;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	/** All cache-write tokens. */
	cacheWriteTokens: number;
	/** The part of cacheWriteTokens written with the 1-hour lifetime. Default 0. */
	cacheWrite1hTokens?: number;
	/** Dollars at list price for this call, or null when the model has no list price. */
	costUsd: number | null;
	/** The provider's request or message ID, so a retried record is not counted twice. */
	requestId?: string;
	/** True when the call went out with the student's own Anthropic key (own_key, migration 20261113000100). Default false. */
	ownKey?: boolean;
}

/**
 * Which model cost to add up (2026-11-13, docs/decisions/2026-11-13-own-ai-key.md):
 *   all         every priced call (the trial's cost cap, as before)
 *   north-aero  calls sent with North Aero's key (the alert and autopause, the dashboard's cost)
 *   own-key     calls sent with the student's own key (the dashboard's "Own key" spend)
 */
export type CostScope = "all" | "north-aero" | "own-key";

/**
 * The Postgres codes for a missing table (42P01) or column (42703). Before
 * the own-key migration is applied, own_key and own_ai_keys do not exist;
 * then no call can have used an own key, so the reads below fall back to
 * the old queries and the meter keeps working.
 */
export function isMissingOwnKeySchema(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "42P01" || code === "42703";
}

export interface ModelUsage {
	id: number;
	tenantId: string;
	occurredAt: Date;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheWrite1hTokens: number;
	/** Null means unpriced. */
	costUsd: number | null;
	requestId: string | null;
}

function toModelUsage(r: Row): ModelUsage {
	return {
		id: num(r.id),
		tenantId: String(r.tenant_id),
		occurredAt: date(r.occurred_at),
		model: String(r.model),
		inputTokens: num(r.input_tokens),
		outputTokens: num(r.output_tokens),
		cacheReadTokens: num(r.cache_read_tokens),
		cacheWriteTokens: num(r.cache_write_tokens),
		cacheWrite1hTokens: num(r.cache_write_1h_tokens),
		costUsd: numOrNull(r.cost_usd),
		requestId: strOrNull(r.request_id),
	};
}

/**
 * Store one metered call. `recorded` is false when the request ID was already stored.
 * own_key is named only for an own-key call, so North Aero's calls are
 * stored the same way before and after the own-key migration.
 */
export async function recordModelUsage(db: Db, u: ModelUsageInput): Promise<{ recorded: boolean }> {
	const own = u.ownKey === true;
	const rows = await db.query(
		`insert into model_usage (tenant_id, occurred_at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, cost_usd, request_id${own ? ", own_key" : ""})
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10${own ? ", true" : ""})
		 on conflict (request_id) do nothing returning id`,
		[
			u.tenantId,
			u.occurredAt ?? new Date(),
			u.model,
			u.inputTokens,
			u.outputTokens,
			u.cacheReadTokens,
			u.cacheWriteTokens,
			u.cacheWrite1hTokens ?? 0,
			u.costUsd,
			u.requestId ?? null,
		],
	);
	return { recorded: rows.length > 0 };
}

export async function listModelUsage(db: Db, tenantId: string, opts: { since?: Date; limit?: number } = {}): Promise<ModelUsage[]> {
	return (
		await db.query(
			`select id, tenant_id, occurred_at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, cost_usd, request_id
			 from model_usage where tenant_id = $1 and occurred_at >= $2 order by occurred_at, id limit $3`,
			[tenantId, opts.since ?? new Date(0), opts.limit ?? 1000],
		)
	).map(toModelUsage);
}

const SCOPE_FILTER: Record<CostScope, string> = { all: "", "north-aero": " and not own_key", "own-key": " and own_key" };

/** Model dollars from `since` up to and including `until`, for one scope (default all). Unpriced calls add nothing. */
export async function modelCostSince(db: Db, tenantId: string, since: Date, until: Date = new Date(), scope: CostScope = "all"): Promise<number> {
	try {
		const r = await must(
			db,
			`select coalesce(sum(cost_usd), 0) as total from model_usage where tenant_id = $1 and occurred_at > $2 and occurred_at <= $3${SCOPE_FILTER[scope]}`,
			[tenantId, since, until],
		);
		return num(r.total);
	} catch (error) {
		// Before the own-key migration every call is North Aero's.
		if (scope === "all" || !isMissingOwnKeySchema(error)) throw error;
		return scope === "own-key" ? 0 : modelCostSince(db, tenantId, since, until, "all");
	}
}

/** The rolling window the alert and autopause use (D15): the last `days` days up to `now`. */
export async function rollingModelCost(db: Db, tenantId: string, now: Date = new Date(), days = 30, scope: CostScope = "all"): Promise<number> {
	return modelCostSince(db, tenantId, new Date(now.getTime() - days * DAY_MS), now, scope);
}

// ---- search counts (C3 req 7) ----

/** Store one search the provider answered. The fee defaults to Tavily's basic-search price. */
export async function recordSearch(db: Db, s: { tenantId: string; feeUsd?: number; occurredAt?: Date; provider?: string }): Promise<void> {
	await db.query("insert into search_usage (tenant_id, occurred_at, provider, fee_usd) values ($1, $2, $3, $4)", [
		s.tenantId,
		s.occurredAt ?? new Date(),
		s.provider ?? "tavily",
		s.feeUsd ?? TAVILY_SEARCH_FEE_USD,
	]);
}

export async function searchUsageSince(db: Db, tenantId: string, since: Date): Promise<{ count: number; feeUsd: number }> {
	const r = await must(db, "select count(*) as n, coalesce(sum(fee_usd), 0) as fee from search_usage where tenant_id = $1 and occurred_at >= $2", [
		tenantId,
		since,
	]);
	return { count: num(r.n), feeUsd: num(r.fee) };
}

export interface UsageTotal {
	tenantId: string;
	/** Priced calls only, sent with North Aero's key. Own-key calls are in ownKeyUsageTotals. */
	modelCostUsd: number;
	/** Calls sent with North Aero's key. */
	modelCalls: number;
	/** Calls stored with no dollar amount (model missing from the price list). */
	unpricedCalls: number;
	searchCount: number;
	searchFeeUsd: number;
}

function usageTotalsSql(ownKeyColumn: boolean): string {
	return `select t.id as tenant_id,
		        coalesce(m.cost, 0) as model_cost, coalesce(m.calls, 0) as model_calls, coalesce(m.unpriced, 0) as unpriced_calls,
		        coalesce(s.n, 0) as search_count, coalesce(s.fee, 0) as search_fee
		 from tenants t
		 left join (select tenant_id, sum(cost_usd) as cost, count(*) as calls, count(*) filter (where cost_usd is null) as unpriced from model_usage
		            where occurred_at >= $1 and occurred_at < $2${ownKeyColumn ? " and not own_key" : ""} group by tenant_id) m on m.tenant_id = t.id
		 left join (select tenant_id, count(*) as n, sum(fee_usd) as fee from search_usage
		            where occurred_at >= $1 and occurred_at < $2 group by tenant_id) s on s.tenant_id = t.id
		 order by t.created_at, t.id`;
}

/** North Aero's model cost and search fees per tenant, for the dashboard. Every tenant gets a row. */
export async function usageTotals(db: Db, range: { since?: Date; until?: Date } = {}): Promise<UsageTotal[]> {
	const params = [range.since ?? new Date(0), range.until ?? new Date("9999-12-31T00:00:00Z")];
	let rows: Row[];
	try {
		rows = await db.query(usageTotalsSql(true), params);
	} catch (error) {
		// Before the own-key migration every call is North Aero's.
		if (!isMissingOwnKeySchema(error)) throw error;
		rows = await db.query(usageTotalsSql(false), params);
	}
	return rows.map((r) => ({
		tenantId: String(r.tenant_id),
		modelCostUsd: num(r.model_cost),
		modelCalls: num(r.model_calls),
		unpricedCalls: num(r.unpriced_calls),
		searchCount: num(r.search_count),
		searchFeeUsd: num(r.search_fee),
	}));
}

export interface OwnKeyUsageTotal {
	/** List-price dollars of the calls sent with the student's own key. The student pays Anthropic for them. */
	costUsd: number;
	calls: number;
}

/** Own-key model cost and calls per tenant in the range. Tenants with none are left out. Empty before the own-key migration. */
export async function ownKeyUsageTotals(db: Db, range: { since?: Date; until?: Date } = {}): Promise<Map<string, OwnKeyUsageTotal>> {
	let rows: Row[];
	try {
		rows = await db.query(
			`select tenant_id, coalesce(sum(cost_usd), 0) as cost, count(*) as calls from model_usage
			 where own_key and occurred_at >= $1 and occurred_at < $2 group by tenant_id`,
			[range.since ?? new Date(0), range.until ?? new Date("9999-12-31T00:00:00Z")],
		);
	} catch (error) {
		if (!isMissingOwnKeySchema(error)) throw error;
		rows = [];
	}
	return new Map(rows.map((r) => [String(r.tenant_id), { costUsd: num(r.cost), calls: num(r.calls) }]));
}

// ---- alerts (C3 req 5, D15) ----

export type AlertKind = "cost_alert" | "autopause";

export interface Alert {
	id: number;
	tenantId: string;
	kind: AlertKind;
	thresholdUsd: number;
	windowCostUsd: number;
	createdAt: Date;
	clearedAt: Date | null;
	clearedBy: string | null;
}

const ALERT_COLS = "id, tenant_id, kind, threshold_usd, window_cost_usd, created_at, cleared_at, cleared_by";

function toAlert(r: Row): Alert {
	return {
		id: num(r.id),
		tenantId: String(r.tenant_id),
		kind: r.kind as AlertKind,
		thresholdUsd: num(r.threshold_usd),
		windowCostUsd: num(r.window_cost_usd),
		createdAt: date(r.created_at),
		clearedAt: dateOrNull(r.cleared_at),
		clearedBy: strOrNull(r.cleared_by),
	};
}

/**
 * Open an alert. While one of this kind is open for the tenant, no second one
 * is made: `created` is false and the open alert comes back.
 */
export async function openAlert(
	db: Db,
	a: { tenantId: string; kind: AlertKind; thresholdUsd: number; windowCostUsd: number; at?: Date },
): Promise<{ alert: Alert; created: boolean }> {
	return db.transaction(async (tx) => {
		const inserted = await one(
			tx,
			`insert into alerts (tenant_id, kind, threshold_usd, window_cost_usd, created_at) values ($1, $2, $3, $4, $5)
			 on conflict (tenant_id, kind) where cleared_at is null do nothing returning ${ALERT_COLS}`,
			[a.tenantId, a.kind, a.thresholdUsd, a.windowCostUsd, a.at ?? new Date()],
		);
		if (inserted) return { alert: toAlert(inserted), created: true };
		const open = await must(tx, `select ${ALERT_COLS} from alerts where tenant_id = $1 and kind = $2 and cleared_at is null`, [a.tenantId, a.kind]);
		return { alert: toAlert(open), created: false };
	});
}

/** The Owner clears an alert. False if it was already cleared or not found. */
export async function clearAlert(db: Db, alertId: number, clearedBy?: string, at: Date = new Date()): Promise<boolean> {
	return (await db.query("update alerts set cleared_at = $2, cleared_by = $3 where id = $1 and cleared_at is null returning id", [alertId, at, clearedBy ?? null]))
		.length > 0;
}

export async function listOpenAlerts(db: Db): Promise<Alert[]> {
	return (await db.query(`select ${ALERT_COLS} from alerts where cleared_at is null order by created_at, id`)).map(toAlert);
}

export async function listAlerts(db: Db, tenantId: string): Promise<Alert[]> {
	return (await db.query(`select ${ALERT_COLS} from alerts where tenant_id = $1 order by created_at, id`, [tenantId])).map(toAlert);
}

// ---- pause state (C3 req 6, D16) ----

export type PauseReason = "autopause" | "owner";

export interface Pause {
	id: number;
	tenantId: string;
	reason: PauseReason;
	pausedAt: Date;
	pausedBy: string | null;
	unpausedAt: Date | null;
	unpausedBy: string | null;
}

const PAUSE_COLS = "id, tenant_id, reason, paused_at, paused_by, unpaused_at, unpaused_by";

function toPause(r: Row): Pause {
	return {
		id: num(r.id),
		tenantId: String(r.tenant_id),
		reason: r.reason as PauseReason,
		pausedAt: date(r.paused_at),
		pausedBy: strOrNull(r.paused_by),
		unpausedAt: dateOrNull(r.unpaused_at),
		unpausedBy: strOrNull(r.unpaused_by),
	};
}

/** Pause the tenant. If it is already paused, `created` is false and the open pause comes back. */
export async function pauseTenant(
	db: Db,
	p: { tenantId: string; reason: PauseReason; pausedBy?: string; at?: Date },
): Promise<{ pause: Pause; created: boolean }> {
	return db.transaction(async (tx) => {
		const inserted = await one(
			tx,
			`insert into pauses (tenant_id, reason, paused_by, paused_at) values ($1, $2, $3, $4)
			 on conflict (tenant_id) where unpaused_at is null do nothing returning ${PAUSE_COLS}`,
			[p.tenantId, p.reason, p.pausedBy ?? null, p.at ?? new Date()],
		);
		if (inserted) return { pause: toPause(inserted), created: true };
		return { pause: toPause(await must(tx, `select ${PAUSE_COLS} from pauses where tenant_id = $1 and unpaused_at is null`, [p.tenantId])), created: false };
	});
}

/** The Owner unpauses. False if the tenant was not paused. */
export async function unpauseTenant(db: Db, u: { tenantId: string; unpausedBy?: string; at?: Date }): Promise<boolean> {
	return (
		await db.query("update pauses set unpaused_at = $2, unpaused_by = $3 where tenant_id = $1 and unpaused_at is null returning id", [
			u.tenantId,
			u.at ?? new Date(),
			u.unpausedBy ?? null,
		])
	).length > 0;
}

export async function getOpenPause(db: Db, tenantId: string): Promise<Pause | null> {
	const r = await one(db, `select ${PAUSE_COLS} from pauses where tenant_id = $1 and unpaused_at is null`, [tenantId]);
	return r ? toPause(r) : null;
}

export async function isPaused(db: Db, tenantId: string): Promise<boolean> {
	return (await getOpenPause(db, tenantId)) !== null;
}

export async function listPauses(db: Db, tenantId: string): Promise<Pause[]> {
	return (await db.query(`select ${PAUSE_COLS} from pauses where tenant_id = $1 order by paused_at, id`, [tenantId])).map(toPause);
}

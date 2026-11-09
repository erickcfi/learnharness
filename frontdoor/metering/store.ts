/**
 * Metering storage (P2-01, P2-02; C3 requirements 4, 6 and 7).
 *
 * The proxy writes through this small interface. The in-memory adapter
 * serves tests and local runs. A Supabase adapter will implement the same
 * interface on the tables from w1-database (PD5).
 */

/** Token counts for one model call, named as upstream's CallUsage (src/core/contracts.ts). */
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	/** All cache-write tokens, 5-minute and 1-hour together. */
	cacheWriteTokens: number;
	/** The part of cacheWriteTokens written with 1-hour retention, which costs more. */
	cacheWrite1hTokens: number;
}

/** One metered model call (C3 requirement 4). */
export interface CallRecord extends TokenUsage {
	tenantId: string;
	/** When the call finished at the proxy. */
	at: Date;
	/** The Anthropic model id the tenant asked for, such as "claude-opus-5-5". */
	model: string;
	/** Dollars at list price. null means unpriced: the price list has no rate for the model. */
	dollars: number | null;
	/** Unique per call: Anthropic's request-id header, else the message id, else an id the proxy made. */
	requestId: string;
}

/** One counted Tavily search (C3 requirement 7). */
export interface SearchRecord {
	tenantId: string;
	at: Date;
}

export interface MeteringStore {
	recordCall(call: CallRecord): Promise<void>;
	recordSearch(search: SearchRecord): Promise<void>;
	/** A paused tenant's calls and searches are refused (C3 requirement 6). */
	isPaused(tenantId: string): Promise<boolean>;
}

/** The in-memory adapter, with reads and a pause switch for tests and local runs. */
export interface MemoryMeteringStore extends MeteringStore {
	/** Recorded calls in order, for one tenant or all. */
	calls(tenantId?: string): CallRecord[];
	/** Counted searches in order, for one tenant or all. */
	searches(tenantId?: string): SearchRecord[];
	setPaused(tenantId: string, paused: boolean): void;
}

export function createMemoryMeteringStore(): MemoryMeteringStore {
	const calls: CallRecord[] = [];
	const searches: SearchRecord[] = [];
	const paused = new Set<string>();
	const forTenant = <T extends { tenantId: string }>(rows: T[], tenantId?: string) =>
		rows.filter((row) => tenantId === undefined || row.tenantId === tenantId).map((row) => ({ ...row }));
	return {
		async recordCall(call) {
			calls.push({ ...call });
		},
		async recordSearch(search) {
			searches.push({ ...search });
		},
		async isPaused(tenantId) {
			return paused.has(tenantId);
		},
		calls: (tenantId) => forTenant(calls, tenantId),
		searches: (tenantId) => forTenant(searches, tenantId),
		setPaused(tenantId, value) {
			if (value) paused.add(tenantId);
			else paused.delete(tenantId);
		},
	};
}

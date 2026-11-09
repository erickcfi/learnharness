/**
 * Reads one tenant's study record source from that tenant's own
 * LearnHarness server (read-only GETs: /api/chats, /api/chats/<id>,
 * /api/graph; see frontdoor/records).
 *
 * Every read goes through a TenantFetch: the shape of w2-isolation's
 * supervisor.tenantFetch(tenantId, path, init), which adds the tenant
 * server's own secret (tenant servers refuse requests without it). The
 * master wires the real one at merge. Until then, tenantFetchStandIn()
 * starts the server if needed and calls it on 127.0.0.1.
 */
import { fetchRecordSource, type RecordSource } from "../records/upstream.ts";

export const RECORD_READ_TIMEOUT_MS = 30_000;

/** w2-isolation's supervisor.tenantFetch shape. `path` starts with "/". */
export type TenantFetch = (tenantId: string, path: string, init?: RequestInit) => Promise<Response>;

/** Reads one tenant's record source (the report loop's dependency). */
export type TenantRecordReader = (tenantId: string) => Promise<RecordSource>;

export function createTenantRecordReader(tenantFetch: TenantFetch, timeoutMs = RECORD_READ_TIMEOUT_MS): TenantRecordReader {
	return (tenantId) => {
		const signal = AbortSignal.timeout(timeoutMs);
		// An empty base: fetchRecordSource then asks for the bare paths.
		return fetchRecordSource("", (path, init) => tenantFetch(tenantId, path, { ...init, signal }));
	};
}

/** Until w2-isolation merges: start the tenant's server if needed, then call it on 127.0.0.1. */
export function tenantFetchStandIn(ensureRunning: (tenantId: string) => Promise<number>, fetchImpl: typeof fetch = fetch): TenantFetch {
	return async (tenantId, path, init) => fetchImpl(`http://127.0.0.1:${await ensureRunning(tenantId)}${path}`, init);
}

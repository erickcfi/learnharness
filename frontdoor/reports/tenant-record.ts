/**
 * Reads one tenant's study record source from that tenant's own
 * LearnHarness server on 127.0.0.1 (read-only GETs: /api/chats,
 * /api/chats/<id>, /api/graph; see frontdoor/records).
 *
 * `headers` adds per-tenant request headers. After w2-isolation lands, the
 * front door adds each tenant server's own secret to every request; the
 * wiring passes that header here too, so these reads keep working.
 */
import { fetchRecordSource } from "../records/upstream.ts";
import type { TenantRecordReader } from "./runner.ts";

export const RECORD_READ_TIMEOUT_MS = 30_000;

export interface TenantRecordReaderDeps {
	/** Starts the tenant's server if needed; resolves to its port (tenants/supervisor.ts). */
	ensureRunning(tenantId: string): Promise<number>;
	/** Extra headers for this tenant's server. */
	headers?: (tenantId: string) => Record<string, string>;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

export function createTenantRecordReader(deps: TenantRecordReaderDeps): TenantRecordReader {
	const doFetch = deps.fetchImpl ?? fetch;
	return async (tenantId) => {
		const port = await deps.ensureRunning(tenantId);
		const extra = deps.headers?.(tenantId) ?? {};
		const signal = AbortSignal.timeout(deps.timeoutMs ?? RECORD_READ_TIMEOUT_MS);
		return fetchRecordSource(`http://127.0.0.1:${port}`, (input, init) => doFetch(input, { ...init, headers: { ...init?.headers, ...extra }, signal }));
	};
}

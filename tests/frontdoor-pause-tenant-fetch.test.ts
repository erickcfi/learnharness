import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { supervisorFetch } from "../frontdoor/pause/data-safety.ts";

// W2-6 wall A + W2-7: the export, record and day-91 reads of a tenant's
// server must go through the supervisor's tenantFetch, which adds that
// tenant's secret. A tenant server refuses any request without it.
describe("pause and retention reads of a tenant server", () => {
	it("use the supervisor's tenantFetch (with the tenant's secret) when it has one", async () => {
		const calls: { tenantId: string; path: string; accept: string | null; signal: boolean }[] = [];
		let ensureRunningCalls = 0;
		const fetchTenant = supervisorFetch({
			ensureRunning: async () => {
				ensureRunningCalls++;
				return 1;
			},
			tenantFetch: async (tenantId, path, init) => {
				calls.push({ tenantId, path, accept: new Headers(init?.headers).get("accept"), signal: init?.signal instanceof AbortSignal });
				return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
			},
		});
		const response = await fetchTenant("tenant-a", "/api/graph");
		assert.equal(response.status, 200);
		assert.deepEqual(calls.map(({ tenantId, path }) => ({ tenantId, path })), [{ tenantId: "tenant-a", path: "/api/graph" }]);
		assert.match(calls[0]!.accept ?? "", /application\/json/);
		assert.equal(calls[0]!.signal, true, "a timeout signal is passed");
		assert.equal(ensureRunningCalls, 0, "no direct 127.0.0.1 call when tenantFetch exists");
	});
});

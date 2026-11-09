/**
 * C3 acceptance: a background research job's cost lands on the tenant that
 * started it (P2-01, D29).
 *
 * This process is tenant A's server: upstream's real job runner runs a
 * research job on the real engine factory, with A's pass key and the proxy
 * address in its environment, the way the front door starts each tenant.
 * Tenant B's server runs in a child process and makes a teaching call at
 * the same time. A fake Anthropic and a fake Tavily answer; no network.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { REAL_ANTHROPIC_KEY, TEST_PASS_KEY_SECRET, blockExternalFetch, startFakeAnthropic, startFakeTavily, startMeteringProxy, type ScriptedReply } from "./frontdoor-metering-fakes.ts";
import { meteringEnvForTenant } from "../frontdoor/metering/tenant-env.ts";

blockExternalFetch();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-metering-research-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
const { searchProvider } = await import("../src/server/search.ts");
const { jobCost } = await import("../src/server/pricing.ts");

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const TENANT_A = "tenant-a-0001";
const TENANT_B = "tenant-b-0002";

const BRIEF = `## Summary
The RMK section holds remarks such as AO2 and sea-level pressure.

## Findings
1. **AO2 marks an automated station with a precipitation sensor.** [FAA AIM 7-1](https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap7_section_1.html)

## Sources
- FAA AIM 7-1 (https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap7_section_1.html)`;

/** Distinct token counts, so a row on the wrong tenant would show at once. */
const SEARCH_STEP: ScriptedReply = {
	toolCall: { id: "toolu_ws1", name: "web_search", input: { query: "METAR RMK section" } },
	usage: { input: 3_000, cacheWrite: 4_000, cacheWrite1h: 4_000, output: 120 },
};
const BRIEF_STEP: ScriptedReply = { text: BRIEF, usage: { input: 1_500, cacheRead: 4_000, output: 900 } };
const TENANT_B_TURN: ScriptedReply = { text: "Tenant B's lesson.", usage: { input: 777, output: 77 } };

/**
 * Tenant B's server: a separate process, spawned the way the front door
 * will spawn it. The inherited environment carries a "real" Anthropic
 * token of the front door's own; meteringEnvForTenant, spread last, must
 * keep it out of the tenant.
 */
function runTenantB(proxyUrl: string): Promise<{ stopReason: string }> {
	const script = fileURLToPath(new URL("./frontdoor-metering-tenant-turn.ts", import.meta.url));
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", script], {
			env: {
				...process.env,
				ANTHROPIC_AUTH_TOKEN: "test-front-door-own-token",
				...meteringEnvForTenant(TENANT_B, { passKeySecret: TEST_PASS_KEY_SECRET, proxyUrl }),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out) as { stopReason: string }) : reject(new Error(`tenant B exited ${code}: ${err.slice(0, 800)}`))));
	});
}

describe("background research metering", () => {
	it("C3: a background research job's cost lands on the tenant that started it", async () => {
		const anthropic = await startFakeAnthropic(({ body }) => {
			const messages = JSON.stringify(body.messages);
			if (messages.includes("tenant B turn")) return TENANT_B_TURN;
			return messages.includes("tool_result") ? BRIEF_STEP : SEARCH_STEP;
		});
		const tavily = await startFakeTavily();
		const stack = await startMeteringProxy({ anthropicUrl: anthropic.url, tavilyUrl: tavily.url });
		try {
			// Tenant A's server environment, as the front door sets it at spawn.
			Object.assign(process.env, meteringEnvForTenant(TENANT_A, { passKeySecret: TEST_PASS_KEY_SECRET, proxyUrl: stack.url }));

			const chat = chatStore.createChat("Metering: research job");
			const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-meter-1" });
			const runner = createJobRunner({
				chatStore,
				jobStore,
				deliver: async () => undefined,
				// Production's wiring: the settings-resolved spec through the one engine factory,
				// and the live search composition (server/search.ts).
				engineFor: () => piEngineForSpec({ provider: "anthropic", id: "claude-opus-5-5" }, true),
				searchProvider,
			});

			const [, tenantB] = await Promise.all([
				runner.runJob(job.id, { question: "What does a METAR's RMK section contain?", context: "Student asked during a METAR lesson." }),
				runTenantB(stack.url),
			]);
			await stack.proxy.flush();

			const done = jobStore.getJob(job.id)!;
			assert.equal(done.status, "done", `the research job finished: ${JSON.stringify(done.error ?? "")}`);
			assert.equal(tenantB.stopReason, "stop");

			const rowsA = stack.store.calls(TENANT_A);
			const rowsB = stack.store.calls(TENANT_B);
			assert.deepEqual(rowsA.map((r) => [r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, r.cacheWrite1hTokens]), [
				[3_000, 120, 0, 4_000, 4_000],
				[1_500, 900, 4_000, 0, 0],
			], "both research calls land on tenant A");
			assert.deepEqual(rowsB.map((r) => r.inputTokens), [777], "tenant B's own turn lands on B, and nothing of A's");

			// The proxy's total for A matches upstream's own record of the job.
			const metered = rowsA.reduce((sum, row) => sum + (row.dollars ?? Number.NaN), 0);
			const recorded = jobCost(done);
			assert.ok(recorded !== null && recorded > 0, "upstream priced the job");
			assert.ok(Math.abs(metered - recorded) < 0.01, `metered ${metered.toFixed(4)} vs upstream's job record ${recorded.toFixed(4)}`);

			// The job's web search is counted on A too.
			assert.equal(stack.store.searches(TENANT_A).length, 1);
			assert.equal(stack.store.searches(TENANT_B).length, 0);

			assert.equal(anthropic.received.length, 3);
			for (const request of anthropic.received) assert.equal(request.headers["x-api-key"], REAL_ANTHROPIC_KEY);
		} finally {
			await stack.close();
			await tavily.close();
			await anthropic.close();
		}
	});
});

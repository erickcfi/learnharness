/**
 * What a tenant server prints, and what reaches the front door's log
 * (W1-6; master decision on Q6, 2026-11-08; PRD cross-cutting req 3):
 *  - only stderr (errors) passes; stdout is dropped;
 *  - each line as "[tenant <id>] <line>", through the front door's log
 *    filter (emails and quoted text removed), cut to 300 characters;
 *  - at most 100 lines a minute per tenant, then one
 *    "[tenant <id>] N lines suppressed" line, so a crash loop cannot flood
 *    the logs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tenantStderrForwarder } from "../frontdoor/wiring/tenant-logs.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const out = (text: string) => Buffer.from(text, "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function collect(options: { linesPerWindow?: number; windowMs?: number } = {}) {
	const lines: string[] = [];
	const forward = tenantStderrForwarder({ log: (line) => lines.push(line), ...options });
	return { lines, forward };
}

describe("tenant log output", () => {
	it("passes stderr lines with the tenant id, and drops stdout", () => {
		const { lines, forward } = collect();
		forward(A, "stdout", out("ready on port 4100\n"));
		forward(A, "stderr", out("Error: provider timeout\n"));
		assert.deepEqual(lines, [`[tenant ${A}] Error: provider timeout`]);
	});

	it("removes emails and quoted text, as the front door's filter does", () => {
		const { lines, forward } = collect();
		forward(A, "stderr", out('Error: could not save chat for pilot@example.com: "Explain the METAR for KSFO"\n'));
		assert.equal(lines.length, 1);
		assert.ok(!lines[0]?.includes("pilot@example.com"));
		assert.ok(!lines[0]?.includes("Explain the METAR"));
		assert.match(lines[0] ?? "", /\[email\]/);
		assert.match(lines[0] ?? "", /"\[text\]"/);
	});

	it("cuts each line to 300 characters", () => {
		const { lines, forward } = collect();
		forward(A, "stderr", out(`${"x".repeat(1000)}\n`));
		assert.equal(lines[0], `[tenant ${A}] ${"x".repeat(300)}`);
	});

	it("joins a line split across chunks, and skips blank lines", () => {
		const { lines, forward } = collect();
		forward(A, "stderr", out("Error: part"));
		forward(A, "stderr", out("ial line\n\n   \nsecond\r\n"));
		assert.deepEqual(lines, [`[tenant ${A}] Error: partial line`, `[tenant ${A}] second`]);
	});

	it("caps each tenant's lines per window, then says how many were suppressed", async () => {
		const { lines, forward } = collect({ linesPerWindow: 3, windowMs: 80 });
		for (let i = 0; i < 7; i++) forward(A, "stderr", out(`crash ${i}\n`));
		forward(B, "stderr", out("another tenant\n"));
		assert.deepEqual(lines, [`[tenant ${A}] crash 0`, `[tenant ${A}] crash 1`, `[tenant ${A}] crash 2`, `[tenant ${B}] another tenant`], "B has its own cap");
		await sleep(150);
		assert.equal(lines.at(-1), `[tenant ${A}] 4 lines suppressed`);
		forward(A, "stderr", out("after the window\n"));
		assert.equal(lines.at(-1), `[tenant ${A}] after the window`, "a new window passes lines again");
	});

	it("uses 100 lines a minute by default", () => {
		const { lines, forward } = collect();
		for (let i = 0; i < 150; i++) forward(A, "stderr", out(`line ${i}\n`));
		assert.equal(lines.length, 100);
	});
});

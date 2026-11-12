/**
 * What a tenant server prints, and what reaches the front door's log
 * (W1-6; master decision on Q6, 2026-11-08; PRD cross-cutting req 3; gaps
 * closed 2026-11-11, P7):
 *  - only stderr (errors) passes; stdout is dropped;
 *  - a line the tenant's log filter printed starts with the front door's
 *    mark, and passes as "[tenant <id>] <line>", through the front door's
 *    log filter too (emails and quoted text removed), cut to 300 characters;
 *  - a line without the mark (Node's own printout, a library writing to
 *    stderr) may be student text: only a stack frame passes as text, any
 *    other line as "[line hidden, N chars]";
 *  - at most 100 lines a minute per tenant, then one
 *    "[tenant <id>] N lines suppressed" line, so a crash loop cannot flood
 *    the logs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, it } from "node:test";
import { newLogMark, tenantStderrForwarder } from "../frontdoor/wiring/tenant-logs.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const MARK = "[lh:0123456789abcdef] ";
const SESSION = "my CFI says the METAR was VFR";
const preload = path.join(import.meta.dirname, "..", "frontdoor", "log-hygiene", "preload.ts");
const out = (text: string) => Buffer.from(text, "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function collect(options: { mark?: string | null; linesPerWindow?: number; windowMs?: number } = {}) {
	const lines: string[] = [];
	const { mark = MARK, ...rest } = options;
	const forward = tenantStderrForwarder({ log: (line) => lines.push(line), ...(mark === null ? {} : { mark }), ...rest });
	return { lines, forward };
}

/** Runs a script as a child Node process and passes its stderr through the forwarder, as the supervisor does. */
function runTenant(script: string, withPreload: boolean) {
	const mark = newLogMark();
	const args = [...(withPreload ? ["--import", preload] : []), "-e", script];
	const result = spawnSync(process.execPath, args, { env: { PATH: process.env.PATH ?? "", LH_LOG_MARK: mark } as unknown as NodeJS.ProcessEnv });
	const { lines, forward } = collect({ mark });
	forward(A, "stderr", result.stderr);
	return { status: result.status, lines, raw: result.stderr.toString("utf8") };
}

describe("tenant log output", () => {
	it("passes the tenant filter's stderr lines with the tenant id, and drops stdout", () => {
		const { lines, forward } = collect();
		forward(A, "stdout", out(`${MARK}ready on port 4100\n`));
		forward(A, "stderr", out(`${MARK}Error: provider timeout\n`));
		assert.deepEqual(lines, [`[tenant ${A}] Error: provider timeout`]);
	});

	it("removes emails and quoted text from those lines too, as the front door's filter does", () => {
		const { lines, forward } = collect();
		forward(A, "stderr", out(`${MARK}Error: could not save chat for pilot@example.com: "Explain the METAR for KSFO"\n`));
		assert.equal(lines.length, 1);
		assert.ok(!lines[0]?.includes("pilot@example.com"));
		assert.ok(!lines[0]?.includes("Explain the METAR"));
		assert.match(lines[0] ?? "", /\[email\]/);
		assert.match(lines[0] ?? "", /"\[text\]"/);
	});

	it("cuts each of those lines to 300 characters", () => {
		const { lines, forward } = collect();
		forward(A, "stderr", out(`${MARK}${"x".repeat(1000)}\n`));
		assert.equal(lines[0], `[tenant ${A}] ${"x".repeat(300)}`);
	});

	it("hides a line of pure student text that skipped the tenant's filter, and gives its length", () => {
		const { lines, forward } = collect();
		forward(A, "stderr", out(`${SESSION}\nError: ${SESSION}\n`));
		assert.deepEqual(lines, [`[tenant ${A}] [line hidden, 29 chars]`, `[tenant ${A}] [line hidden, 36 chars]`]);
	});

	it("hides a long line that skipped the filter whole, rather than passing 300 characters of it", () => {
		const { lines, forward } = collect();
		forward(A, "stderr", out(`${"y".repeat(1000)}\n`));
		assert.deepEqual(lines, [`[tenant ${A}] [line hidden, 1000 chars]`]);
	});

	it("passes stack frames without the mark, and hides the lines around them", () => {
		const { lines, forward } = collect();
		forward(A, "stderr", out(`Error: ${SESSION}\n    at turn (/app/.next/server/chunks/12.js:1:2345)\n    at async Promise.all (index 0)\n    at the airport ${SESSION} (taxiway:2:1)\n`));
		assert.deepEqual(lines, [
			`[tenant ${A}] [line hidden, 36 chars]`,
			`[tenant ${A}]     at turn (/app/.next/server/chunks/12.js:1:2345)`,
			`[tenant ${A}]     at async Promise.all (index 0)`,
			`[tenant ${A}] [line hidden, ${`    at the airport ${SESSION} (taxiway:2:1)`.length} chars]`,
		]);
	});

	it("trusts no line without a mark, and no line with another front door start's mark", () => {
		const unmarked = collect({ mark: null });
		unmarked.forward(A, "stderr", out(`${MARK}Error: provider timeout\n`));
		assert.deepEqual(unmarked.lines, [`[tenant ${A}] [line hidden, ${MARK.length + 23} chars]`]);
		const other = collect({ mark: newLogMark() });
		other.forward(A, "stderr", out(`${MARK}Error: provider timeout\n`));
		assert.match(other.lines[0] ?? "", /^\[tenant [-0-9a-f]+\] \[line hidden, \d+ chars\]$/);
		assert.notEqual(newLogMark(), newLogMark());
	});

	it("joins a line split across chunks, and skips blank lines", () => {
		const { lines, forward } = collect();
		forward(A, "stderr", out(`${MARK}Error: part`));
		forward(A, "stderr", out(`ial line\n\n   \n${MARK}\n${MARK}second\r\n`));
		assert.deepEqual(lines, [`[tenant ${A}] Error: partial line`, `[tenant ${A}] second`]);
	});

	it("caps each tenant's lines per window, then says how many were suppressed", async () => {
		const { lines, forward } = collect({ linesPerWindow: 3, windowMs: 80 });
		for (let i = 0; i < 7; i++) forward(A, "stderr", out(`${MARK}crash ${i}\n`));
		forward(B, "stderr", out(`${MARK}another tenant\n`));
		assert.deepEqual(lines, [`[tenant ${A}] crash 0`, `[tenant ${A}] crash 1`, `[tenant ${A}] crash 2`, `[tenant ${B}] another tenant`], "B has its own cap");
		await sleep(150);
		assert.equal(lines.at(-1), `[tenant ${A}] 4 lines suppressed`);
		forward(A, "stderr", out(`${MARK}after the window\n`));
		assert.equal(lines.at(-1), `[tenant ${A}] after the window`, "a new window passes lines again");
	});

	it("uses 100 lines a minute by default", () => {
		const { lines, forward } = collect();
		for (let i = 0; i < 150; i++) forward(A, "stderr", out(`${MARK}line ${i}\n`));
		assert.equal(lines.length, 100);
	});
});

describe("a tenant server's output, end to end through the preload and the forwarder", () => {
	it("a crash and a raw write reach the log as the class, the frames, the tenant id and fixed text only", () => {
		const script = [
			`console.error("[chat c1] turn error:", new SyntaxError(${JSON.stringify(SESSION)}));`,
			`process.stderr.write(${JSON.stringify(`${SESSION}\n`)});`,
			`setTimeout(() => { const e = new Error(${JSON.stringify(SESSION)}); e.body = { content: ${JSON.stringify(SESSION)} }; throw e; }, 1);`,
		].join("\n");
		const { status, lines, raw } = runTenant(script, true);
		assert.equal(status, 1, raw);
		const log = lines.join("\n");
		assert.ok(!log.includes("CFI says") && !log.includes("body"), log);
		assert.ok(lines.includes(`[tenant ${A}] [chat c1] turn error: SyntaxError: [message hidden, 29 chars]`), log);
		assert.ok(lines.includes(`[tenant ${A}] [line hidden, 29 chars]`), log);
		assert.ok(lines.includes(`[tenant ${A}] [crash] uncaught exception; the process stops (exit code 1)`), log);
		assert.ok(lines.includes(`[tenant ${A}] Error: [message hidden, 29 chars]`), log);
		assert.ok(lines.some((line) => /^\[tenant [-0-9a-f]+\]\s+at .*\[eval\]:\d+:\d+/.test(line)), log);
	});

	it("Node's own crash printout, from a process without the preload, reaches the log as frames and hidden lines only", () => {
		const script = `const e = new Error(${JSON.stringify(`${SESSION}\nsecond line of student text`)}); e.body = { content: ${JSON.stringify(SESSION)} }; throw e;`;
		const { status, lines, raw } = runTenant(script, false);
		assert.equal(status, 1);
		assert.ok(raw.includes("CFI says"), "Node printed the text itself");
		const log = lines.join("\n");
		assert.ok(!log.includes("CFI says") && !log.includes("student text") && !log.includes("body") && !log.includes("Node.js v"), log);
		assert.ok(lines.some((line) => /^\[tenant [-0-9a-f]+\]\s+at /.test(line)), log);
		assert.ok(lines.some((line) => /^\[tenant [-0-9a-f]+\] \[line hidden, \d+ chars\]$/.test(line)), log);
	});
});

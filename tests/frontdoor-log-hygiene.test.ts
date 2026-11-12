/**
 * North Aero cross-cutting requirement 3: logs carry no session text and
 * no email addresses. The filter is loaded into every tenant server with
 * `node --import frontdoor/log-hygiene/preload.ts` (Owner decision,
 * 2026-11-08), so it also covers Next.js's own error printing. The preload
 * also replaces Node's own crash printout (crash.ts), and error messages
 * are hidden, since one can be pure student text (gaps closed 2026-11-11, P7).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, it } from "node:test";

const repo = path.join(import.meta.dirname, "..");
const preload = path.join(repo, "frontdoor", "log-hygiene", "preload.ts");
const filter = await import("../frontdoor/log-hygiene/filter.ts");
const crash = await import("../frontdoor/log-hygiene/crash.ts");

const SESSION = "my CFI says the METAR was VFR";
/** A bare environment for the child process: no inherited secrets. */
const BARE_ENV = { PATH: process.env.PATH ?? "" } as Record<string, string> as unknown as NodeJS.ProcessEnv;
const EMAIL = "pilot.jones+ground@example.co.uk";
const hidden = (text: string) => `[message hidden, ${text.length} chars]`;

/** Runs a script in a child Node with the preload, as a tenant server runs. */
function runWithPreload(script: string, options: { esm?: boolean; env?: Record<string, string> } = {}) {
	const args = ["--import", preload, ...(options.esm ? ["--input-type=module"] : []), "-e", script];
	const result = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...BARE_ENV, ...options.env } as NodeJS.ProcessEnv });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
}

/** No session text, no email, and none of Node's own crash printout. */
function assertNoLeak(output: string): void {
	assert.ok(!output.includes("CFI says") && !output.includes("METAR was"), output);
	assert.ok(!output.includes(EMAIL) && !output.includes("example.co.uk"), output);
	assert.ok(!output.includes("Node.js v"), output);
	assert.ok(!output.includes("body"), output);
}

describe("log filter rules", () => {
	it("replaces email addresses", () => {
		assert.equal(filter.redactLogText(`contact ${EMAIL} or a.b@c.io now`), "contact [email] or [email] now");
	});

	it("cuts quoted text that could be session text, and keeps short ids", () => {
		const text = `Unexpected token 'm', "${SESSION}" is not valid JSON`;
		const out = filter.redactLogText(text);
		assert.ok(!out.includes("CFI says"), out);
		assert.match(out, /Unexpected token 'm', "\[text\]" is not valid JSON/);
		assert.equal(filter.redactLogText(`{"missing":["strong"],"code":"models_not_configured"}`), `{"missing":["strong"],"code":"models_not_configured"}`);
		assert.equal(filter.redactLogText("[chat abc-123] turn refused"), "[chat abc-123] turn refused");
	});

	it("prints an error as its type, its code and its stack frames, with its message hidden", () => {
		const causeMessage = `provider said "${SESSION}"`;
		const message = `Unexpected token in "${SESSION}"`;
		const cause = new Error(causeMessage);
		const error = Object.assign(new SyntaxError(message, { cause }), {
			code: "E_SYNTHETIC",
			body: { messages: [{ role: "user", content: SESSION }] },
			request: { headers: { authorization: "Bearer synthetic" } },
		});
		const out = filter.formatLogValue(error);
		assert.ok(out.startsWith(`SyntaxError: ${hidden(message)} [code E_SYNTHETIC]\n`), out);
		assert.match(out, /\n\s+at .+:\d+:\d+\)?\n/);
		assert.ok(out.includes(`cause: Error: ${hidden(causeMessage)}`), out);
		assert.ok(!out.includes("CFI says") && !out.includes("Bearer") && !out.includes("messages"), out);
	});

	it("hides an error message that is pure student text without quotes, and keeps the class, code and frames", () => {
		const out = filter.formatLogValue(Object.assign(new TypeError(`${SESSION}, asked ${EMAIL}`), { code: "E_TURN" }));
		assert.ok(out.startsWith(`TypeError: ${hidden(`${SESSION}, asked ${EMAIL}`)} [code E_TURN]\n`), out);
		assert.match(out, /\n\s+at /);
		assert.ok(!out.includes("CFI says") && !out.includes(EMAIL), out);
	});

	it("keeps a message that is one short token, such as a code", () => {
		assert.match(filter.formatLogValue(new Error("ECONNRESET")), /^Error: ECONNRESET\n/);
		assert.match(filter.formatLogValue(new Error("")), /^Error\n/);
	});

	it("hides a long message of many lines whole, with its length", () => {
		const message = `${"x".repeat(400)}\n{"messages":[{"content":"${SESSION}"}]}`;
		const long = filter.formatLogValue(new Error(message));
		assert.ok(long.startsWith(`Error: ${hidden(message)}\n`), long);
		assert.ok(!long.includes("xxxx") && !long.includes("CFI says") && !long.includes("messages"), long);
	});

	it("never takes a line of the message for a stack frame", () => {
		const out = filter.formatLogValue(new Error(`bad input\n    at KSFO (runway:28:1)\n    at the hold short line ${SESSION} (taxiway:2:1)`));
		assert.ok(!out.includes("KSFO") && !out.includes("hold short") && !out.includes("CFI says"), out);
		assert.match(out, /\n\s+at /, "the real frames stay");
	});

	it("knows a stack frame line from a line of text", () => {
		for (const frame of [
			"    at Object.<anonymous> (/app/server.js:12:5)",
			"    at file:///app/.next/server/chunks/[root-of-the-server]__0a1b._.js:1:2345",
			"    at new Promise (<anonymous>)",
			"    at async Promise.all (index 0)",
			"    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
			"    at Server.emit [as emit] (node:events:518:28)",
		]) assert.ok(filter.isStackFrame(frame), frame);
		for (const line of [SESSION, `    at ${SESSION}`, "    at the airport (my CFI said so)", "Error: provider timeout", "    ^", "Node.js v26.13.0"]) {
			assert.ok(!filter.isStackFrame(line), line);
		}
	});

	it("prints objects with their keys, numbers and short ids, but not their text", () => {
		const out = filter.formatLogValue({ chatId: "c1", isAborted: false, tokens: 42, note: SESSION, owner: EMAIL, nested: { error: new Error(`parse failed on "${SESSION}"`) } });
		assert.match(out, /chatId: 'c1'/);
		assert.match(out, /isAborted: false/);
		assert.match(out, /tokens: 42/);
		assert.match(out, /Error: \[message hidden, \d+ chars\]/);
		assert.ok(!out.includes("CFI says") && !out.includes(EMAIL), out);
	});

	it("a crash report has a fixed line, the type, code and frames, and no message or other field", () => {
		const error = Object.assign(new RangeError(SESSION), { code: "E_RANGE", body: { content: SESSION } });
		const report = crash.crashReport("uncaught exception", error);
		assert.ok(report.startsWith(`[crash] uncaught exception; the process stops (exit code 1)\nRangeError: ${hidden(SESSION)} [code E_RANGE]\n`), report);
		assert.match(report, /\n\s+at /);
		assertNoLeak(report);
		assert.equal(crash.crashReport("unhandled rejection", SESSION), "[crash] unhandled rejection; the process stops (exit code 1)\nnot an Error: a string of 29 chars");
		assert.equal(crash.crashReport("unhandled rejection", { status: 500, detail: SESSION }), "[crash] unhandled rejection; the process stops (exit code 1)\nnot an Error: { status: 500, detail: '[text]' }");
	});
});

describe("log filter in a running process", () => {
	it("a process started with the preload prints no session text and no emails", () => {
		const script = [
			`console.error("[chat c1] turn error:", new SyntaxError(${JSON.stringify(`Unexpected token 'm', "${SESSION}" is not valid JSON`)}));`,
			`console.info(${JSON.stringify(`[import] from ${EMAIL}`)});`,
			`console.log("%s wrote %s", ${JSON.stringify(EMAIL)}, ${JSON.stringify(SESSION)});`,
			`const e = new Error("400 bad request"); e.body = { content: ${JSON.stringify(SESSION)} }; console.warn(e);`,
			`console.debug({ chatId: "c1", text: ${JSON.stringify(SESSION)} });`,
			`console.trace(${JSON.stringify(EMAIL)});`,
			`console.dir({ owner: ${JSON.stringify(EMAIL)} });`,
		].join("\n");
		const result = runWithPreload(script);
		assert.equal(result.status, 0, result.stderr);
		assertNoLeak(result.output);
		assert.match(result.output, /\[chat c1\] turn error: SyntaxError: \[message hidden, \d+ chars\]/);
		assert.match(result.output, /\[import\] from \[email\]/);
		assert.match(result.output, /Error: \[message hidden, 15 chars\]/);
		assert.match(result.output, /chatId: 'c1'/);
	});

	it("installing the filter twice wraps console once", () => {
		const script = `import(${JSON.stringify(path.join(repo, "frontdoor", "log-hygiene", "filter.ts"))}).then((m) => { m.installLogFilter(); m.installLogFilter(); console.log(${JSON.stringify(EMAIL)}); });`;
		const result = runWithPreload(script);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "[email]\n");
	});

	it("with LH_LOG_MARK, every line it prints starts with the mark, and the mark leaves the environment", () => {
		const mark = "[lh:0123456789abcdef] ";
		const script = `console.error("[chat c1] failed:", new Error(${JSON.stringify(SESSION)})); console.log(process.env.LH_LOG_MARK === undefined ? "removed" : "kept");`;
		const result = runWithPreload(script, { env: { LH_LOG_MARK: mark } });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, `${mark}removed\n`);
		const lines = result.stderr.trimEnd().split("\n");
		assert.ok(lines.length > 2, result.stderr);
		for (const line of lines) assert.ok(line.startsWith(mark), line);
		assert.equal(lines[0], `${mark}[chat c1] failed: Error: ${hidden(SESSION)}`);
		assertNoLeak(result.output);
	});
});

describe("crash listeners: Node's own crash printout is replaced", () => {
	it("an uncaught exception prints the fixed line, the class and the frames, then exits with code 1", () => {
		const script = `const e = new RangeError(${JSON.stringify(`${SESSION} ${EMAIL}`)}); e.body = { content: ${JSON.stringify(SESSION)} }; setTimeout(() => { throw e; }, 1);`;
		const result = runWithPreload(script);
		assert.equal(result.status, 1);
		assert.ok(result.stderr.startsWith(`[crash] uncaught exception; the process stops (exit code 1)\nRangeError: ${hidden(`${SESSION} ${EMAIL}`)}\n`), result.stderr);
		assert.match(result.stderr, /\n\s+at .*\[eval\]:\d+:\d+/, "the stack frames stay");
		assertNoLeak(result.output);
	});

	it("an unhandled rejection of an Error prints the same way, with its code, and exits with code 1", () => {
		const result = runWithPreload(`Promise.reject(Object.assign(new Error(${JSON.stringify(SESSION)}), { code: "E_PROVIDER" }));`);
		assert.equal(result.status, 1);
		assert.ok(result.stderr.startsWith(`[crash] unhandled rejection; the process stops (exit code 1)\nError: ${hidden(SESSION)} [code E_PROVIDER]\n`), result.stderr);
		assertNoLeak(result.output);
	});

	it("an unhandled rejection of a plain string prints only its length", () => {
		const result = runWithPreload(`Promise.reject(${JSON.stringify(SESSION)});`);
		assert.equal(result.status, 1);
		assert.equal(result.stderr, "[crash] unhandled rejection; the process stops (exit code 1)\nnot an Error: a string of 29 chars\n");
	});

	it("a thrown string prints only its length", () => {
		const result = runWithPreload(`setTimeout(() => { throw ${JSON.stringify(SESSION)}; }, 1);`);
		assert.equal(result.status, 1);
		assert.equal(result.stderr, "[crash] uncaught exception; the process stops (exit code 1)\nnot an Error: a string of 29 chars\n");
	});

	it("a rejected top-level await is caught too", () => {
		const result = runWithPreload(`await Promise.reject(new Error(${JSON.stringify(SESSION)}));`, { esm: true });
		assert.equal(result.status, 1);
		assert.ok(result.stderr.startsWith(`[crash] unhandled rejection; the process stops (exit code 1)\nError: ${hidden(SESSION)}\n`), result.stderr);
		assertNoLeak(result.output);
	});

	it("with LH_LOG_MARK, the crash report's lines carry the mark", () => {
		const mark = "[lh:fedcba9876543210] ";
		const result = runWithPreload(`setTimeout(() => { throw new Error(${JSON.stringify(SESSION)}); }, 1);`, { env: { LH_LOG_MARK: mark } });
		assert.equal(result.status, 1);
		for (const line of result.stderr.trimEnd().split("\n")) assert.ok(line.startsWith(mark), line);
		assertNoLeak(result.output);
	});

	it("once other code listens, as Next.js does, that code decides: the process keeps running and prints through the filter", () => {
		const script = [
			// Next.js's listeners (next-server.js and its Log.error): the first prints the value as console.error's first argument.
			`process.on("uncaughtException", (reason) => console.error(reason));`,
			`process.on("unhandledRejection", (reason) => console.error(" x", "unhandledRejection:", reason));`,
			`setTimeout(() => { throw new Error(${JSON.stringify(SESSION)}); }, 1);`,
			`setTimeout(() => { throw ${JSON.stringify(SESSION)}; }, 10);`,
			`setTimeout(() => { Promise.reject(${JSON.stringify(SESSION)}); }, 20);`,
			`setTimeout(() => console.error("still running"), 60);`,
		].join("\n");
		const result = runWithPreload(script);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(!result.stderr.includes("[crash]"), result.stderr);
		assert.ok(result.stderr.includes(`Error: ${hidden(SESSION)}\n`), result.stderr);
		assert.ok(result.stderr.includes("\n[text]\n"), "a thrown string is not taken for the code's own message");
		assert.match(result.stderr, /still running\n$/);
		assertNoLeak(result.output);
	});
});

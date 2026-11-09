/**
 * North Aero cross-cutting requirement 3: logs carry no session text and
 * no email addresses. The filter is loaded into every tenant server with
 * `node --import frontdoor/log-hygiene/preload.ts` (Owner decision,
 * 2026-11-08), so it also covers Next.js's own error printing.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, it } from "node:test";

const repo = path.join(import.meta.dirname, "..");
const preload = path.join(repo, "frontdoor", "log-hygiene", "preload.ts");
const filter = await import("../frontdoor/log-hygiene/filter.ts");

const SESSION = "my CFI says the METAR was VFR";
/** A bare environment for the child process: no inherited secrets. */
const BARE_ENV = { PATH: process.env.PATH ?? "" } as Record<string, string> as unknown as NodeJS.ProcessEnv;
const EMAIL = "pilot.jones+ground@example.co.uk";

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

	it("prints an error as its type, a cleaned message, its code and its stack frames only", () => {
		const cause = new Error(`provider said "${SESSION}"`);
		const error = Object.assign(new SyntaxError(`Unexpected token in "${SESSION}"`, { cause }), {
			code: "E_SYNTHETIC",
			body: { messages: [{ role: "user", content: SESSION }] },
			request: { headers: { authorization: "Bearer synthetic" } },
		});
		const out = filter.formatLogValue(error);
		assert.match(out, /^SyntaxError: Unexpected token in "\[text\]" \[code E_SYNTHETIC\]/);
		assert.match(out, /\n\s+at /);
		assert.match(out, /cause: Error: provider said "\[text\]"/);
		assert.ok(!out.includes("CFI says") && !out.includes("Bearer") && !out.includes("messages"), out);
	});

	it("prints objects with their keys, numbers and short ids, but not their text", () => {
		const out = filter.formatLogValue({ chatId: "c1", isAborted: false, tokens: 42, note: SESSION, owner: EMAIL, nested: { error: new Error(`parse failed on "${SESSION}"`) } });
		assert.match(out, /chatId: 'c1'/);
		assert.match(out, /isAborted: false/);
		assert.match(out, /tokens: 42/);
		assert.match(out, /Error: parse failed on "\[text\]"/);
		assert.ok(!out.includes("CFI says") && !out.includes(EMAIL), out);
	});

	it("keeps only an error message's first line, cut to 300 characters", () => {
		const long = filter.formatLogValue(new Error(`${"x".repeat(400)}\n{"messages":[{"content":"${SESSION}"}]}`));
		assert.match(long, /^Error: x{300} \[\.\.\.\]\n/);
		assert.ok(!long.includes("CFI says") && !long.includes("messages"), long);
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
		const result = spawnSync(process.execPath, ["--import", preload, "-e", script], { encoding: "utf8", env: BARE_ENV });
		assert.equal(result.status, 0, result.stderr);
		const output = result.stdout + result.stderr;
		assert.ok(!output.includes("CFI says"), output);
		assert.ok(!output.includes(EMAIL) && !output.includes("example.co.uk"), output);
		assert.match(output, /\[chat c1\] turn error: SyntaxError: Unexpected token 'm', "\[text\]" is not valid JSON/);
		assert.match(output, /\[import\] from \[email\]/);
		assert.match(output, /Error: 400 bad request/);
		assert.match(output, /chatId: 'c1'/);
	});

	it("installing the filter twice wraps console once", () => {
		const script = `import(${JSON.stringify(path.join(repo, "frontdoor", "log-hygiene", "filter.ts"))}).then((m) => { m.installLogFilter(); m.installLogFilter(); console.log(${JSON.stringify(EMAIL)}); });`;
		const result = spawnSync(process.execPath, ["--import", preload, "-e", script], { encoding: "utf8", env: BARE_ENV });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "[email]\n");
	});
});

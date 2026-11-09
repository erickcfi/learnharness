/**
 * The front door refuses a production start that is not safe (W1-6
 * wire-up; PRD C3 req 9, cross-cutting req 2):
 *  - a debug-capture variable is set (lockdown's production safety check);
 *  - a secret the front door needs is missing: FRONTDOOR_PASS_KEY_SECRET,
 *    ANTHROPIC_API_KEY, TAVILY_API_KEY, or SUPABASE_DB_URL.
 * Each refusal names the variable and never prints its value.
 *
 * The real server.ts runs, as `npm run start -w frontdoor` runs it (tsx,
 * NODE_ENV=production). The checks run before Next.js starts, so no build
 * is needed.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { describe, it } from "node:test";
import { wiringEnvProblems } from "../frontdoor/wiring/env.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const SERVER = path.join(REPO, "frontdoor", "server.ts");

/** A value that must never appear in the output. */
const SENTINEL = "sentinel-value-must-not-print-7f3a9c";

/** Every variable a production start needs, with test values. */
const GOOD: Record<string, string> = {
	NODE_ENV: "production",
	FRONTDOOR_SESSION_SECRET: "test-session-secret-0123456789abcdefghij",
	CLERK_SECRET_KEY: "sk_test_production_start_test",
	NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_production_start_test",
	FRONTDOOR_PASS_KEY_SECRET: "test-pass-key-secret-0123456789abcdefghij",
	ANTHROPIC_API_KEY: "test-anthropic-key-production-start",
	TAVILY_API_KEY: "test-tavily-key-production-start",
	SUPABASE_DB_URL: "postgres://user:pass@127.0.0.1:9/never_dialed",
	FRONTDOOR_VOLUME: path.join(REPO, ".never-created-volume"),
	PORT: "0",
};

interface Run {
	code: number | null;
	output: string;
}

/** Starts server.ts with exactly this environment (plus PATH) and waits for it to exit. */
function start(env: Record<string, string>): Promise<Run> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", SERVER], {
			cwd: REPO,
			// The cast: Node's types mark NODE_ENV required; some cases leave it out on purpose.
			env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`server.ts did not exit within 30 s. Output:\n${output}`));
		}, 30_000);
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

function without(...names: string[]): Record<string, string> {
	const env = { ...GOOD };
	for (const name of names) delete env[name];
	return env;
}

async function assertRefused(env: Record<string, string>, names: string[]): Promise<void> {
	const { code, output } = await start(env);
	assert.notEqual(code, 0, `the start must fail. Output:\n${output}`);
	assert.match(output, /will not start/);
	for (const name of names) assert.ok(output.includes(name), `the refusal names ${name}. Output:\n${output}`);
	assert.ok(!output.includes(SENTINEL), "no value is printed");
	for (const value of Object.values(GOOD)) {
		if (value.length >= 20) assert.ok(!output.includes(value), "no configured value is printed");
	}
}

describe("production start", { concurrency: true }, () => {
	it("fails when LH_PROVIDER_EVENTS is set (C3 req 9)", async () => {
		await assertRefused({ ...GOOD, LH_PROVIDER_EVENTS: SENTINEL }, ["LH_PROVIDER_EVENTS"]);
	});

	for (const name of ["FRONTDOOR_PASS_KEY_SECRET", "ANTHROPIC_API_KEY", "TAVILY_API_KEY", "SUPABASE_DB_URL"]) {
		it(`fails when ${name} is missing`, async () => {
			await assertRefused(without(name), [name]);
		});
	}

	it("fails when FRONTDOOR_PASS_KEY_SECRET is shorter than 32 characters, without printing it", async () => {
		await assertRefused({ ...GOOD, FRONTDOOR_PASS_KEY_SECRET: SENTINEL.slice(0, 20) }, ["FRONTDOOR_PASS_KEY_SECRET"]);
	});

	it("lists every missing secret at once", async () => {
		await assertRefused(without("FRONTDOOR_PASS_KEY_SECRET", "ANTHROPIC_API_KEY", "TAVILY_API_KEY", "SUPABASE_DB_URL"), [
			"FRONTDOOR_PASS_KEY_SECRET",
			"ANTHROPIC_API_KEY",
			"TAVILY_API_KEY",
			"SUPABASE_DB_URL",
		]);
	});

	it("an empty value counts as missing", async () => {
		await assertRefused({ ...GOOD, ANTHROPIC_API_KEY: "" }, ["ANTHROPIC_API_KEY"]);
	});
});

describe("start checks outside production", () => {
	it("do not require the production secrets", () => {
		const env = without("FRONTDOOR_PASS_KEY_SECRET", "ANTHROPIC_API_KEY", "TAVILY_API_KEY", "SUPABASE_DB_URL");
		env.NODE_ENV = "development";
		assert.deepEqual(wiringEnvProblems(env), []);
	});

	it("still refuse a pass-key secret that is too short, without printing it", () => {
		const problems = wiringEnvProblems({ FRONTDOOR_PASS_KEY_SECRET: SENTINEL.slice(0, 20) });
		assert.equal(problems.length, 1);
		assert.match(problems[0] ?? "", /FRONTDOOR_PASS_KEY_SECRET/);
		assert.ok(!(problems[0] ?? "").includes(SENTINEL.slice(0, 20)));
	});

	it("refuse a SUPABASE_DB_URL that is not a Postgres address, without printing it", () => {
		const problems = wiringEnvProblems({ SUPABASE_DB_URL: `https://${SENTINEL}.example` });
		assert.equal(problems.length, 1);
		assert.match(problems[0] ?? "", /SUPABASE_DB_URL/);
		assert.ok(!(problems[0] ?? "").includes(SENTINEL));
	});
});

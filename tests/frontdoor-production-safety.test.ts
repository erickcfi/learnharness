/**
 * North Aero C3 requirements 8 and 9 (N6, N13): in production the front
 * door refuses to start while a debug-capture variable or a Deepgram key is
 * set, and tenant servers never receive those variables (Owner decision,
 * 2026-11-08: the check lives in the front door, no upstream change).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const repo = path.join(import.meta.dirname, "..");
const check = path.join(repo, "frontdoor", "production-safety", "check.ts");
const safety = await import("../frontdoor/production-safety/index.ts");

/** A front-door start: plain Node (no tsx), as Railway runs it. */
function start(env: Record<string, string>) {
	// A bare environment (no NODE_ENV unless the case sets one): no inherited secrets.
	const bare: Record<string, string> = { PATH: process.env.PATH ?? "", ...env };
	return spawnSync(process.execPath, [check], { env: bare as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
}

describe("production start check", () => {
	it("a production start with LH_PROVIDER_EVENTS=1 fails", () => {
		const result = start({ NODE_ENV: "production", LH_PROVIDER_EVENTS: "1" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /LH_PROVIDER_EVENTS/);
	});

	it("LH_BACKGROUND_CAPTURE and DEEPGRAM_API_KEY fail too, even when empty, and values are never printed", () => {
		for (const [name, value] of [["LH_BACKGROUND_CAPTURE", "all"], ["LH_BACKGROUND_CAPTURE", ""], ["LH_PROVIDER_EVENTS", ""], ["DEEPGRAM_API_KEY", "dg-synthetic-secret-4821"]] as const) {
			const result = start({ NODE_ENV: "production", [name]: value });
			assert.equal(result.status, 1, `${name}=${JSON.stringify(value)}`);
			assert.match(result.stderr, new RegExp(name));
			if (value) assert.ok(!result.stderr.includes(value) && !result.stdout.includes(value), `${name}'s value was printed`);
		}
		const all = start({ NODE_ENV: "production", LH_PROVIDER_EVENTS: "1", LH_BACKGROUND_CAPTURE: "auditor", DEEPGRAM_API_KEY: "dg-synthetic-secret-4821" });
		assert.equal(all.status, 1);
		for (const name of ["LH_PROVIDER_EVENTS", "LH_BACKGROUND_CAPTURE", "DEEPGRAM_API_KEY"]) assert.match(all.stderr, new RegExp(name));
	});

	it("a clean production start passes, and development is not checked", () => {
		assert.equal(start({ NODE_ENV: "production" }).status, 0);
		assert.equal(start({ NODE_ENV: "development", LH_PROVIDER_EVENTS: "1" }).status, 0);
		assert.equal(start({ LH_PROVIDER_EVENTS: "1" }).status, 0);
	});

	it("assertProductionSafe runs the same check inside the front door's own start", () => {
		assert.throws(() => safety.assertProductionSafe({ NODE_ENV: "production", LH_PROVIDER_EVENTS: "1" }), /LH_PROVIDER_EVENTS/);
		assert.doesNotThrow(() => safety.assertProductionSafe({ NODE_ENV: "production", LH_DATA_DIR: "/data" }));
		assert.deepEqual(safety.productionSafetyProblems({ NODE_ENV: "test", LH_PROVIDER_EVENTS: "1" }), []);
		assert.equal(safety.productionSafetyProblems({ NODE_ENV: "production", DEEPGRAM_API_KEY: "x" }).length, 1);
	});
});

describe("tenant server environment", () => {
	it("tenant servers never receive the capture or dictation variables", () => {
		const env = safety.tenantServerEnv(
			{ PATH: "/usr/bin", NODE_ENV: "production", LH_PROVIDER_EVENTS: "1", LH_BACKGROUND_CAPTURE: "all", DEEPGRAM_API_KEY: "x", UNSET: undefined },
			{ LH_DATA_DIR: "/data/tenants/t1", LH_PROVIDER_EVENTS: "1", PORT: "4100" },
		);
		assert.deepEqual(env, { PATH: "/usr/bin", NODE_ENV: "production", LH_DATA_DIR: "/data/tenants/t1", PORT: "4100" });
	});
});

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lh-dictation-off-")));
const prior = Object.fromEntries(["LH_DATA_DIR", "LH_AUTH_FILE", "DEEPGRAM_API_KEY"].map((key) => [key, process.env[key]]));
after(async () => {
	for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await fs.rm(root, { recursive: true, force: true });
});

describe("dictation stays off", () => {
	it("with no Deepgram key, /api/stt/token mints nothing", async () => {
		process.env.LH_DATA_DIR = path.join(root, "data");
		process.env.LH_AUTH_FILE = path.join(root, "auth.json");
		delete process.env.DEEPGRAM_API_KEY;
		await fs.writeFile(process.env.LH_AUTH_FILE, "{}");
		const { GET } = await import("../app/api/stt/token/route.ts");
		const response = await GET();
		assert.equal(response.status, 503);
		assert.equal(((await response.json()) as { token?: string }).token, undefined);
	});
});

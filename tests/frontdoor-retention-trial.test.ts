/**
 * The trial record's email hash key (C2 req 2, D10; master decision
 * 2026-11-08): LH_TRIAL_HASH_KEY is a production start check (32+
 * characters), and trialEmailHash() is what W2-8 calls.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashEmailForTrial } from "../frontdoor/db/index.ts";
import { runStartupChecks } from "../frontdoor/gateway/startup-checks.ts";
import { assertTrialHashKey, DEV_TRIAL_HASH_KEY, trialEmailHash, trialKeyProblems } from "../frontdoor/retention/trial.ts";
import { STARTUP_CHECKS } from "../frontdoor/wiring/env.ts";

const KEY = "trial-hash-key-for-tests-0123456789abcdef";
const SHORT = "short-key-must-not-print";

describe("LH_TRIAL_HASH_KEY", () => {
	it("is required in production, and must be 32+ characters anywhere; messages never print the value", () => {
		assert.deepEqual(trialKeyProblems({ NODE_ENV: "production", LH_TRIAL_HASH_KEY: KEY }), []);
		assert.match(trialKeyProblems({ NODE_ENV: "production" })[0] ?? "", /LH_TRIAL_HASH_KEY is not set/);
		assert.match(trialKeyProblems({ NODE_ENV: "production", LH_TRIAL_HASH_KEY: "" })[0] ?? "", /not set/);
		const short = trialKeyProblems({ NODE_ENV: "development", LH_TRIAL_HASH_KEY: SHORT });
		assert.match(short[0] ?? "", /at least 32 characters/);
		assert.ok(!short[0]?.includes(SHORT));
		assert.deepEqual(trialKeyProblems({ NODE_ENV: "development" }), [], "outside production it may be left out");
	});

	it("is one of the front door's start checks", () => {
		assert.ok(STARTUP_CHECKS.includes(assertTrialHashKey));
		assert.throws(() => runStartupChecks({ NODE_ENV: "production" }, [assertTrialHashKey]), /will not start:\n- LH_TRIAL_HASH_KEY/);
	});

	it("trialEmailHash: the keyed hash trial_claims stores, the same for any case or spaces", () => {
		const env = { NODE_ENV: "production", LH_TRIAL_HASH_KEY: KEY };
		const h = trialEmailHash("  Pilot@Example.com ", env);
		assert.match(h, /^[0-9a-f]{64}$/);
		assert.equal(h, trialEmailHash("pilot@example.com", env));
		assert.equal(h, hashEmailForTrial("pilot@example.com", KEY));
		assert.notEqual(h, trialEmailHash("pilot@example.com", { NODE_ENV: "production", LH_TRIAL_HASH_KEY: `${KEY}x` }), "a new key gives new hashes: never change it");
		assert.throws(() => trialEmailHash("pilot@example.com", { NODE_ENV: "production" }), /not set/);
		assert.equal(trialEmailHash("pilot@example.com", { NODE_ENV: "test" }), hashEmailForTrial("pilot@example.com", DEV_TRIAL_HASH_KEY));
	});
});

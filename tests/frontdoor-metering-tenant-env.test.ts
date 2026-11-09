/**
 * The spawn-time helper for the front door (P2-01): the environment
 * variables one tenant's LearnHarness server needs so that its model calls
 * and searches go through the metering proxy under that tenant's pass key.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { passKeyResolver } from "../frontdoor/metering/pass-key.ts";
import { meteringEnvForTenant } from "../frontdoor/metering/tenant-env.ts";

const SECRET = "metering-test-secret-0123456789abcdef";

describe("meteringEnvForTenant", () => {
	it("gives the tenant its pass key in place of both real keys, and the proxy's addresses", () => {
		const env = meteringEnvForTenant("tenant-a-0001", { passKeySecret: SECRET, proxyUrl: "http://127.0.0.1:8790" });
		assert.equal(passKeyResolver(SECRET)(env.ANTHROPIC_API_KEY!), "tenant-a-0001");
		assert.equal(env.TAVILY_API_KEY, env.ANTHROPIC_API_KEY);
		assert.equal(env.LH_ANTHROPIC_BASE_URL, "http://127.0.0.1:8790");
		assert.equal(env.LH_TAVILY_BASE_URL, "http://127.0.0.1:8790/tavily");
	});

	it("blanks the other Anthropic credentials, so a key in the front door's own environment never reaches a tenant", () => {
		const env = meteringEnvForTenant("tenant-a-0001", { passKeySecret: SECRET, proxyUrl: "http://127.0.0.1:8790" });
		assert.equal(env.ANTHROPIC_AUTH_TOKEN, "");
		assert.equal(env.ANTHROPIC_OAUTH_TOKEN, "");
		// Spread over an inherited environment, the tenant's values win.
		const spawned = { ...{ ANTHROPIC_API_KEY: "real", ANTHROPIC_AUTH_TOKEN: "real", TAVILY_API_KEY: "real" }, ...env };
		assert.ok(!Object.values(spawned).includes("real"));
	});

	it("each tenant gets a different pass key", () => {
		const options = { passKeySecret: SECRET, proxyUrl: "http://127.0.0.1:8790" };
		assert.notEqual(meteringEnvForTenant("tenant-a-0001", options).ANTHROPIC_API_KEY, meteringEnvForTenant("tenant-b-0002", options).ANTHROPIC_API_KEY);
	});

	it("tolerates a trailing slash and a path on the proxy address", () => {
		const env = meteringEnvForTenant("t", { passKeySecret: SECRET, proxyUrl: "http://metering.internal:8790/meter/" });
		assert.equal(env.LH_ANTHROPIC_BASE_URL, "http://metering.internal:8790/meter");
		assert.equal(env.LH_TAVILY_BASE_URL, "http://metering.internal:8790/meter/tavily");
	});

	it("refuses a bad proxy address, an empty tenant id, or a short secret", () => {
		assert.throws(() => meteringEnvForTenant("t", { passKeySecret: SECRET, proxyUrl: "metering:8790" }), /http or https/);
		assert.throws(() => meteringEnvForTenant("t", { passKeySecret: SECRET, proxyUrl: "ftp://127.0.0.1" }), /http or https/);
		assert.throws(() => meteringEnvForTenant("", { passKeySecret: SECRET, proxyUrl: "http://127.0.0.1:8790" }), /tenant id/);
		assert.throws(() => meteringEnvForTenant("t", { passKeySecret: "short", proxyUrl: "http://127.0.0.1:8790" }), /at least 32 characters/);
	});
});

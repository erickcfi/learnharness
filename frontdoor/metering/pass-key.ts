/**
 * Per-tenant pass keys for the metering proxy (Owner decision, 2026-11-08).
 *
 * Each tenant's LearnHarness server gets a pass key where the real
 * Anthropic and Tavily keys would go (ANTHROPIC_API_KEY, TAVILY_API_KEY).
 * The proxy reads the tenant from the pass key and swaps in the real key,
 * so the real keys never enter a tenant's server.
 *
 * A pass key is the tenant id plus an HMAC signature made with a secret the
 * front door holds, so no key table is needed: the proxy checks a key by
 * signing the id again. Changing the secret replaces every pass key.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "na-mtr-";
const MIN_SECRET_LENGTH = 32;

function checkSecret(secret: string): void {
	if (secret.length < MIN_SECRET_LENGTH) {
		throw new Error(`the pass-key secret must be at least ${MIN_SECRET_LENGTH} characters`);
	}
}

function signature(secret: string, encodedTenant: string): Buffer {
	return createHmac("sha256", secret).update(`metering-pass-key:v1:${encodedTenant}`).digest();
}

/** The pass key for one tenant. */
export function makePassKey(secret: string, tenantId: string): string {
	checkSecret(secret);
	const encoded = Buffer.from(tenantId, "utf8").toString("base64url");
	return `${PREFIX}${encoded}.${signature(secret, encoded).toString("base64url")}`;
}

/** Returns a function that gives the tenant id for a valid pass key, or null. */
export function passKeyResolver(secret: string): (passKey: string) => string | null {
	checkSecret(secret);
	return (passKey) => {
		if (!passKey.startsWith(PREFIX)) return null;
		const [encoded, signed, extra] = passKey.slice(PREFIX.length).split(".");
		if (!encoded || !signed || extra !== undefined) return null;
		const expected = signature(secret, encoded);
		const given = Buffer.from(signed, "base64url");
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
		const tenantId = Buffer.from(encoded, "base64url").toString("utf8");
		return tenantId || null;
	};
}

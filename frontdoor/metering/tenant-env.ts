/**
 * The front door calls this when it starts a tenant's LearnHarness server
 * (X1 option A, P2-01). It returns the environment variables that send the
 * tenant's model calls and Tavily searches through the metering proxy
 * under the tenant's own pass key.
 *
 *   spawn(node, [server.js], {
 *     env: { ...baseEnv, LH_DATA_DIR, LH_AUTH_FILE, PORT,
 *            ...meteringEnvForTenant(tenantId, { passKeySecret, proxyUrl }) },
 *   });
 *
 * Spread it last, so it overrides anything inherited. It also blanks the
 * other Anthropic credentials pi-ai would try first, so a real key in the
 * front door's own environment never reaches a tenant.
 */

import { makePassKey } from "./pass-key.ts";

export interface MeteringSpawnOptions {
	/** The front door's pass-key secret, 32 characters or more. The proxy checks keys with the same secret. */
	passKeySecret: string;
	/** Where tenant servers reach the metering proxy, for example http://127.0.0.1:8790. */
	proxyUrl: string;
}

export function meteringEnvForTenant(tenantId: string, options: MeteringSpawnOptions): Record<string, string> {
	if (!tenantId) throw new Error("meteringEnvForTenant needs a tenant id");
	let url: URL;
	try {
		url = new URL(options.proxyUrl);
	} catch {
		url = new URL("invalid:");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("the metering proxy address must be an http or https URL");
	}
	const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
	const passKey = makePassKey(options.passKeySecret, tenantId);
	return {
		ANTHROPIC_API_KEY: passKey,
		TAVILY_API_KEY: passKey,
		LH_ANTHROPIC_BASE_URL: base,
		LH_TAVILY_BASE_URL: `${base}/tavily`,
		// pi-ai reads these before ANTHROPIC_API_KEY. Empty means unset to it.
		ANTHROPIC_AUTH_TOKEN: "",
		ANTHROPIC_OAUTH_TOKEN: "",
	};
}

/**
 * Front door settings, read from environment variables (Railway variables
 * in production; secrets live only there).
 *
 * Required:
 *   FRONTDOOR_SESSION_SECRET           signs the front door's cookies; 32+ characters
 *   CLERK_SECRET_KEY                   from the Clerk application's API keys page
 *   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY  same page; also needed when `next build` runs
 * Optional:
 *   CLERK_JWT_KEY                      Clerk's PEM public key: checks logins without a network call
 *   FRONTDOOR_AUTHORIZED_PARTIES       comma list of the site's origins, e.g. https://ground.flynorthaero.com
 *   FRONTDOOR_VOLUME                   the volume root (default /data)
 *   FRONTDOOR_TENANT_SERVER            upstream's standalone server.js (default <repo>/.next/standalone/server.js)
 *   FRONTDOOR_LISTEN_HOST              default 0.0.0.0
 *   PORT                               default 3000
 *   FRONTDOOR_DEV=1                    run the front door's pages in Next.js dev mode
 * The secrets for the meter and the database (FRONTDOOR_PASS_KEY_SECRET,
 * ANTHROPIC_API_KEY, TAVILY_API_KEY, SUPABASE_DB_URL) are read in
 * wiring/env.ts. The full list is in frontdoor/README.md, "Deploy on Railway".
 */
import * as path from "node:path";
import { sessionSecretFrom } from "./session.ts";

export interface FrontDoorConfig {
	dev: boolean;
	port: number;
	listenHost: string;
	volumeDir: string;
	tenantServerScript: string;
	sessionSecret: Uint8Array;
	/** Cookies only over HTTPS (production). */
	secureCookies: boolean;
	/** Trust X-Forwarded-Proto/Host from the hosting edge (production). */
	trustForwardedHeaders: boolean;
	clerk: {
		secretKey: string;
		publishableKey: string;
		jwtKey?: string;
		authorizedParties?: string[];
	};
}

type Env = Record<string, string | undefined>;

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

export function loadConfig(env: Env): FrontDoorConfig {
	const missing = ["FRONTDOOR_SESSION_SECRET", "CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"].filter((name) => !env[name]);
	if (missing.length > 0) throw new Error(`The front door needs these variables: ${missing.join(", ")}.`);
	const production = env.NODE_ENV === "production";
	const parties = (env.FRONTDOOR_AUTHORIZED_PARTIES ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
	return {
		dev: env.FRONTDOOR_DEV === "1",
		port: Number(env.PORT ?? 3000),
		listenHost: env.FRONTDOOR_LISTEN_HOST ?? "0.0.0.0",
		volumeDir: path.resolve(env.FRONTDOOR_VOLUME ?? "/data"),
		tenantServerScript: path.resolve(env.FRONTDOOR_TENANT_SERVER ?? path.join(REPO_ROOT, ".next", "standalone", "server.js")),
		sessionSecret: sessionSecretFrom(env.FRONTDOOR_SESSION_SECRET),
		secureCookies: production,
		trustForwardedHeaders: production,
		clerk: {
			secretKey: env.CLERK_SECRET_KEY ?? "",
			publishableKey: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "",
			...(env.CLERK_JWT_KEY ? { jwtKey: env.CLERK_JWT_KEY } : {}),
			...(parties.length > 0 ? { authorizedParties: parties } : {}),
		},
	};
}

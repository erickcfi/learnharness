/**
 * The front door's start checks and the variables the wire-up reads (W1-6).
 * Light on purpose: server.ts runs these before it loads Next.js or any
 * upstream code, so a bad Railway variable fails the deploy at once.
 *
 * Secrets the front door holds and never passes to a tenant server:
 *   FRONTDOOR_PASS_KEY_SECRET  signs each tenant's metering pass key; 32+ characters
 *   ANTHROPIC_API_KEY          the real Anthropic key, used only by the meter
 *   TAVILY_API_KEY             the real Tavily key, used only by the meter
 *   SUPABASE_DB_URL            the database (Supabase session pooler connection string)
 * All four are required in production. Outside production each may be left
 * out: no SUPABASE_DB_URL keeps accounts and usage in memory, no pass-key
 * secret makes a random one for this run, and a missing API key makes those
 * calls fail at the provider. Messages name variables, never their values.
 */
import { randomBytes } from "node:crypto";
import { assertBillingEnv } from "../billing/config.ts";
import { assertEmailEnv } from "../email/config.ts";
import { loadConfig, type FrontDoorConfig } from "../gateway/config.ts";
import { runStartupChecks, type StartupCheck } from "../gateway/startup-checks.ts";
import { assertProductionSafe } from "../production-safety/index.ts";

type Env = Readonly<Record<string, string | undefined>>;

const MIN_PASS_KEY_SECRET = 32;

/** Required in production, with what each is for. */
export const PRODUCTION_SECRETS: Readonly<Record<string, string>> = {
	FRONTDOOR_PASS_KEY_SECRET: "it signs each tenant's metering pass key",
	ANTHROPIC_API_KEY: "the meter sends every model call with it",
	TAVILY_API_KEY: "the meter sends every web search with it",
	SUPABASE_DB_URL: "accounts and usage live in the database",
};

const isSet = (env: Env, name: string) => typeof env[name] === "string" && env[name] !== "";

/** One message per problem; empty when the wire-up's variables are fine. */
export function wiringEnvProblems(env: Env): string[] {
	const problems: string[] = [];
	if (env.NODE_ENV === "production") {
		for (const [name, purpose] of Object.entries(PRODUCTION_SECRETS)) {
			if (!isSet(env, name)) problems.push(`${name} is not set. It is required in production: ${purpose}.`);
		}
	}
	const secret = env.FRONTDOOR_PASS_KEY_SECRET;
	if (secret && secret.length < MIN_PASS_KEY_SECRET) problems.push(`FRONTDOOR_PASS_KEY_SECRET must be at least ${MIN_PASS_KEY_SECRET} characters.`);
	const dbUrl = env.SUPABASE_DB_URL;
	if (dbUrl && !/^postgres(?:ql)?:\/\//.test(dbUrl)) problems.push("SUPABASE_DB_URL must be a postgres:// connection string.");
	return problems;
}

export const assertWiringEnv: StartupCheck = (env) => {
	const problems = wiringEnvProblems(env);
	if (problems.length > 0) throw new Error(problems.join("\n- "));
};

/** The front door's own required variables (gateway/config.ts), as a start check. */
const assertFrontDoorConfig: StartupCheck = (env) => {
	loadConfig(env);
};

/** Every start check, in order. Any failure stops the start, with every reason listed. */
export const STARTUP_CHECKS: readonly StartupCheck[] = [assertProductionSafe, assertWiringEnv, assertFrontDoorConfig, assertEmailEnv, assertBillingEnv];

export interface WiringConfig {
	production: boolean;
	passKeySecret: string;
	anthropicApiKey: string;
	/** Without it the meter answers searches with 404. */
	tavilyApiKey: string | undefined;
	/** Without it (outside production) accounts and usage stay in memory. */
	supabaseDbUrl: string | undefined;
	/** Variables left out outside production, by name, for one warning at start. */
	missing: string[];
}

export function loadWiringConfig(env: Env): WiringConfig {
	return {
		production: env.NODE_ENV === "production",
		passKeySecret: isSet(env, "FRONTDOOR_PASS_KEY_SECRET") ? (env.FRONTDOOR_PASS_KEY_SECRET as string) : randomBytes(32).toString("base64url"),
		anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
		tavilyApiKey: isSet(env, "TAVILY_API_KEY") ? env.TAVILY_API_KEY : undefined,
		supabaseDbUrl: isSet(env, "SUPABASE_DB_URL") ? env.SUPABASE_DB_URL : undefined,
		missing: Object.keys(PRODUCTION_SECRETS).filter((name) => !isSet(env, name)),
	};
}

export interface Preflight {
	config: FrontDoorConfig;
	wiring: WiringConfig;
}

/** Runs every start check, then reads the settings. Throws one error that lists every problem. */
export function preflight(env: Env): Preflight {
	runStartupChecks(env, STARTUP_CHECKS);
	return { config: loadConfig(env), wiring: loadWiringConfig(env) };
}

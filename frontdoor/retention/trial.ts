/**
 * The trial record's email hash (C2 req 2, D10; trial record decision
 * 2026-11-08). trial_claims keeps an HMAC-SHA256 of the email, keyed with
 * LH_TRIAL_HASH_KEY, and Stripe's card fingerprint, with no tenant link, so
 * the record outlives the day-91 delete and still blocks a second trial.
 *
 * W2-8 calls trialEmailHash(email) when a trial starts, and when it checks
 * for an earlier trial.
 *
 * NEVER CHANGE THE KEY once students have signed up: every stored hash was
 * made with it, so a new key would let every past trial start again.
 *
 * In production the key is required (32+ characters): assertTrialHashKey
 * is one of the front door's start checks (wiring/env.ts). Outside
 * production a missing key falls back to a fixed development key.
 */
import { hashEmailForTrial } from "../db/index.ts";
import type { StartupCheck } from "../gateway/startup-checks.ts";

type Env = Readonly<Record<string, string | undefined>>;

export const TRIAL_HASH_KEY_ENV = "LH_TRIAL_HASH_KEY";
export const MIN_TRIAL_HASH_KEY = 32;
/** Development and tests only. Never valid in production. */
export const DEV_TRIAL_HASH_KEY = "development-only-trial-hash-key-not-for-production";

const isSet = (env: Env) => typeof env[TRIAL_HASH_KEY_ENV] === "string" && env[TRIAL_HASH_KEY_ENV] !== "";

/** One message per problem, naming the variable, never its value. */
export function trialKeyProblems(env: Env): string[] {
	if (!isSet(env)) {
		return env.NODE_ENV === "production" ? [`${TRIAL_HASH_KEY_ENV} is not set. It is required in production: it scrambles each trial email so one email gets one trial.`] : [];
	}
	if ((env[TRIAL_HASH_KEY_ENV] as string).length < MIN_TRIAL_HASH_KEY) return [`${TRIAL_HASH_KEY_ENV} must be at least ${MIN_TRIAL_HASH_KEY} characters.`];
	return [];
}

export const assertTrialHashKey: StartupCheck = (env) => {
	const problems = trialKeyProblems(env);
	if (problems.length > 0) throw new Error(problems.join("\n- "));
};

/** The key to hash with. Throws in production when it is missing or short. */
export function trialHashKey(env: Env = process.env): string {
	const problems = trialKeyProblems(env);
	if (problems.length > 0) throw new Error(problems[0]);
	return isSet(env) ? (env[TRIAL_HASH_KEY_ENV] as string) : DEV_TRIAL_HASH_KEY;
}

/** The trial_claims email hash: 64 hex characters, the same for any case or surrounding spaces. */
export function trialEmailHash(email: string, env: Env = process.env): string {
	return hashEmailForTrial(email, trialHashKey(env));
}

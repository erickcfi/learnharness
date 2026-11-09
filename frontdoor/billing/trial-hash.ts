/**
 * STAND-IN for w2-pause's frontdoor/retention/trial.ts (master, 2026-11-08):
 * billing calls trialEmailHash(email) from there, and LH_TRIAL_HASH_KEY is
 * w2-pause's start check (assertTrialHashKey), not billing's.
 *
 * At the w2-pause merge: change the one import in billing/core.ts to
 * "../retention/trial.ts" and delete this file. Same name, same arguments,
 * same rules: in production a missing or short key throws; outside
 * production a missing key falls back to a fixed development key.
 */
import { hashEmailForTrial } from "../db/index.ts";

type Env = Readonly<Record<string, string | undefined>>;

const KEY = "LH_TRIAL_HASH_KEY";
const MIN = 32;
const DEV_KEY = "development-only-trial-hash-key-not-for-production";

function key(env: Env): string {
	const value = env[KEY];
	if (typeof value !== "string" || value === "") {
		if (env.NODE_ENV === "production") throw new Error(`${KEY} is not set. It is required in production.`);
		return DEV_KEY;
	}
	if (value.length < MIN) throw new Error(`${KEY} must be at least ${MIN} characters.`);
	return value;
}

/** The trial_claims email hash: 64 hex characters, the same for any case or surrounding spaces. */
export function trialEmailHash(email: string, env: Env = process.env): string {
	return hashEmailForTrial(email, key(env));
}

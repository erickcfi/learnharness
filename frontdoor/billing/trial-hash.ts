/**
 * The trial email hash lives in w2-pause's frontdoor/retention/trial.ts
 * (LH_TRIAL_HASH_KEY and its start check, assertTrialHashKey, are there).
 * Billing imports it through this file, so there is one implementation.
 */
export { trialEmailHash } from "../retention/trial.ts";

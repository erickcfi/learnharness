/**
 * Billing settings and fixed names (W2-8, PRD C2).
 *
 * Railway variables (secrets live only there, cross-cutting req 2):
 *   STRIPE_SECRET_KEY      Stripe's secret key (sk_test_... on staging, sk_live_... at launch),
 *                          or a restricted key (rk_...) with the rights in billing/README.md
 *   STRIPE_WEBHOOK_SECRET  the signing secret of the webhook endpoint (whsec_...)
 *   LH_TRIAL_HASH_KEY      keys the one-way hash of each trial email (trial_claims); 32+ characters.
 *                          Never change it: earlier claims would stop matching.
 *   FRONTDOOR_BILLING=off  runs the front door with no Stripe: no plans screen, no trial gate.
 *                          For staging before Stripe test mode is set up. Never at launch.
 *
 * In production all three secrets are required unless FRONTDOOR_BILLING=off.
 * Messages name variables, never their values.
 */
import type { StartupCheck } from "../gateway/startup-checks.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The one Stripe product the three prices belong to. Fixed, so the setup script can find it again. */
export const PRODUCT_ID = "north-aero-ground-tutor";

/** North Aero student coupon: 20% off, forever, all prices (C2 req 7, D13). */
export const STUDENT_COUPON_ID = "north-aero-student-20";

/** Tester coupon: 100% off, forever, 3 redemptions (C2 req 8, D14). A subscription with it skips the trial gate. */
export const TESTER_COUPON_ID = "north-aero-tester-100";

/** Where Stripe sends webhook events. Under /account, the front door's own paths, so the /api login gate is untouched. */
export const WEBHOOK_PATH = "/account/stripe/webhook";

/** The front door's billing actions, behind the same login check as the tutor. */
export const BILLING_PREFIX = "/account/billing";

/** The plans screen (app/account/plans). */
export const PLANS_PATH = "/account/plans";

export interface BillingConfig {
	secretKey: string;
	webhookSecret: string;
	trialHashKey: string;
}

const MIN_TRIAL_HASH_KEY = 32;

const isSet = (env: Env, name: string) => typeof env[name] === "string" && env[name] !== "";

/** True when FRONTDOOR_BILLING=off: no Stripe, no plans screen, no trial gate. */
export function billingOff(env: Env): boolean {
	return env.FRONTDOOR_BILLING === "off";
}

/** One message per problem; empty when the billing variables are fine. */
export function billingEnvProblems(env: Env): string[] {
	const problems: string[] = [];
	const off = billingOff(env);
	if (env.FRONTDOOR_BILLING !== undefined && env.FRONTDOOR_BILLING !== "" && !off) problems.push('FRONTDOOR_BILLING may only be "off" (or not set).');
	if (env.NODE_ENV === "production" && !off) {
		for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "LH_TRIAL_HASH_KEY"]) {
			if (!isSet(env, name)) problems.push(`${name} is not set. Billing needs it in production (or set FRONTDOOR_BILLING=off to run without Stripe).`);
		}
	}
	const key = env.STRIPE_SECRET_KEY;
	if (key && !/^(sk|rk)_(test|live)_/.test(key)) problems.push("STRIPE_SECRET_KEY must be a Stripe secret key (sk_test_, sk_live_) or restricted key (rk_test_, rk_live_).");
	const hook = env.STRIPE_WEBHOOK_SECRET;
	if (hook && !hook.startsWith("whsec_")) problems.push("STRIPE_WEBHOOK_SECRET must be the endpoint's signing secret (whsec_...).");
	const hashKey = env.LH_TRIAL_HASH_KEY;
	if (hashKey && hashKey.length < MIN_TRIAL_HASH_KEY) problems.push(`LH_TRIAL_HASH_KEY must be at least ${MIN_TRIAL_HASH_KEY} characters.`);
	return problems;
}

export const assertBillingEnv: StartupCheck = (env) => {
	const problems = billingEnvProblems(env);
	if (problems.length > 0) throw new Error(problems.join("\n- "));
};

/** The billing settings, or null when billing is off or not configured (allowed outside production). */
export function loadBillingConfig(env: Env): BillingConfig | null {
	if (billingOff(env)) return null;
	if (!isSet(env, "STRIPE_SECRET_KEY") || !isSet(env, "STRIPE_WEBHOOK_SECRET") || !isSet(env, "LH_TRIAL_HASH_KEY")) return null;
	return {
		secretKey: env.STRIPE_SECRET_KEY as string,
		webhookSecret: env.STRIPE_WEBHOOK_SECRET as string,
		trialHashKey: env.LH_TRIAL_HASH_KEY as string,
	};
}

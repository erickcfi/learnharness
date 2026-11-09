/**
 * Stripe setup from the command line (P4-01). See billing/README.md.
 *
 *   STRIPE_SECRET_KEY=sk_test_... \
 *   STRIPE_STUDENT_PROMO_CODE=... STRIPE_TESTER_PROMO_CODE=... \
 *   npm run stripe:setup -w frontdoor -- --dry-run
 *
 * --dry-run  lists what would change and changes nothing
 * --live     required with a live key (sk_live_, rk_live_), so test mode comes first
 *
 * Never run by the tests (they use the stand-in in billing/testing.ts).
 */
import { COUPONS } from "./catalog.ts";
import { applySetup, describeAction, planSetup } from "./setup.ts";
import { createStripeClient } from "./stripe-api.ts";

async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> {
	if (env.NODE_ENV === "test") {
		console.error("The Stripe setup script does not run under NODE_ENV=test.");
		return 1;
	}
	const unknown = argv.filter((a) => a !== "--dry-run" && a !== "--live");
	if (unknown.length > 0) {
		console.error(`Unknown option: ${unknown.join(" ")}. Use --dry-run and, for a live key, --live.`);
		return 1;
	}
	const key = env.STRIPE_SECRET_KEY ?? "";
	const mode = /^(sk|rk)_live_/.test(key) ? "live" : /^(sk|rk)_test_/.test(key) ? "test" : null;
	if (!mode) {
		console.error("Set STRIPE_SECRET_KEY to a Stripe secret key (sk_test_... first, sk_live_... later).");
		return 1;
	}
	if (mode === "live" && !argv.includes("--live")) {
		console.error("This is a LIVE key. Run in test mode first; then add --live to change the live account.");
		return 1;
	}
	const dryRun = argv.includes("--dry-run");
	const stripe = createStripeClient(key);
	const codes = Object.fromEntries(COUPONS.map((c) => [c.id, env[c.codeEnv]]));
	const plan = await planSetup(stripe, { codes });

	console.log(`Stripe ${mode} mode${dryRun ? ", dry run: nothing will change" : ""}.`);
	for (const line of plan.ok) console.log(`  in place: ${line}`);
	for (const line of plan.skipped) console.log(`  skipped:  ${line}`);
	for (const action of plan.actions) console.log(`  ${dryRun ? "would" : "will"}:    ${describeAction(action)}`);
	for (const line of plan.problems) console.log(`  PROBLEM:  ${line}`);
	if (plan.actions.length === 0 && plan.problems.length === 0) console.log("Nothing to change.");
	if (plan.problems.length > 0) return 1;
	if (dryRun || plan.actions.length === 0) return 0;
	await applySetup(stripe, plan, (line) => console.log(`  ${line}`));
	console.log("Done.");
	return 0;
}

if (import.meta.main) {
	main(process.argv.slice(2), process.env).then(
		(code) => process.exit(code),
		(error: unknown) => {
			// Stripe's error message names the problem; it never holds the key.
			console.error(`Stripe setup failed: ${(error as Error).message}`);
			process.exit(1);
		},
	);
}

export { main as runSetupCli };

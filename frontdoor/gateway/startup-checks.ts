/**
 * Checks that run before the front door starts. Any failure stops the
 * start, with every reason listed.
 *
 * PLUG POINT for w1-lockdown (C3 req 9): its production safety check, which
 * refuses to start when LH_PROVIDER_EVENTS, LH_BACKGROUND_CAPTURE or
 * DEEPGRAM_API_KEY is set. Add it to the list in frontdoor/server.ts. (Those
 * variables never reach a tenant server anyway: tenants get an allowlist,
 * see tenants/supervisor.ts.)
 */
export type StartupCheck = (env: Record<string, string | undefined>) => void;

export function runStartupChecks(env: Record<string, string | undefined>, checks: readonly StartupCheck[]): void {
	const problems: string[] = [];
	for (const check of checks) {
		try {
			check(env);
		} catch (error) {
			problems.push((error as Error).message);
		}
	}
	if (problems.length > 0) throw new Error(`The front door will not start:\n- ${problems.join("\n- ")}`);
}

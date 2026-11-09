/**
 * Production safety (PRD C3 requirements 8 and 9, N6, N13).
 *
 * Owner decision, 2026-11-08: the check lives in the front door, with no
 * upstream change.
 *  - assertProductionSafe() runs first thing when the front door starts.
 *    In production it refuses to start while a debug-capture variable or a
 *    Deepgram key is set, so a bad Railway variable fails the deploy.
 *  - tenantServerEnv() builds each tenant server's environment and always
 *    strips those variables, so a tenant server never receives them.
 *
 * "Set" means present with any value, even an empty one. Messages name the
 * variable but never print its value.
 *
 * Framework-free and runnable by plain Node (type stripping).
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Debug captures save private session text (PRD section 4, fact 5). */
export const DEBUG_CAPTURE_VARIABLES = ["LH_PROVIDER_EVENTS", "LH_BACKGROUND_CAPTURE"] as const;
/** Dictation works only with this key (upstream app/api/stt/token). */
export const DICTATION_VARIABLES = ["DEEPGRAM_API_KEY"] as const;
/** Never allowed in production, and never passed to a tenant server. */
export const BLOCKED_VARIABLES: readonly string[] = [...DEBUG_CAPTURE_VARIABLES, ...DICTATION_VARIABLES];

const REASON: Record<string, string> = {
	LH_PROVIDER_EVENTS: "debug captures save private session text (PRD C3 req 9, N6)",
	LH_BACKGROUND_CAPTURE: "debug captures save private session text (PRD C3 req 9, N6)",
	DEEPGRAM_API_KEY: "dictation is off (PRD C3 req 8, N13)",
};

function isSet(env: Env, name: string): boolean {
	return Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined;
}

/** One message per blocked variable that is set in production; empty when safe. */
export function productionSafetyProblems(env: Env): string[] {
	if (env.NODE_ENV !== "production") return [];
	return BLOCKED_VARIABLES.filter((name) => isSet(env, name)).map(
		(name) => `Refusing to start in production: ${name} is set, and ${REASON[name]}. Remove the variable.`,
	);
}

export class ProductionSafetyError extends Error {
	problems: string[];
	constructor(problems: string[]) {
		super(problems.join("\n"));
		this.name = "ProductionSafetyError";
		this.problems = problems;
	}
}

/** Throws ProductionSafetyError when productionSafetyProblems() finds any. */
export function assertProductionSafe(env: Env = process.env): void {
	const problems = productionSafetyProblems(env);
	if (problems.length > 0) throw new ProductionSafetyError(problems);
}

/** A tenant server's environment: base plus extra, without unset values
 *  and without any blocked variable, even one given in extra. */
export function tenantServerEnv(base: Env, extra: Env = {}): Record<string, string> {
	const out: Record<string, string> = {};
	for (const source of [base, extra]) {
		for (const [name, value] of Object.entries(source)) {
			if (value !== undefined && !BLOCKED_VARIABLES.includes(name)) out[name] = value;
		}
	}
	return out;
}

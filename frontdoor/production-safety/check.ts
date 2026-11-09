/**
 * Command-line form of the production start check, for a start script:
 *   node frontdoor/production-safety/check.ts && node <front door server>
 * Exits 1, with one line per problem on stderr, when the check fails.
 */
import { productionSafetyProblems } from "./index.ts";

const problems = productionSafetyProblems(process.env);
for (const problem of problems) process.stderr.write(`${problem}\n`);
process.exitCode = problems.length > 0 ? 1 : 0;

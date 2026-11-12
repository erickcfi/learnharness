/**
 * Node's warnings: process.emitWarning, deprecation and experimental
 * warnings (2026-11-11, a gap left open by PR #25).
 *
 * Node's own printer, its "warning" listener, writes the whole warning
 * (message and detail) as console.error's first argument, which the filter
 * trusts as the code's own message. A warning's text can come from outside
 * our code: a library can put a file path or a student's input in it.
 * preload.ts replaces that printer with one that prints the warning's name
 * and code only, through the console filter (so a tenant's line carries the
 * front door's mark):
 *
 *   (node:1234) DeprecationWarning [code DEP0005]: [message hidden, 112 chars]
 *
 * Node's switches still hold: with --no-warnings or NODE_NO_WARNINGS=1
 * Node adds no printer, and none is added here; with --no-deprecation,
 * deprecation warnings print nothing. Listeners that other code adds later
 * run as before.
 *
 * Framework-free and runnable by plain Node (type stripping).
 */
import { errorLabel, isErrorLike } from "./filter.ts";

const INSTALLED = Symbol.for("north-aero.warning-printer");

/** The one line printed for a warning: its name and code, never its message or detail. */
export function warningLine(warning: unknown, pid: number = process.pid): string {
	const message = isErrorLike(warning) && typeof warning.message === "string" ? warning.message : "";
	return `(node:${pid}) ${errorLabel(warning)}${message ? `: [message hidden, ${message.length} chars]` : ""}`;
}

/** Replaces Node's own warning printer, once per process. */
export function installWarningPrinter(target: Console = console): void {
	const marked = process as NodeJS.Process & { [INSTALLED]?: boolean };
	if (marked[INSTALLED]) return;
	Object.defineProperty(process, INSTALLED, { value: true });
	// preload.ts runs first, so the only listener now is Node's printer. There is none when warnings are off.
	const nodePrinters = process.listeners("warning");
	if (nodePrinters.length === 0) return;
	for (const listener of nodePrinters) process.removeListener("warning", listener);
	process.on("warning", (warning) => {
		// Node's printer skips these too.
		if (!isErrorLike(warning)) return;
		if (warning.name === "DeprecationWarning" && process.noDeprecation) return;
		target.error(warningLine(warning));
	});
}

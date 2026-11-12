/**
 * Uncaught errors and unhandled rejections (PRD cross-cutting requirement 3;
 * the gap noted by the master on 2026-11-08, closed 2026-11-11 for P7).
 *
 * Node's own crash printout writes straight to stderr, past the console
 * filter: a line of source, the error's whole message, and every other
 * field of the error (a request body, for example). preload.ts installs
 * these listeners first, in the front door and in every tenant server.
 *
 *  - While no other code listens for the event, Node would print the error
 *    and stop. The listener prints instead a fixed line, the error's type,
 *    code and stack frames, with the message hidden as the filter hides it,
 *    and stops the process with exit code 1, as Node does.
 *  - Once other code listens too, that code decides, as before. Next.js
 *    listens from the moment its server starts: it prints the error through
 *    the console filter and keeps running. Here the listener only notes a
 *    thrown string, so the filter does not take it for the code's own
 *    message (filter.ts, noteCrashValue).
 *
 * Framework-free and runnable by plain Node (type stripping).
 */
import { writeSync } from "node:fs";
import { formatLogValue, isErrorLike, markLines, noteCrashValue } from "./filter.ts";

const INSTALLED = Symbol.for("north-aero.crash-handlers");

/** Node's exit code for an uncaught exception or an unhandled rejection. */
export const CRASH_EXIT_CODE = 1;

type Kind = "uncaught exception" | "unhandled rejection";

/** What is printed for an uncaught value: a fixed line, then its type, code
 *  and stack frames. No message text and no other field. */
export function crashReport(kind: Kind, value: unknown): string {
	const head = `[crash] ${kind}; the process stops (exit code ${CRASH_EXIT_CODE})`;
	if (isErrorLike(value)) return `${head}\n${formatLogValue(value)}`;
	if (typeof value === "string") return `${head}\nnot an Error: a string of ${value.length} chars`;
	return `${head}\nnot an Error: ${formatLogValue(value)}`;
}

function handle(event: "uncaughtException" | "unhandledRejection", kind: Kind, value: unknown, mark: string | undefined): void {
	noteCrashValue(value);
	// Other code listens too (Next.js): it prints and decides, as before.
	if (process.listenerCount(event) > 1) return;
	try {
		writeSync(2, `${markLines(crashReport(kind, value), mark)}\n`);
	} catch {
		// stderr is gone: nothing more can be printed.
	}
	process.exit(CRASH_EXIT_CODE);
}

export interface CrashHandlerOptions {
	/** Put at the start of every printed line: a tenant server's LH_LOG_MARK. */
	mark?: string | undefined;
}

/** Listens for uncaught exceptions and unhandled rejections, once per process. */
export function installCrashHandlers(options: CrashHandlerOptions = {}): void {
	const marked = process as NodeJS.Process & { [INSTALLED]?: boolean };
	if (marked[INSTALLED]) return;
	Object.defineProperty(process, INSTALLED, { value: true });
	const { mark } = options;
	// A rejected top-level await arrives here too, with origin "unhandledRejection".
	process.on("uncaughtException", (error, origin) => {
		handle("uncaughtException", origin === "unhandledRejection" ? "unhandled rejection" : "uncaught exception", error, mark);
	});
	process.on("unhandledRejection", (reason) => handle("unhandledRejection", "unhandled rejection", reason, mark));
}

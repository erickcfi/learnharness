/**
 * What a tenant server's output may put in the front door's log (master
 * decision on Q6, 2026-11-08; PRD cross-cutting req 3; gaps closed
 * 2026-11-11, P7).
 *
 *  - Only stderr (errors) passes. Stdout is dropped: routine output, and
 *    any echoed session text, would most likely show up there.
 *  - Each tenant server runs the log filter, which starts every line it
 *    prints with this front door's mark (LH_LOG_MARK, random at each front
 *    door start). A marked line passes as "[tenant <id>] <line>", after the
 *    front door's filter too (emails become [email], quoted text becomes
 *    "[text]"), cut to 300 characters.
 *  - A line without the mark did not pass the tenant's filter: Node's own
 *    printout, or a library writing to stderr itself. It may be student
 *    text. A stack frame ("    at name (file:line:col)") passes; any other
 *    line passes as its length only: "[tenant <id>] [line hidden, N chars]".
 *  - At most 100 lines a minute per tenant. Past that, one
 *    "[tenant <id>] N lines suppressed" line at the end of the minute, so a
 *    crash loop cannot flood the logs.
 */
import { randomBytes } from "node:crypto";
import { isStackFrame, redactLogText } from "../log-hygiene/filter.ts";

export const MAX_LINE = 300;
export const LINES_PER_WINDOW = 100;
export const WINDOW_MS = 60_000;
/** A line longer than this with no newline yet is passed (and cut) as it is. */
const MAX_PARTIAL = 4096;

/** A new random line mark: TenantLogOptions.mark, and each tenant's LH_LOG_MARK. */
export function newLogMark(): string {
	return `[lh:${randomBytes(8).toString("hex")}] `;
}

export interface TenantLogOptions {
	log: (line: string) => void;
	/** The mark the tenants' log filter puts on each line. Without it, only stack frames pass as text. */
	mark?: string;
	linesPerWindow?: number;
	windowMs?: number;
}

interface TenantState {
	partial: string;
	windowStart: number;
	count: number;
	suppressed: number;
	timer: NodeJS.Timeout | undefined;
}

/** What one stderr line may put in the log, or undefined for nothing. */
export function tenantLogLine(line: string, mark: string | undefined): string | undefined {
	if (mark && line.startsWith(mark)) {
		const text = line.slice(mark.length);
		return text.trim() ? redactLogText(text).slice(0, MAX_LINE) : undefined;
	}
	if (isStackFrame(line)) return redactLogText(line).slice(0, MAX_LINE);
	return `[line hidden, ${line.length} chars]`;
}

/** A TenantSupervisor onOutput handler. */
export function tenantStderrForwarder(options: TenantLogOptions): (tenantId: string, stream: "stdout" | "stderr", chunk: Buffer) => void {
	const linesPerWindow = options.linesPerWindow ?? LINES_PER_WINDOW;
	const windowMs = options.windowMs ?? WINDOW_MS;
	const tenants = new Map<string, TenantState>();

	function reportSuppressed(tenantId: string, state: TenantState): void {
		if (state.timer) clearTimeout(state.timer);
		state.timer = undefined;
		if (state.suppressed > 0) options.log(`[tenant ${tenantId}] ${state.suppressed} lines suppressed`);
		state.suppressed = 0;
	}

	function pass(tenantId: string, state: TenantState, text: string): void {
		const now = Date.now();
		if (now - state.windowStart >= windowMs) {
			reportSuppressed(tenantId, state);
			state.windowStart = now;
			state.count = 0;
		}
		if (state.count < linesPerWindow) {
			state.count += 1;
			options.log(`[tenant ${tenantId}] ${text}`);
			return;
		}
		state.suppressed += 1;
		if (!state.timer) {
			state.timer = setTimeout(() => reportSuppressed(tenantId, state), Math.max(0, state.windowStart + windowMs - now));
			state.timer.unref();
		}
	}

	return (tenantId, stream, chunk) => {
		if (stream !== "stderr") return;
		let state = tenants.get(tenantId);
		if (!state) {
			state = { partial: "", windowStart: Date.now(), count: 0, suppressed: 0, timer: undefined };
			tenants.set(tenantId, state);
		}
		const lines = (state.partial + chunk.toString("utf8")).split(/\r?\n/);
		state.partial = lines.pop() ?? "";
		if (state.partial.length > MAX_PARTIAL) {
			lines.push(state.partial);
			state.partial = "";
		}
		for (const line of lines) {
			if (!line.trim()) continue;
			const text = tenantLogLine(line, options.mark);
			if (text !== undefined) pass(tenantId, state, text);
		}
	};
}

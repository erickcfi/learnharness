/**
 * What a tenant server's output may put in the front door's log (master
 * decision on Q6, 2026-11-08; PRD cross-cutting req 3).
 *
 *  - Only stderr (errors) passes. Stdout is dropped: routine output, and
 *    any echoed session text, would most likely show up there.
 *  - Each line becomes "[tenant <id>] <line>", after the front door's own
 *    log filter (emails become [email], quoted text becomes "[text]"), cut
 *    to 300 characters. Each tenant server runs that filter too, so most
 *    lines pass it twice; the second pass also covers Node's own crash
 *    printout, which skips the tenant's filter.
 *  - At most 100 lines a minute per tenant. Past that, one
 *    "[tenant <id>] N lines suppressed" line at the end of the minute, so a
 *    crash loop cannot flood the logs.
 *
 * Known gap: student text inside an error message that is not in quotes
 * stays (the same gap as the log filter itself).
 */
import { redactLogText } from "../log-hygiene/filter.ts";

export const MAX_LINE = 300;
export const LINES_PER_WINDOW = 100;
export const WINDOW_MS = 60_000;
/** A line longer than this with no newline yet is passed (and cut) as it is. */
const MAX_PARTIAL = 4096;

export interface TenantLogOptions {
	log: (line: string) => void;
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

	function pass(tenantId: string, state: TenantState, line: string): void {
		const now = Date.now();
		if (now - state.windowStart >= windowMs) {
			reportSuppressed(tenantId, state);
			state.windowStart = now;
			state.count = 0;
		}
		if (state.count < linesPerWindow) {
			state.count += 1;
			options.log(`[tenant ${tenantId}] ${redactLogText(line).slice(0, MAX_LINE)}`);
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
		for (const line of lines) if (line.trim()) pass(tenantId, state, line);
	};
}

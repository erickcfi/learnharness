/**
 * Log hygiene (PRD cross-cutting requirement 3): logs carry no session
 * text and no email addresses.
 *
 * Owner decision, 2026-11-08: one filter wraps console in every tenant
 * server (loaded by preload.ts through `node --import`) and in the front
 * door. No upstream file changes. What it does to each console argument:
 *
 *  - The first argument, when it is a string, is the code's own message or
 *    format string: emails become [email], and quoted text that could be
 *    session text becomes "[text]".
 *  - Later string arguments keep only short tokens without spaces (ids,
 *    codes). Anything longer becomes [text]: it may be raw model or
 *    student text, such as a provider's stderr.
 *  - An error prints as its type, its code, its stack frames (file and
 *    line) and its cause. Its message is hidden, as
 *    "[message hidden, N chars]", unless it is a short token: a message can
 *    be pure student text with no quotes (gap closed 2026-11-11, P7). Other
 *    fields (request and response bodies, headers) are dropped.
 *  - An object prints with its keys, numbers and booleans; its strings
 *    follow the later-argument rule.
 *
 * Node's own crash printout skips console: crash.ts replaces it. In a
 * tenant server, each line the filter prints starts with the front door's
 * mark (LH_LOG_MARK), so the front door can tell it from raw output
 * (wiring/tenant-logs.ts).
 *
 * Known limit: the first argument is trusted as the code's own message.
 * Upstream's own messages print ids, counts and times only (checked at
 * 713377f).
 *
 * Framework-free and runnable by plain Node (type stripping).
 */
import { format, inspect } from "node:util";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const QUOTED = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’/g;
/**
 * One stack frame as V8 prints it: "    at name (file:line:col)",
 * "    at file:line:col", "    at new Name (<anonymous>)" or
 * "    at async Promise.all (index 0)". Names and locations have no spaces,
 * so a line of text that only starts with "at" never matches.
 */
const FRAME = /^\s+at (?:(?:async|new) )?(?:(?:[^\s()]+(?: \[as [^\s\]]+\])? )?\((?:[^\s()]+:\d+(?::\d+)?|<anonymous>|native|index \d+)\)|[^\s()]+:\d+(?::\d+)?)$/;
/** Longest token kept as is: fits a UUID, a chat id or an error code. */
const MAX_TOKEN = 40;
const MAX_DEPTH = 4;
const INSTALLED = Symbol.for("north-aero.log-filter");
const METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/** The variable that gives a tenant server the front door's line mark (wiring/tenant-logs.ts). */
export const LOG_MARK_ENV = "LH_LOG_MARK";

function isToken(text: string): boolean {
	return text.length <= MAX_TOKEN && !/\s/.test(text);
}

/** True for one stack frame line (file and line), which holds no message text. */
export function isStackFrame(line: string): boolean {
	return FRAME.test(line);
}

/** Emails become [email]; quoted text with spaces, or longer than a token, becomes [text]. */
export function redactLogText(text: string): string {
	return text.replace(EMAIL, "[email]").replace(QUOTED, (quoted) => {
		const inner = quoted.slice(1, -1);
		return isToken(inner) ? quoted : `${quoted[0]}[text]${quoted[quoted.length - 1]}`;
	});
}

/** A string that is not the code's own message: keep a short token, else [text]. */
function redactLooseString(text: string): string {
	const cleaned = redactLogText(text);
	return isToken(cleaned) ? cleaned : "[text]";
}

/** Puts the mark at the start of every line. No mark: the text as it is. */
export function markLines(text: string, mark: string | undefined): string {
	return mark ? text.split("\n").map((line) => mark + line).join("\n") : text;
}

/**
 * A string Node is handing to its uncaught-error listeners right now
 * (crash.ts). Next.js's listener prints it as console.error's first
 * argument, which would otherwise count as the code's own message.
 */
let crashString: string | undefined;

/** Called by crash.ts first, before the other listeners print the value. */
export function noteCrashValue(value: unknown): void {
	if (typeof value !== "string") return;
	crashString = value;
	setImmediate(() => {
		if (crashString === value) crashString = undefined;
	}).unref();
}

interface ErrorLike {
	name?: unknown;
	message?: unknown;
	stack?: unknown;
	code?: unknown;
	cause?: unknown;
	errors?: unknown;
}

export function isErrorLike(value: unknown): value is ErrorLike {
	return value instanceof Error || (
		value !== null && typeof value === "object" &&
		typeof (value as ErrorLike).message === "string" && typeof (value as ErrorLike).stack === "string"
	);
}

/** An error message: kept when it is a short token (a code, a word), else
 *  hidden with its length. It can be pure student text, without quotes. */
function hiddenMessage(message: unknown): string {
	if (typeof message !== "string" || message === "") return "";
	const cleaned = redactLogText(message);
	return isToken(cleaned) ? cleaned : `[message hidden, ${message.length} chars]`;
}

/** The frames of an error's stack. The message at the top of the stack is
 *  skipped first, so no line of it can pass as a frame. */
function stackFrames(error: ErrorLike): string[] {
	if (typeof error.stack !== "string") return [];
	let stack = error.stack;
	const message = typeof error.message === "string" ? error.message : "";
	const start = stack.indexOf(": ") + 2;
	if (message && start > 1 && stack.startsWith(message, start)) stack = stack.slice(start + message.length);
	return stack.split("\n").filter(isStackFrame).map(redactLogText);
}

function formatError(error: ErrorLike, depth: number): string {
	const name = typeof error.name === "string" && error.name && isToken(error.name) ? error.name : "Error";
	const message = hiddenMessage(error.message);
	const code = typeof error.code === "string" || typeof error.code === "number" ? ` [code ${redactLooseString(String(error.code))}]` : "";
	const lines = [`${name}${message ? `: ${message}` : ""}${code}`, ...stackFrames(error)];
	if (depth < MAX_DEPTH) {
		if (error.cause !== undefined) lines.push(`  cause: ${isErrorLike(error.cause) ? formatError(error.cause, depth + 1) : formatLogValue(error.cause)}`);
		if (Array.isArray(error.errors)) {
			for (const inner of error.errors) lines.push(`  error: ${isErrorLike(inner) ? formatError(inner, depth + 1) : formatLogValue(inner)}`);
		}
	}
	return lines.join("\n");
}

/** Printed as is by util.inspect (no quotes), for errors nested in objects. */
function raw(text: string): object {
	return { [inspect.custom]: () => text };
}

function scrub(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return redactLooseString(value);
	if (typeof value === "symbol") return value.toString();
	if (typeof value === "function") return raw(`[Function ${value.name || "anonymous"}]`);
	if (value === null || typeof value !== "object") return value;
	if (isErrorLike(value)) return raw(formatError(value, depth));
	if (seen.has(value)) return raw("[Circular]");
	if (depth >= MAX_DEPTH) return raw("[...]");
	seen.add(value);
	if (value instanceof Date) return raw(Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString());
	if (ArrayBuffer.isView(value)) return raw(`[${value.constructor.name} ${value.byteLength} bytes]`);
	if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1, seen));
	if (value instanceof Map) return new Map([...value].map(([k, v]) => [scrub(k, depth + 1, seen), scrub(v, depth + 1, seen)]));
	if (value instanceof Set) return new Set([...value].map((item) => scrub(item, depth + 1, seen)));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[redactLogText(key)] = scrub(item, depth + 1, seen);
	return out;
}

/** One console argument, as safe text. Strings follow the later-argument rule. */
export function formatLogValue(value: unknown): string {
	if (typeof value === "string") return redactLooseString(value);
	if (isErrorLike(value)) return formatError(value, 0);
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
	return redactLogText(inspect(scrub(value, 0, new WeakSet()), { depth: MAX_DEPTH + 1, breakLength: Infinity, compact: true }));
}

/** The arguments of one console call, made safe. A non-string first
 *  argument has % doubled, so util.format cannot read it as a format.
 *  A string Node is reporting as uncaught (noteCrashValue) is not the
 *  code's own message, so it follows the later-argument rule. */
export function filterLogArgs(args: readonly unknown[]): unknown[] {
	return args.map((arg, i) => {
		if (i === 0) return typeof arg === "string" && arg !== crashString ? redactLogText(arg) : formatLogValue(arg).replace(/%/g, "%%");
		return formatLogValue(arg);
	});
}

export interface LogFilterOptions {
	/** Put at the start of every printed line: a tenant server's LH_LOG_MARK. */
	mark?: string | undefined;
}

/** Wrap console's printing methods once per console object. */
export function installLogFilter(target: Console = console, options: LogFilterOptions = {}): void {
	const marked = target as Console & { [INSTALLED]?: boolean };
	if (marked[INSTALLED]) return;
	const { mark } = options;
	for (const method of METHODS) {
		const original = target[method].bind(target) as (...args: unknown[]) => void;
		target[method] = mark
			? (...args: unknown[]) => original("%s", markLines(format(...filterLogArgs(args)), mark))
			: (...args: unknown[]) => original(...filterLogArgs(args));
	}
	const log = target.log;
	target.dir = (item?: unknown) => log(item);
	Object.defineProperty(target, INSTALLED, { value: true });
}

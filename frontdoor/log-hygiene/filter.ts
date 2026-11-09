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
 *  - An error prints as its type, a cleaned message, its code, its stack
 *    frames (file and line) and its cause. Other fields (request and
 *    response bodies, headers) are dropped.
 *  - An object prints with its keys, numbers and booleans; its strings
 *    follow the later-argument rule.
 *
 * Known limits: text that is not quoted inside an error message's first
 * line stays (messages are cut to one line of 300 characters). Upstream's
 * own messages print ids, counts and times only (checked at 713377f).
 * Node's own crash printout for an uncaught error bypasses console.
 *
 * Framework-free and runnable by plain Node (type stripping).
 */
import { inspect } from "node:util";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const QUOTED = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’/g;
/** Longest token kept as is: fits a UUID, a chat id or an error code. */
const MAX_TOKEN = 40;
const MAX_MESSAGE = 300;
const MAX_DEPTH = 4;
const INSTALLED = Symbol.for("north-aero.log-filter");
const METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

function isToken(text: string): boolean {
	return text.length <= MAX_TOKEN && !/\s/.test(text);
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

interface ErrorLike {
	name?: unknown;
	message?: unknown;
	stack?: unknown;
	code?: unknown;
	cause?: unknown;
	errors?: unknown;
}

function isErrorLike(value: unknown): value is ErrorLike {
	return value instanceof Error || (
		value !== null && typeof value === "object" &&
		typeof (value as ErrorLike).message === "string" && typeof (value as ErrorLike).stack === "string"
	);
}

/** An error message's first line, cut to MAX_MESSAGE characters, cleaned.
 *  Later lines often hold dumped request or response bodies. */
function errorMessage(message: unknown): string {
	if (typeof message !== "string") return "";
	const [first = ""] = message.split("\n");
	const cut = first.length > MAX_MESSAGE || message.includes("\n");
	return redactLogText(first.slice(0, MAX_MESSAGE)) + (cut ? " [...]" : "");
}

function formatError(error: ErrorLike, depth: number): string {
	const name = typeof error.name === "string" && error.name ? error.name : "Error";
	const message = errorMessage(error.message);
	const code = typeof error.code === "string" || typeof error.code === "number" ? ` [code ${redactLooseString(String(error.code))}]` : "";
	const frames = typeof error.stack === "string"
		? error.stack.split("\n").filter((line) => /^\s+at /.test(line)).map(redactLogText)
		: [];
	const lines = [`${name}: ${message}${code}`, ...frames];
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
 *  argument has % doubled, so util.format cannot read it as a format. */
export function filterLogArgs(args: readonly unknown[]): unknown[] {
	return args.map((arg, i) => {
		if (i === 0) return typeof arg === "string" ? redactLogText(arg) : formatLogValue(arg).replace(/%/g, "%%");
		return formatLogValue(arg);
	});
}

/** Wrap console's printing methods once per console object. */
export function installLogFilter(target: Console = console): void {
	const marked = target as Console & { [INSTALLED]?: boolean };
	if (marked[INSTALLED]) return;
	for (const method of METHODS) {
		const original = target[method].bind(target) as (...args: unknown[]) => void;
		target[method] = (...args: unknown[]) => original(...filterLogArgs(args));
	}
	const log = target.log;
	target.dir = (item?: unknown) => log(item);
	Object.defineProperty(target, INSTALLED, { value: true });
}

/**
 * The meter's store on the tutor's Supabase database (P2-01, P2-02; C3
 * requirements 4, 6 and 7), with the master's DB-outage rule (2026-11-08):
 *
 * Pause status
 *  - Every check reads the database, with a short time limit, so a pause
 *    or an unpause takes effect at once.
 *  - Each student's last status is remembered for up to 1 minute. It is
 *    used only when the database is down or does not answer in time, so a
 *    short outage does not stop teaching.
 *  - Nothing remembered (for example the first call after a restart) and
 *    the database down: the call is refused (MeteringUnavailableError; the
 *    proxy answers 503). It fails closed.
 *
 * Usage rows (never dropped)
 *  - A row that fails to write is kept in an in-memory queue and retried,
 *    1 s after the failure, then doubling up to 30 s, and at once when a
 *    pause read finds the database back.
 *  - The queue holds MAX_PENDING rows (about 2 MB). When it is full, new
 *    calls are refused (MeteringUnavailableError) until it drains below the
 *    limit. Rows from calls already under way are still kept, so the queue
 *    can pass the limit by those.
 *  - At shutdown the store writes what it can. Rows still waiting go to the
 *    pending file (<volume>/metering/pending-usage.jsonl, owner-only), which
 *    the next start loads and writes. The file is removed once its rows are
 *    in the database.
 *  - A row the database rejects for good (Postgres classes 22 and 23: data
 *    and constraint errors, for example a tenant deleted on day 91 while a
 *    call was in flight) can never be written. The log line gives its
 *    tenant id and the error code only. The full row and the error code are
 *    appended to rejected-usage.jsonl beside the pending file (owner-only),
 *    so its cost can still be seen. It leaves the queue, so it cannot block
 *    the rest.
 *
 * Model rows are stored once even when retried (unique request id). A
 * search row retried after a write that landed but whose answer was lost
 * could count twice; search_usage has no unique id. This is rare.
 *
 * Logs carry tenant ids, counts and error codes only, never session text.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Db, isPaused as readPause, recordModelUsage, recordSearch as insertSearch } from "../db/index.ts";
import { type CallRecord, type MeteringStore, MeteringUnavailableError, type SearchRecord, UNAVAILABLE_MESSAGE } from "./store.ts";

export { MeteringUnavailableError, UNAVAILABLE_MESSAGE };

/** How long a student's pause status is remembered for an outage (master, 2026-11-08). */
export const PAUSE_MEMORY_MS = 60_000;
/** Rows the queue holds before new calls are refused. */
export const MAX_PENDING = 10_000;

export interface SupabaseMeteringStoreOptions {
	pauseMemoryMs?: number;
	/** A pause read slower than this counts as a failure. Default 2 s. */
	readTimeoutMs?: number;
	/** A usage write slower than this is retried. Default 10 s. */
	writeTimeoutMs?: number;
	maxPending?: number;
	/** First retry delay after a failed write. Default 1 s. */
	retryMinMs?: number;
	/** Longest retry delay. Default 30 s. */
	retryMaxMs?: number;
	/** Where rows still waiting at shutdown are saved. Without it they are logged as lost. */
	pendingFile?: string;
	now?: () => number;
	log?: (line: string) => void;
}

/** A MeteringStore that holds usage rows until they are written. */
export interface DurableMeteringStore extends MeteringStore {
	/** Tries now to write every waiting row. Resolves when the queue is empty or a write fails; never throws. */
	flush(): Promise<void>;
	/** Stops retrying, writes what it can, and saves the rest to the pending file. Safe to call twice. */
	close(): Promise<void>;
	/** Rows waiting to be written. */
	pending(): number;
}

type PendingRow = { kind: "call"; call: CallRecord } | { kind: "search"; search: SearchRecord };

class DatabaseTimeout extends Error {
	constructor() {
		super("database did not answer in time");
		this.name = "DatabaseTimeout";
	}
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new DatabaseTimeout()), ms);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** The SQLSTATE code of a Postgres error, or a driver code such as ECONNREFUSED. */
function errorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : ((error as Error | null)?.name ?? "Error");
}

/** Data and constraint errors: a retry can never succeed. */
const isPermanent = (error: unknown) => /^2[23][0-9A-Z]{3}$/.test(errorCode(error));

const tenantOf = (row: PendingRow) => (row.kind === "call" ? row.call.tenantId : row.search.tenantId);

function toLine(row: PendingRow): string {
	return JSON.stringify(row);
}

/** One saved row, or null for a line that is not one. */
function fromLine(line: string): PendingRow | null {
	try {
		const row = JSON.parse(line) as PendingRow;
		if (row.kind === "call" && typeof row.call?.tenantId === "string") return { kind: "call", call: { ...row.call, at: new Date(row.call.at) } };
		if (row.kind === "search" && typeof row.search?.tenantId === "string") return { kind: "search", search: { ...row.search, at: new Date(row.search.at) } };
	} catch {
		// Not JSON: skipped and counted below.
	}
	return null;
}

function writeOwnerOnly(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, content, { mode: 0o600 });
	fs.renameSync(temp, file);
}

export function createSupabaseMeteringStore(db: Db, options: SupabaseMeteringStoreOptions = {}): DurableMeteringStore {
	const pauseMemoryMs = options.pauseMemoryMs ?? PAUSE_MEMORY_MS;
	const readTimeoutMs = options.readTimeoutMs ?? 2_000;
	const writeTimeoutMs = options.writeTimeoutMs ?? 10_000;
	const maxPending = options.maxPending ?? MAX_PENDING;
	const retryMinMs = options.retryMinMs ?? 1_000;
	const retryMaxMs = options.retryMaxMs ?? 30_000;
	const now = options.now ?? (() => Date.now());
	const log = options.log ?? ((line: string) => console.error(line));
	const pendingFile = options.pendingFile;
	const rejectedFile = pendingFile ? path.join(path.dirname(pendingFile), "rejected-usage.jsonl") : undefined;

	const remembered = new Map<string, { paused: boolean; at: number }>();
	const queue: PendingRow[] = [];
	let draining: Promise<void> | null = null;
	let timer: NodeJS.Timeout | null = null;
	let delay = retryMinMs;
	let outage = false;
	let closed = false;
	let closing: Promise<void> | null = null;

	async function write(row: PendingRow): Promise<void> {
		if (row.kind === "call") {
			const c = row.call;
			await recordModelUsage(db, {
				tenantId: c.tenantId,
				occurredAt: c.at,
				model: c.model,
				inputTokens: c.inputTokens,
				outputTokens: c.outputTokens,
				cacheReadTokens: c.cacheReadTokens,
				cacheWriteTokens: c.cacheWriteTokens,
				cacheWrite1hTokens: c.cacheWrite1hTokens,
				costUsd: c.dollars,
				requestId: c.requestId,
			});
		} else {
			await insertSearch(db, { tenantId: row.search.tenantId, occurredAt: row.search.at });
		}
	}

	function setAside(row: PendingRow, error: unknown): void {
		log(`metering: the database refused a ${row.kind} row for tenant ${tenantOf(row)} for good (${errorCode(error)}); set aside, not retried`);
		if (!rejectedFile) return;
		try {
			fs.mkdirSync(path.dirname(rejectedFile), { recursive: true, mode: 0o700 });
			// The full row and the error code, so the cost can still be seen later (master, 2026-11-08).
			fs.appendFileSync(rejectedFile, `${JSON.stringify({ ...row, errorCode: errorCode(error) })}\n`, { mode: 0o600 });
		} catch (fileError) {
			log(`metering: could not save the refused row (${errorCode(fileError)})`);
		}
	}

	function schedule(ms: number): void {
		if (closed || timer) return;
		timer = setTimeout(() => {
			timer = null;
			void drain();
		}, ms);
		timer.unref();
	}

	function writeFailed(error: unknown): void {
		if (!outage) log(`metering: usage rows could not be written (${errorCode(error)}); ${queue.length} waiting, retrying`);
		outage = true;
		schedule(delay);
		delay = Math.min(delay * 2, retryMaxMs);
	}

	function emptied(): void {
		if (outage) log("metering: the database is back; every waiting usage row is written");
		outage = false;
		delay = retryMinMs;
		if (!pendingFile) return;
		try {
			fs.rmSync(pendingFile, { force: true });
		} catch (error) {
			log(`metering: could not clear the pending usage file (${errorCode(error)})`);
		}
	}

	async function writeQueue(): Promise<void> {
		while (queue.length > 0) {
			const row = queue[0] as PendingRow;
			try {
				await withTimeout(write(row), writeTimeoutMs);
			} catch (error) {
				if (!isPermanent(error)) return writeFailed(error);
				setAside(row, error);
			}
			queue.shift();
		}
		emptied();
	}

	/** Writes the queue in order, one row at a time. Only one runs at once. */
	function drain(): Promise<void> {
		// .finally runs after this assignment, even when the queue is already empty.
		draining ??= writeQueue().finally(() => {
			draining = null;
		});
		return draining;
	}

	/** Writes a row now, or keeps it for a retry. Never throws. */
	async function keep(row: PendingRow): Promise<void> {
		if (queue.length > 0) {
			// An outage is on: keep the order, and let the retry write it.
			queue.push(row);
			schedule(delay);
			return;
		}
		try {
			await withTimeout(write(row), writeTimeoutMs);
		} catch (error) {
			if (isPermanent(error)) return setAside(row, error);
			queue.push(row);
			writeFailed(error);
		}
	}

	function loadPending(file: string): void {
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`metering: could not read the pending usage file (${errorCode(error)})`);
			return;
		}
		let skipped = 0;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const row = fromLine(line);
			if (row) queue.push(row);
			else skipped += 1;
		}
		log(`metering: loaded ${queue.length} usage rows saved at the last shutdown${skipped ? ` (${skipped} unreadable lines skipped)` : ""}`);
		if (queue.length > 0) schedule(0);
	}

	if (pendingFile) loadPending(pendingFile);

	return {
		async isPaused(tenantId) {
			if (queue.length >= maxPending) throw new MeteringUnavailableError(`${queue.length} usage rows are waiting to be written`);
			let paused: boolean;
			try {
				paused = await withTimeout(readPause(db, tenantId), readTimeoutMs);
			} catch (error) {
				const memo = remembered.get(tenantId);
				if (memo && now() - memo.at <= pauseMemoryMs) return memo.paused;
				throw new MeteringUnavailableError(`pause status for tenant ${tenantId} could not be read (${errorCode(error)})`);
			}
			remembered.set(tenantId, { paused, at: now() });
			// The database answered: write anything still waiting now.
			if (queue.length > 0 && !draining) {
				if (timer) clearTimeout(timer);
				timer = null;
				void drain();
			}
			return paused;
		},
		recordCall: (call) => keep({ kind: "call", call: { ...call } }),
		recordSearch: (search) => keep({ kind: "search", search: { ...search } }),
		pending: () => queue.length,
		async flush() {
			if (timer) clearTimeout(timer);
			timer = null;
			await drain();
		},
		close() {
			closing ??= (async () => {
				closed = true;
				if (timer) clearTimeout(timer);
				timer = null;
				await drain();
				if (queue.length === 0) return;
				if (!pendingFile) {
					log(`metering: ${queue.length} usage rows could not be written before shutdown and are lost`);
					return;
				}
				try {
					writeOwnerOnly(pendingFile, `${queue.map(toLine).join("\n")}\n`);
					log(`metering: ${queue.length} usage rows saved to the pending file for the next start`);
				} catch (error) {
					log(`metering: ${queue.length} usage rows could not be saved (${errorCode(error)}) and are lost`);
				}
			})();
			return closing;
		},
	};
}

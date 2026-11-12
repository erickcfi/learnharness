/**
 * What a tenant may do right now (P2-05, P1-08; C3 req 6, C1 req 6):
 *
 *   open       study as normal
 *   paused     an open pause (autopause or the Owner): no new turns or
 *              jobs; read, print and export still work (D16)
 *   retention  the plan ended: export and print only, until
 *              retentionEndsAt; `expired` once that time has passed and the
 *              day-91 job has not run yet
 *   gone       no tenant row: deleted on day 91 (or never existed)
 *
 * Retention wins over a pause. W2-8 can add states here (for example
 * "trial time used up") without touching the gateway.
 *
 * The Owner's own tenant (owner role, db/accounts.ts isOwnerTenant) never
 * reads as retention, so it never gets the plan-ended screen and the meter
 * does not refuse it for that. A pause (autopause or the Owner) still
 * applies. Staff is not exempt.
 *
 * The reader remembers each answer for a few seconds, so a page load does
 * not always cost a database read, and for up to a minute when the
 * database is down. With nothing remembered and the database down it
 * throws AccessUnavailableError; each caller decides what that means (the
 * screens fail open, because the meter's own pause check fails closed).
 */
import { type Db, isOwnerTenant, type PauseReason } from "../db/index.ts";
import { one } from "../db/db.ts";

export type TenantAccess =
	| { state: "open" }
	| { state: "paused"; reason: PauseReason; pausedAt: Date }
	| { state: "retention"; retentionEndsAt: Date; expired: boolean }
	| { state: "gone" };

const asDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

export async function readTenantAccess(db: Db, tenantId: string, now: Date = new Date()): Promise<TenantAccess> {
	const row = await one(
		db,
		`select t.status, t.retention_ends_at, p.reason, p.paused_at
		 from tenants t left join pauses p on p.tenant_id = t.id and p.unpaused_at is null
		 where t.id = $1`,
		[tenantId],
	);
	if (!row) return { state: "gone" };
	if (row.status === "retention" && row.retention_ends_at && !(await isOwnerTenant(db, tenantId))) {
		const retentionEndsAt = asDate(row.retention_ends_at);
		return { state: "retention", retentionEndsAt, expired: retentionEndsAt.getTime() <= now.getTime() };
	}
	if (row.paused_at) return { state: "paused", reason: row.reason as PauseReason, pausedAt: asDate(row.paused_at) };
	return { state: "open" };
}

export class AccessUnavailableError extends Error {
	constructor(tenantId: string, code: string) {
		super(`access for tenant ${tenantId} could not be read (${code})`);
		this.name = "AccessUnavailableError";
	}
}

export interface AccessReader {
	read(tenantId: string): Promise<TenantAccess>;
	/** Drop what is remembered for one tenant (after a pause, unpause or retention change in this process). */
	forget(tenantId: string): void;
}

export interface AccessReaderOptions {
	db: Db;
	/** How long an answer is reused without asking the database. Default 5 s. */
	ttlMs?: number;
	/** How long an answer is used while the database is down. Default 60 s. */
	outageMs?: number;
	/** A read slower than this counts as a failure. Default 2 s. */
	readTimeoutMs?: number;
	now?: () => number;
}

function errorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : ((error as Error | null)?.name ?? "Error");
}

export function createAccessReader(options: AccessReaderOptions): AccessReader {
	const ttlMs = options.ttlMs ?? 5_000;
	const outageMs = options.outageMs ?? 60_000;
	const readTimeoutMs = options.readTimeoutMs ?? 2_000;
	const now = options.now ?? (() => Date.now());
	const remembered = new Map<string, { access: TenantAccess; at: number }>();

	async function readWithTimeout(tenantId: string): Promise<TenantAccess> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), readTimeoutMs);
		});
		try {
			return await Promise.race([readTenantAccess(options.db, tenantId, new Date(now())), timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		async read(tenantId) {
			const memo = remembered.get(tenantId);
			if (memo && now() - memo.at < ttlMs) return memo.access;
			try {
				const access = await readWithTimeout(tenantId);
				remembered.set(tenantId, { access, at: now() });
				return access;
			} catch (error) {
				if (memo && now() - memo.at <= outageMs) return memo.access;
				throw new AccessUnavailableError(tenantId, errorCode(error));
			}
		},
		forget(tenantId) {
			remembered.delete(tenantId);
		},
	};
}

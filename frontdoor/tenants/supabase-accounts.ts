/**
 * The AccountStore on the tutor's Supabase database (PRD C1 req 2, 5, 7,
 * D28). Wired into the front door by wiring/front-door.ts when
 * SUPABASE_DB_URL is set (always, in production).
 *
 * A plain mapping onto frontdoor/db, whose calls are safe to repeat and to
 * run twice at once (two tabs on a first login):
 *   get          getAccountByClerkUserId + getTenantByAccountId
 *   confirmAge   ensureStudentAccount: makes the account and its tenant on
 *                the first call, keeps the first 18+ date after that
 *   assignTenant the account's tenant. An account with no tenant (one made
 *                by createAccount, such as the Owner's) gets one.
 * Tenant ids are the UUIDs the database makes.
 */
import { type Db, ensureStudentAccount, getAccountByClerkUserId, getTenantByAccountId, getTenantByClerkUserId } from "../db/index.ts";
import { type Account, type AccountStore, AgeNotConfirmedError } from "./accounts.ts";

export class SupabaseAccountStore implements AccountStore {
	readonly #db: Db;

	constructor(db: Db) {
		this.#db = db;
	}

	async get(userId: string): Promise<Account | null> {
		const account = await getAccountByClerkUserId(this.#db, userId);
		if (!account) return null;
		const tenant = await getTenantByAccountId(this.#db, account.id);
		return { userId, tenantId: tenant?.id ?? null, ageConfirmedAt: account.age18ConfirmedAt, createdAt: account.createdAt };
	}

	async confirmAge(userId: string, at: Date): Promise<Account> {
		const { account, tenant } = await ensureStudentAccount(this.#db, { clerkUserId: userId, age18ConfirmedAt: at });
		return { userId, tenantId: tenant.id, ageConfirmedAt: account.age18ConfirmedAt, createdAt: account.createdAt };
	}

	async assignTenant(userId: string): Promise<string> {
		const tenant = await getTenantByClerkUserId(this.#db, userId);
		if (tenant) return tenant.id;
		const account = await getAccountByClerkUserId(this.#db, userId);
		if (!account) throw new AgeNotConfirmedError(userId);
		const made = await ensureStudentAccount(this.#db, { clerkUserId: userId, age18ConfirmedAt: account.age18ConfirmedAt });
		return made.tenant.id;
	}
}

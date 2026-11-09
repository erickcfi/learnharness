/**
 * Accounts and their tenants (PRD C1 req 2 and 7, D28).
 *
 * One login (a Clerk user ID) maps to one account, and one account to one
 * tenant. An account gets a tenant only after its 18+ tick is saved, with
 * its date (Owner, 2026-11-08).
 *
 * The front door talks to the AccountStore interface only. Production uses
 * the Supabase store (supabase-accounts.ts). The in-memory store below
 * serves tests and local runs without SUPABASE_DB_URL.
 */
import { createHash } from "node:crypto";

export interface Account {
	/** The Clerk user ID. */
	userId: string;
	/** A UUID once assigned (assignTenant), else null. */
	tenantId: string | null;
	/** When the student ticked "I am 18 or older". */
	ageConfirmedAt: Date | null;
	createdAt: Date;
}

export class AgeNotConfirmedError extends Error {
	constructor(userId: string) {
		super(`Account ${userId} has not confirmed it is 18 or older.`);
		this.name = "AgeNotConfirmedError";
	}
}

export interface AccountStore {
	get(userId: string): Promise<Account | null>;
	/** Saves the 18+ tick, creating the account if needed. Keeps the first date. */
	confirmAge(userId: string, at: Date): Promise<Account>;
	/** Returns the account's tenant, creating it on first call. Throws AgeNotConfirmedError before the tick. */
	assignTenant(userId: string): Promise<string>;
}

/** A fixed namespace, so the same login always derives the same tenant ID. */
const TENANT_NAMESPACE = Buffer.from("6f1c2a4e8b3d4f5a9c7e1b2d3a4f5e6c", "hex");

/** A name-based UUID (RFC 9562 version 5) of the login. Stable across front
 *  door restarts, so the in-memory store finds the same tenant folder again. */
function tenantIdFor(userId: string): string {
	const hash = createHash("sha1").update(TENANT_NAMESPACE).update(userId, "utf8").digest();
	hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
	hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
	const hex = hash.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Stand-in store. A restart forgets the 18+ dates (students tick again),
 *  but each login still finds its own tenant folder. */
export class InMemoryAccountStore implements AccountStore {
	readonly #accounts = new Map<string, Account>();

	async get(userId: string): Promise<Account | null> {
		const account = this.#accounts.get(userId);
		return account ? { ...account } : null;
	}

	async confirmAge(userId: string, at: Date): Promise<Account> {
		const existing = this.#accounts.get(userId);
		const account: Account = existing ?? { userId, tenantId: null, ageConfirmedAt: null, createdAt: new Date() };
		if (!account.ageConfirmedAt) account.ageConfirmedAt = new Date(at.getTime());
		this.#accounts.set(userId, account);
		return { ...account };
	}

	async assignTenant(userId: string): Promise<string> {
		const account = this.#accounts.get(userId);
		if (!account?.ageConfirmedAt) throw new AgeNotConfirmedError(userId);
		if (!account.tenantId) account.tenantId = tenantIdFor(userId);
		return account.tenantId;
	}
}

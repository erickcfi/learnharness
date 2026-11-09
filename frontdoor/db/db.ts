/**
 * The tutor's database link (C1 req 7, PD5).
 *
 * Owner's choice (2026-11-08): the server talks to Supabase over a direct
 * Postgres connection (Supabase's session pooler), not the Data API. Every
 * data-access function takes a `Db` first, so tests run the exact same SQL on
 * an in-process Postgres (see testing.ts) and production runs it through
 * postgres.js.
 */

import type postgres from "postgres";

export type Row = Record<string, unknown>;

export interface Db {
	/** Run one SQL statement with $1-style parameters and return its rows. */
	query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
	/**
	 * Run fn inside one transaction: all of its writes land, or none do. A
	 * call made on a transaction's Db joins that transaction.
	 */
	transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

type PgParams = Parameters<postgres.Sql["unsafe"]>[1];

/** postgres.js returns its own array subclass; callers get a plain array. */
async function plainRows<T>(pending: PromiseLike<readonly unknown[]>): Promise<T[]> {
	return [...(await pending)] as T[];
}

function txDb(tx: postgres.TransactionSql): Db {
	const self: Db = {
		async query<T extends Row = Row>(text: string, params: readonly unknown[] = []) {
			return plainRows<T>(tx.unsafe(text, params as PgParams));
		},
		transaction: (fn) => fn(self),
	};
	return self;
}

/**
 * Wrap a postgres.js client. Create the client with the Supabase session
 * pooler connection string from a Railway variable, for example:
 *
 *     const db = fromPostgresJs(postgres(process.env.SUPABASE_DB_URL!));
 */
export function fromPostgresJs(sql: postgres.Sql): Db {
	return {
		async query<T extends Row = Row>(text: string, params: readonly unknown[] = []) {
			return plainRows<T>(sql.unsafe(text, params as PgParams));
		},
		async transaction<T>(fn: (tx: Db) => Promise<T>) {
			return (await sql.begin((tx) => fn(txDb(tx)))) as T;
		},
	};
}

/** First row, or null. */
export async function one<T extends Row>(db: Db, text: string, params?: readonly unknown[]): Promise<T | null> {
	const rows = await db.query<T>(text, params);
	return rows[0] ?? null;
}

/** First row, or an error when the statement returned none. */
export async function must<T extends Row>(db: Db, text: string, params?: readonly unknown[]): Promise<T> {
	const row = await one<T>(db, text, params);
	if (!row) throw new Error("expected a row, got none");
	return row;
}

/** numeric and bigint come back as strings from some drivers; money and IDs are numbers here. */
export function num(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v === "bigint") return Number(v);
	if (typeof v === "string") return Number(v);
	throw new TypeError(`not a number: ${String(v)}`);
}

export function numOrNull(v: unknown): number | null {
	return v === null || v === undefined ? null : num(v);
}

export function date(v: unknown): Date {
	if (v instanceof Date) return v;
	if (typeof v === "string" || typeof v === "number") return new Date(v);
	throw new TypeError(`not a date: ${String(v)}`);
}

export function dateOrNull(v: unknown): Date | null {
	return v === null || v === undefined ? null : date(v);
}

export function strOrNull(v: unknown): string | null {
	return v === null || v === undefined ? null : String(v);
}

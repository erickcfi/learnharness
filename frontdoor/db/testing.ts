/**
 * A fresh tutor database for tests: an in-process Postgres (PGlite) with
 * Supabase's roles and every migration applied. Use it from any package's
 * tests:
 *
 *     const t = await createTestDb();
 *     await recordModelUsage(t.db, { ... });
 *     await t.close();
 *
 * Test code only. Production uses fromPostgresJs (db.ts).
 */

import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Db, Row } from "./db.ts";
import { readMigrations } from "./migrations.ts";

/**
 * Supabase's three API roles, set up the way older Supabase projects grant
 * them: full rights on every new table in public. The migrations must take
 * those rights away themselves, so the tests prove the lockdown works even
 * on such a project. Safe to run more than once on one server.
 */
export const SUPABASE_ROLES_SQL = `
do $$
begin
	if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
	if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
	if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end
$$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

type PgQueryable = Pick<PGlite, "query"> | Pick<Transaction, "query">;

function queryVia(pg: PgQueryable) {
	return async <T extends Row = Row>(text: string, params: readonly unknown[] = []) => {
		const res = await pg.query<T>(text, params as unknown[]);
		return res.rows;
	};
}

/** Wrap a PGlite instance as a Db. A nested transaction joins the outer one. */
export function fromPGlite(pg: PGlite): Db {
	return {
		query: queryVia(pg),
		transaction<T>(fn: (tx: Db) => Promise<T>) {
			return pg.transaction(async (tx) => {
				const inner: Db = { query: queryVia(tx), transaction: (f) => f(inner) };
				return fn(inner);
			});
		},
	};
}

export interface TestDb {
	db: Db;
	/** The raw PGlite instance, for role switching in RLS tests. */
	pg: PGlite;
	close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
	const pg = new PGlite();
	await pg.exec(SUPABASE_ROLES_SQL);
	for (const m of readMigrations()) {
		try {
			await pg.exec(m.sql);
		} catch (err) {
			throw new Error(`migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
		}
	}
	return { db: fromPGlite(pg), pg, close: () => pg.close() };
}

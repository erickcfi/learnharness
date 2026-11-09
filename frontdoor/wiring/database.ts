/**
 * The front door's one database client (PRD C1 req 7, PD5). Supabase's
 * session pooler, through postgres.js, as frontdoor/db expects
 * (fromPostgresJs). The connection string comes from SUPABASE_DB_URL and
 * is never logged.
 *
 * - TLS: required in production, because the link crosses the internet
 *   (Railway to Supabase). A URL that sets sslmode itself keeps its own.
 * - At most 5 connections, so the pooler keeps room for the Supabase CLI
 *   and later jobs.
 * - postgres.js connects on the first query, so a database that is down at
 *   start does not stop the front door; the meter's outage rules apply.
 */
import postgres from "postgres";
import { type Db, fromPostgresJs } from "../db/index.ts";

export interface DatabaseConnection {
	db: Db;
	close(): Promise<void>;
}

export const MAX_CONNECTIONS = 5;

/** The postgres.js options for a connection string (exported for tests). */
export function connectionOptions(url: string, opts: { production: boolean }): postgres.Options<Record<string, never>> {
	const query = new URL(url).searchParams;
	const urlSetsTls = query.has("sslmode") || query.has("ssl");
	return {
		max: MAX_CONNECTIONS,
		connect_timeout: 10,
		idle_timeout: 60,
		onnotice: () => {},
		...(opts.production && !urlSetsTls ? { ssl: "require" as const } : {}),
	};
}

export function connectDatabase(url: string, opts: { production: boolean }): DatabaseConnection {
	const sql = postgres(url, connectionOptions(url, opts));
	return { db: fromPostgresJs(sql), close: () => sql.end({ timeout: 5 }) };
}

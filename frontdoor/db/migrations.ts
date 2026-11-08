/**
 * Read the tutor's Supabase migrations from frontdoor/supabase/migrations/.
 * Supabase's CLI applies the same files to the hosted project; tests apply
 * them to a fresh in-process Postgres.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

export interface Migration {
	name: string;
	sql: string;
}

/** Every .sql migration, sorted by name (the timestamp prefix sets the order). */
export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.sort()
		.map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), "utf8") }));
}

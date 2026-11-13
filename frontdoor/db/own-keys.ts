/**
 * A student's own Anthropic API key, encrypted (2026-11-13; migration
 * 20261113000100, docs/decisions/2026-11-13-own-ai-key.md). This module
 * stores and reads the sealed bytes only. Sealing and opening happen in
 * frontdoor/own-key/crypto.ts, with a secret the database never sees.
 */

import { date, type Db, one, type Row } from "./db.ts";
import { isMissingOwnKeySchema } from "./usage.ts";

export interface OwnAiKeyRow {
	tenantId: string;
	provider: "anthropic";
	ciphertext: Buffer;
	iv: Buffer;
	authTag: Buffer;
	/** The key's last 4 characters, the only part kept in clear. */
	last4: string;
	createdAt: Date;
	updatedAt: Date;
}

/** bytea comes back as a Buffer (postgres.js) or a Uint8Array (PGlite). */
function bytes(v: unknown): Buffer {
	if (v instanceof Uint8Array) return Buffer.from(v);
	throw new TypeError("not bytes");
}

function toRow(r: Row): OwnAiKeyRow {
	return {
		tenantId: String(r.tenant_id),
		provider: "anthropic",
		ciphertext: bytes(r.ciphertext),
		iv: bytes(r.iv),
		authTag: bytes(r.auth_tag),
		last4: String(r.last4),
		createdAt: date(r.created_at),
		updatedAt: date(r.updated_at),
	};
}

const COLS = "tenant_id, provider, ciphertext, iv, auth_tag, last4, created_at, updated_at";

export async function getOwnAiKey(db: Db, tenantId: string): Promise<OwnAiKeyRow | null> {
	const r = await one(db, `select ${COLS} from own_ai_keys where tenant_id = $1`, [tenantId]);
	return r ? toRow(r) : null;
}

/** Save the tenant's key, or replace the one saved. created_at keeps the first save. */
export async function saveOwnAiKey(
	db: Db,
	k: { tenantId: string; ciphertext: Buffer; iv: Buffer; authTag: Buffer; last4: string; at?: Date },
): Promise<OwnAiKeyRow> {
	const at = k.at ?? new Date();
	const r = await one(
		db,
		`insert into own_ai_keys (tenant_id, provider, ciphertext, iv, auth_tag, last4, created_at, updated_at)
		 values ($1, 'anthropic', $2, $3, $4, $5, $6, $6)
		 on conflict (tenant_id) do update set ciphertext = excluded.ciphertext, iv = excluded.iv, auth_tag = excluded.auth_tag,
		   last4 = excluded.last4, updated_at = greatest(excluded.updated_at, own_ai_keys.created_at)
		 returning ${COLS}`,
		[k.tenantId, k.ciphertext, k.iv, k.authTag, k.last4, at],
	);
	if (!r) throw new Error("expected a row, got none");
	return toRow(r);
}

/** The student removes their key. False when none was saved. */
export async function removeOwnAiKey(db: Db, tenantId: string): Promise<boolean> {
	return (await db.query("delete from own_ai_keys where tenant_id = $1 returning tenant_id", [tenantId])).length > 0;
}

/** Tenants with a key saved now, for the dashboard's "Own key" mark. Empty before the migration. */
export async function listOwnAiKeyTenants(db: Db): Promise<Set<string>> {
	try {
		return new Set((await db.query("select tenant_id from own_ai_keys")).map((r) => String(r.tenant_id)));
	} catch (error) {
		if (isMissingOwnKeySchema(error)) return new Set();
		throw error;
	}
}

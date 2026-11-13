/**
 * The own-key store on the tutor's database (own_ai_keys, migration
 * 20261113000100). Before that migration is applied, a read finds no key
 * (and logs it once), so the meter keeps using North Aero's key; a save
 * fails and the page says so.
 */
import { type Db, getOwnAiKey, isMissingOwnKeySchema, removeOwnAiKey, saveOwnAiKey } from "../db/index.ts";
import type { OwnKeyStore } from "./service.ts";

export function databaseOwnKeyStore(db: Db, options: { log?: (line: string) => void } = {}): OwnKeyStore {
	const log = options.log ?? ((line: string) => console.error(line));
	let warned = false;
	return {
		async get(tenantId) {
			try {
				const row = await getOwnAiKey(db, tenantId);
				return row ? { ciphertext: row.ciphertext, iv: row.iv, tag: row.authTag, last4: row.last4, savedAt: row.updatedAt } : null;
			} catch (error) {
				if (!isMissingOwnKeySchema(error)) throw error;
				if (!warned) log("own key: the own_ai_keys table is missing; apply migration 20261113000100. Every call uses North Aero's key until then.");
				warned = true;
				return null;
			}
		},
		async put(tenantId, key, at) {
			await saveOwnAiKey(db, { tenantId, ciphertext: key.ciphertext, iv: key.iv, authTag: key.tag, last4: key.last4, at });
		},
		remove: (tenantId) => removeOwnAiKey(db, tenantId),
	};
}

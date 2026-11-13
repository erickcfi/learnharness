/**
 * A student's own Anthropic key (master decision, 2026-11-13;
 * docs/decisions/2026-11-13-own-ai-key.md).
 *
 *  - save: the pasted text must look like a Console API key, then one free
 *    call to Anthropic checks it (check.ts), then it is sealed (crypto.ts)
 *    and stored. At most 5 checks per student in 10 minutes, so the page
 *    cannot be used to test many keys.
 *  - status: whether own keys are on, and the saved key's last 4
 *    characters and date. Never more of the key.
 *  - forCall: the meter's question for each Anthropic call. The key is
 *    opened for that call only and never kept in clear. The store is read
 *    on every call, so a save or a removal takes effect at once. The DB
 *    outage rule is the pause check's (metering/supabase-store.ts): the
 *    last answer per student is remembered for 1 minute and used only when
 *    the database is down or slow; with nothing remembered the call is
 *    refused (MeteringUnavailableError, a 503 from the meter).
 *
 * With no LH_OWN_KEY_SECRET the feature is off: nothing is read or saved,
 * and every call uses North Aero's key.
 *
 * Logs carry tenant ids, counts and error classes only, never a key.
 */
import { errorLabel } from "../log-hygiene/filter.ts";
import type { CallKey, OwnKeySource } from "../metering/proxy.ts";
import { MeteringUnavailableError } from "../metering/store.ts";
import type { SaveProblem } from "./copy.ts";
import type { KeyCheck } from "./check.ts";
import { anthropicApiKeyFrom, OwnKeyUnreadableError, openOwnKey, type SealedKey, sealOwnKey } from "./crypto.ts";

/** One saved key as the store keeps it: sealed bytes and the last 4 characters. */
export interface StoredOwnKey extends SealedKey {
	savedAt: Date;
}

export interface OwnKeyStore {
	get(tenantId: string): Promise<StoredOwnKey | null>;
	put(tenantId: string, key: SealedKey, at: Date): Promise<void>;
	/** False when none was saved. */
	remove(tenantId: string): Promise<boolean>;
}

export interface OwnKeyStatus {
	/** False when LH_OWN_KEY_SECRET is not set. */
	enabled: boolean;
	/** The saved key's last 4 characters and when it was saved, or null. */
	saved: { last4: string; savedAt: Date } | null;
}

export type SaveResult = { ok: true; last4: string } | { ok: false; problem: SaveProblem };

export interface OwnKeys extends OwnKeySource {
	readonly enabled: boolean;
	status(tenantId: string): Promise<OwnKeyStatus>;
	save(tenantId: string, pasted: string): Promise<SaveResult>;
	remove(tenantId: string): Promise<boolean>;
}

/** How long a student's last answer is remembered for a database outage (as the pause check). */
export const OWN_KEY_MEMORY_MS = 60_000;
/** Key checks a student may run in CHECK_WINDOW_MS. */
export const MAX_CHECKS = 5;
export const CHECK_WINDOW_MS = 10 * 60_000;

export interface OwnKeysOptions {
	/** 32 bytes from LH_OWN_KEY_SECRET, or null: own keys off. */
	secret: Buffer | null;
	store: OwnKeyStore;
	check: KeyCheck;
	/** A read slower than this counts as a failure. Default 2 s. */
	readTimeoutMs?: number;
	memoryMs?: number;
	now?: () => number;
	log?: (line: string) => void;
}

class StoreTimeout extends Error {
	constructor() {
		super("the own-key store did not answer in time");
		this.name = "StoreTimeout";
	}
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new StoreTimeout()), ms);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const NORTH_AERO: CallKey = { kind: "north-aero" };

export function createOwnKeys(options: OwnKeysOptions): OwnKeys {
	const { secret, store, check } = options;
	const readTimeoutMs = options.readTimeoutMs ?? 2_000;
	const memoryMs = options.memoryMs ?? OWN_KEY_MEMORY_MS;
	const now = options.now ?? (() => Date.now());
	const log = options.log ?? ((line: string) => console.error(line));
	const remembered = new Map<string, { key: StoredOwnKey | null; at: number }>();
	const checks = new Map<string, number[]>();

	function allowCheck(tenantId: string): boolean {
		const recent = (checks.get(tenantId) ?? []).filter((at) => now() - at < CHECK_WINDOW_MS);
		if (recent.length >= MAX_CHECKS) {
			checks.set(tenantId, recent);
			return false;
		}
		checks.set(tenantId, [...recent, now()]);
		return true;
	}

	return {
		enabled: secret !== null,

		async status(tenantId) {
			const key = await store.get(tenantId);
			return { enabled: secret !== null, saved: key ? { last4: key.last4, savedAt: key.savedAt } : null };
		},

		async save(tenantId, pasted) {
			if (!secret) return { ok: false, problem: "off" };
			const apiKey = anthropicApiKeyFrom(pasted);
			if (!apiKey) return { ok: false, problem: "format" };
			if (!allowCheck(tenantId)) return { ok: false, problem: "too-many" };
			const verdict = await check(apiKey);
			if (verdict !== "ok") {
				log(`own key: Anthropic did not take tenant ${tenantId}'s new key (${verdict}); not saved`);
				return { ok: false, problem: verdict };
			}
			const sealed = sealOwnKey(secret, tenantId, apiKey);
			try {
				await store.put(tenantId, sealed, new Date(now()));
			} catch (error) {
				log(`own key: could not save tenant ${tenantId}'s key (${errorLabel(error)})`);
				return { ok: false, problem: "failed" };
			}
			remembered.delete(tenantId);
			log(`own key: tenant ${tenantId} saved its own Anthropic key`);
			return { ok: true, last4: sealed.last4 };
		},

		async remove(tenantId) {
			const removed = await store.remove(tenantId);
			remembered.delete(tenantId);
			if (removed) log(`own key: tenant ${tenantId} removed its own Anthropic key`);
			return removed;
		},

		async forCall(tenantId) {
			if (!secret) return NORTH_AERO;
			let key: StoredOwnKey | null;
			try {
				key = await withTimeout(store.get(tenantId), readTimeoutMs);
				remembered.set(tenantId, { key, at: now() });
			} catch (error) {
				const memo = remembered.get(tenantId);
				if (!memo || now() - memo.at > memoryMs) {
					throw new MeteringUnavailableError(`the own key for tenant ${tenantId} could not be read (${errorLabel(error)})`);
				}
				key = memo.key;
			}
			if (!key) return NORTH_AERO;
			try {
				return { kind: "own", apiKey: openOwnKey(secret, tenantId, key) };
			} catch (error) {
				if (!(error instanceof OwnKeyUnreadableError)) throw error;
				log(`own key: tenant ${tenantId}'s saved key cannot be decrypted (was LH_OWN_KEY_SECRET changed?); its calls are refused`);
				return { kind: "unreadable" };
			}
		},
	};
}

/** Keys in memory: tests, and local runs without a database. */
export function memoryOwnKeyStore(): OwnKeyStore & { raw(tenantId: string): StoredOwnKey | undefined } {
	const keys = new Map<string, StoredOwnKey>();
	return {
		async get(tenantId) {
			const key = keys.get(tenantId);
			return key ? { ...key } : null;
		},
		async put(tenantId, key, at) {
			keys.set(tenantId, { ...key, savedAt: at });
		},
		async remove(tenantId) {
			return keys.delete(tenantId);
		},
		raw: (tenantId) => keys.get(tenantId),
	};
}

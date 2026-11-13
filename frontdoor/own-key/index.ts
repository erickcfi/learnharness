/**
 * The student's own AI key (master decision, 2026-11-13;
 * docs/decisions/2026-11-13-own-ai-key.md). wiring/front-door.ts calls
 * startOwnKeys() once at start, then gives `ownKeys` to the meter and
 * `endpoint` to the gateway's student routes, and calls close() at
 * shutdown.
 *
 *   crypto.ts    AES-256-GCM sealing, the LH_OWN_KEY_SECRET start check, the key format
 *   check.ts     one free call to Anthropic (GET /v1/models) before a key is saved
 *   service.ts   save, remove, status, and the meter's forCall (outage rule)
 *   db-store.ts  own_ai_keys on the database; service.ts has the in-memory store
 *   endpoint.ts  GET and POST /_frontdoor/ai-key
 *   registry.ts  how the /account/ai-key page reaches this
 *   copy.ts      every student-facing word, the meter's refusal messages included
 */
import type { Db } from "../db/index.ts";
import { parseCookies } from "../gateway/cookies.ts";
import { SESSION_COOKIE, verifySession } from "../gateway/session.ts";
import { SCHOOL_TIME_ZONE } from "../pause/copy.ts";
import { anthropicKeyCheck, type KeyCheck } from "./check.ts";
import { databaseOwnKeyStore } from "./db-store.ts";
import { createOwnKeyEndpoint, type OwnKeyEndpoint } from "./endpoint.ts";
import { getOwnKeyRuntime, type OwnKeyRuntime, registerOwnKeyRuntime } from "./registry.ts";
import { createOwnKeys, memoryOwnKeyStore, type OwnKeys, type OwnKeyStore } from "./service.ts";

export { OWN_KEY_PAGE, OWN_KEY_PATH } from "./paths.ts";
export type { OwnKeys } from "./service.ts";

export interface OwnKeyWiringOptions {
	/** 32 bytes from LH_OWN_KEY_SECRET (crypto.ts ownKeySecretFrom), or null: own keys off. */
	secret: Buffer | null;
	/** Without a database, keys stay in memory until the front door stops (local runs only). */
	db: Db | null;
	sessionSecret: Uint8Array;
	trustForwardedHeaders: boolean;
	/** Tests only: a fake Anthropic for the key check. */
	anthropicBaseUrl?: string;
	/** Tests only. */
	check?: KeyCheck;
	store?: OwnKeyStore;
	now?: () => number;
	log?: (line: string) => void;
}

export interface OwnKeyWiring {
	ownKeys: OwnKeys;
	endpoint: OwnKeyEndpoint;
	runtime: OwnKeyRuntime;
	close(): void;
}

export function startOwnKeys(options: OwnKeyWiringOptions): OwnKeyWiring {
	const now = options.now ?? (() => Date.now());
	const log = options.log;
	const ownKeys = createOwnKeys({
		secret: options.secret,
		store: options.store ?? (options.db ? databaseOwnKeyStore(options.db, { log }) : memoryOwnKeyStore()),
		check: options.check ?? anthropicKeyCheck(options.anthropicBaseUrl ? { baseUrl: options.anthropicBaseUrl } : {}),
		now,
		log,
	});
	const endpoint = createOwnKeyEndpoint({ ownKeys, trustForwardedHeaders: options.trustForwardedHeaders, log });
	const runtime: OwnKeyRuntime = {
		timeZone: SCHOOL_TIME_ZONE,
		async state(cookieHeader) {
			const session = await verifySession(parseCookies(cookieHeader).get(SESSION_COOKIE), options.sessionSecret, now());
			if (!session) return null;
			return ownKeys.status(session.tenantId);
		},
	};
	registerOwnKeyRuntime(runtime);
	return {
		ownKeys,
		endpoint,
		runtime,
		close() {
			if (getOwnKeyRuntime() === runtime) registerOwnKeyRuntime(null);
		},
	};
}

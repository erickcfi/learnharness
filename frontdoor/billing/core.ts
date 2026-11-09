/**
 * Everything billing's parts share (W2-8). wiring/front-door.ts builds one
 * with createBillingCore(); tests build one with the Stripe stand-in.
 */
import type { Db } from "../db/index.ts";
import { AccessCache } from "./access.ts";
import { PriceBook } from "./catalog.ts";
import type { EmailSender, RetentionHooks } from "./hooks.ts";
import type { StripeApi } from "./stripe-api.ts";
import type { TrialLimits } from "./trial.ts";

export interface BillingCore {
	db: Db;
	stripe: StripeApi;
	prices: PriceBook;
	access: AccessCache;
	retention: RetentionHooks;
	/** Null until w2-email's sender is wired: each skipped email is logged (tenant id and kind only). */
	email: EmailSender | null;
	webhookSecret: string;
	trialHashKey: string;
	/** The site's address for links in emails, for example https://ground.flynorthaero.com. */
	siteUrl: string;
	now: () => number;
	/** Never given an email address or session text (cross-cutting req 3). */
	log: (line: string) => void;
}

export interface BillingCoreOptions {
	db: Db;
	stripe: StripeApi;
	retention: RetentionHooks;
	email?: EmailSender | null;
	webhookSecret: string;
	trialHashKey: string;
	siteUrl: string;
	now?: () => number;
	log?: (line: string) => void;
	/** Tests: how long the access answer is remembered (default 10 s). */
	accessTtlMs?: number;
	limits?: TrialLimits;
}

export function createBillingCore(o: BillingCoreOptions): BillingCore {
	const now = o.now ?? Date.now;
	return {
		db: o.db,
		stripe: o.stripe,
		prices: new PriceBook(o.stripe, { now }),
		access: new AccessCache(o.db, { now, ...(o.accessTtlMs !== undefined ? { ttlMs: o.accessTtlMs } : {}), ...(o.limits ? { limits: o.limits } : {}) }),
		retention: o.retention,
		email: o.email ?? null,
		webhookSecret: o.webhookSecret,
		trialHashKey: o.trialHashKey,
		siteUrl: o.siteUrl.replace(/\/+$/, ""),
		now,
		log: o.log ?? (() => {}),
	};
}

/** The site address for emails: FRONTDOOR_PUBLIC_URL, else the first FRONTDOOR_AUTHORIZED_PARTIES origin, else the launch address. */
export function siteUrlFrom(env: Readonly<Record<string, string | undefined>>): string {
	const explicit = env.FRONTDOOR_PUBLIC_URL?.trim();
	if (explicit) return explicit;
	const first = (env.FRONTDOOR_AUTHORIZED_PARTIES ?? "").split(",")[0]?.trim();
	return first || "https://ground.flynorthaero.com";
}

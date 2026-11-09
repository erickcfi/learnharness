/**
 * What billing calls in other packages.
 *
 *  - Retention (w2-pause, C1 req 6; master, 2026-11-08): when a subscription
 *    really ends, the tenant's 90 days start. The master wires
 *    frontDoor.dataSafety.retention() (w2-pause's retention/lifecycle.ts) at
 *    merge; its startRetention(tenantId, endedAt) and endRetention(tenantId)
 *    fit RetentionHooks. Until then the stand-in uses the database module.
 *    Billing calls them after the webhook's transaction commits, because
 *    w2-pause writes through its own database handle (webhook.ts).
 *  - Email (w2-email, merged): billing sends the sign-up confirmation and the
 *    annual renewal notice (California automatic renewal law, PRD G2)
 *    through w2-email's EmailSender (frontdoor/email/sender.ts), from
 *    billing@ground.flynorthaero.com.
 */
import { type Db, endRetention, startRetention } from "../db/index.ts";

export type { EmailMessage, EmailSender } from "../email/sender.ts";

export interface RetentionHooks {
	/** The subscription ended at `endedAt`: keep the tenant 90 days, read and export only. Safe to repeat. */
	startRetention(tenantId: string, endedAt: Date): Promise<unknown>;
	/** The student subscribed again during retention. Safe to repeat. */
	endRetention(tenantId: string): Promise<unknown>;
}

/** Stand-in until w2-pause merges: the database module's retention calls. */
export function databaseRetention(db: Db): RetentionHooks {
	return {
		startRetention: (tenantId, endedAt) => startRetention(db, tenantId, endedAt),
		endRetention: (tenantId) => endRetention(db, tenantId),
	};
}

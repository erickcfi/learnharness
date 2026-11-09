/**
 * What billing calls in other packages.
 *
 *  - Retention (w2-pause, C1 req 6): when a subscription really ends, the
 *    tenant's 90 days start. w2-pause exports startRetention(tenantId,
 *    endedAt); until it merges, the stand-in uses the database module's own
 *    functions.
 *  - Email (w2-email, merged): billing sends the sign-up confirmation and the
 *    annual renewal notice (California automatic renewal law, PRD G2)
 *    through w2-email's EmailSender (frontdoor/email/sender.ts).
 */
import { type Db, endRetention, startRetention } from "../db/index.ts";

export type { EmailMessage, EmailSender } from "../email/sender.ts";

/**
 * Called inside the webhook's database transaction. `tx` is that
 * transaction: a database-only implementation should write through it, so
 * the change commits (or rolls back) with the event. One that uses its own
 * connection may ignore it, but must not wait on rows the webhook's
 * transaction holds (it touches none in this step except, at Checkout, the
 * tenant's Stripe customer id).
 */
export interface RetentionHooks {
	/** The subscription ended at `endedAt`: keep the tenant 90 days, read and export only. */
	startRetention(tenantId: string, endedAt: Date, tx?: Db): Promise<void>;
	/** The student subscribed again during retention. */
	endRetention(tenantId: string, tx?: Db): Promise<void>;
}

/** Stand-in until w2-pause merges: the database module's retention calls. */
export function databaseRetention(db: Db): RetentionHooks {
	return {
		async startRetention(tenantId, endedAt, tx) {
			await startRetention(tx ?? db, tenantId, endedAt);
		},
		async endRetention(tenantId, tx) {
			await endRetention(tx ?? db, tenantId);
		},
	};
}

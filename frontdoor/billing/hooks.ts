/**
 * What billing calls in other packages, with small stand-ins until they merge.
 *
 *  - Retention (w2-pause, C1 req 6): when a subscription really ends, the
 *    tenant's 90 days start. w2-pause exports startRetention(tenantId,
 *    endedAt); the stand-in uses the database module's own functions.
 *  - Email (w2-email, C6 sending identity): billing sends the sign-up
 *    confirmation and the annual renewal notice (California auto-renewal
 *    law, PRD G2) through w2-email's EmailSender. The stand-in records them.
 */
import { type Db, endRetention, startRetention } from "../db/index.ts";

/**
 * Called inside the webhook's database transaction. `tx` is that
 * transaction: a database-only implementation should write through it, so
 * the change commits (or rolls back) with the event. One that uses its own
 * connection may ignore it.
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

export interface EmailMessage {
	to: string;
	subject: string;
	text: string;
	/** For the email log; never the address. */
	kind: "billing-confirmation" | "annual-renewal-notice";
}

/** The shape billing needs from w2-email's EmailSender. */
export interface EmailSender {
	send(message: EmailMessage): Promise<void>;
}

/** Records what would be sent. Tests and local runs without SES. */
export class RecordingEmailSender implements EmailSender {
	readonly sent: EmailMessage[] = [];
	failNext = false;
	async send(message: EmailMessage): Promise<void> {
		if (this.failNext) {
			this.failNext = false;
			throw new Error("stand-in email failure");
		}
		this.sent.push(message);
	}
}

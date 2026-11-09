/**
 * Database reads and writes for the reports (C6 req 3, D26). Settings,
 * weekly claims and "sent" marks use frontdoor/db (reports.ts); this file
 * adds what the sending loop and the pages need on top:
 *
 *  - the recipients, with their unsubscribe tokens
 *  - study stretches since a time
 *  - a session claim keyed by the study sitting (migration
 *    20261108001000_report_sends_sitting.sql), so a student who comes back
 *    to the same tutor session another day still gets a report
 *  - releasing a claim whose email failed, so the next run tries again
 */
import { type Db, date, num, one, strOrNull } from "../db/db.ts";
import type { Stretch } from "./sittings.ts";

export interface Recipient {
	tenantId: string;
	reportEmail: string;
	unsubscribeToken: string;
}

async function recipients(db: Db, column: "session_report_enabled" | "weekly_report_enabled"): Promise<Recipient[]> {
	const rows = await db.query(
		`select rs.tenant_id, rs.report_email, rs.unsubscribe_token from report_settings rs
		 join tenants t on t.id = rs.tenant_id
		 where rs.${column} and rs.report_email is not null and t.status = 'ready'
		 order by rs.tenant_id`,
	);
	return rows.map((r) => ({ tenantId: String(r.tenant_id), reportEmail: String(r.report_email), unsubscribeToken: String(r.unsubscribe_token) }));
}

/** Tenants in service with session reports on and an address. */
export const listSessionRecipients = (db: Db) => recipients(db, "session_report_enabled");
/** Tenants in service with weekly reports on and an address. */
export const listWeeklyReportRecipients = (db: Db) => recipients(db, "weekly_report_enabled");

/** Stretches still active at or after `since` (so a sitting's first stretch is included). */
export async function stretchesActiveSince(db: Db, tenantId: string, since: Date): Promise<Stretch[]> {
	const rows = await db.query(
		"select chat_id, started_at, last_active_at, active_seconds from study_time where tenant_id = $1 and last_active_at >= $2 order by started_at, id",
		[tenantId, since],
	);
	return rows.map((r) => ({ chatId: strOrNull(r.chat_id), startedAt: date(r.started_at), lastActiveAt: date(r.last_active_at), activeSeconds: num(r.active_seconds) }));
}

/** Stretches that started in [from, to): the weekly report's week. */
export async function stretchesStartedIn(db: Db, tenantId: string, from: Date, to: Date): Promise<Stretch[]> {
	const rows = await db.query(
		"select chat_id, started_at, last_active_at, active_seconds from study_time where tenant_id = $1 and started_at >= $2 and started_at < $3 order by started_at, id",
		[tenantId, from, to],
	);
	return rows.map((r) => ({ chatId: strOrNull(r.chat_id), startedAt: date(r.started_at), lastActiveAt: date(r.last_active_at), activeSeconds: num(r.active_seconds) }));
}

/**
 * Claim the session report for one sitting. Null when already claimed.
 * `chatId` is the sitting's main chat (report_sends needs one for a session row).
 */
export async function claimSittingReport(db: Db, key: { tenantId: string; sittingStartedAt: Date; chatId: string }): Promise<number | null> {
	const r = await one(
		db,
		`insert into report_sends (tenant_id, kind, chat_id, sitting_started_at) values ($1, 'session', $2, $3)
		 on conflict do nothing returning id`,
		[key.tenantId, key.chatId, key.sittingStartedAt],
	);
	return r ? num(r.id) : null;
}

/** Undo a claim whose email was not sent, so a later run tries again. A sent row is never removed. */
export async function releaseReportClaim(db: Db, sendId: number): Promise<void> {
	await db.query("delete from report_sends where id = $1 and sent_at is null", [sendId]);
}

/** Whether an unsubscribe token belongs to a student (the unsubscribe page). */
export async function unsubscribeTokenExists(db: Db, token: string): Promise<boolean> {
	return (await one(db, "select 1 as ok from report_settings where unsubscribe_token = $1", [token])) !== null;
}

/** The Clerk user id behind a tenant, for the student's name and login email. */
export async function clerkUserIdForTenant(db: Db, tenantId: string): Promise<string | null> {
	const r = await one(db, "select a.clerk_user_id from tenants t join accounts a on a.id = t.account_id where t.id = $1", [tenantId]);
	return r ? String(r.clerk_user_id) : null;
}

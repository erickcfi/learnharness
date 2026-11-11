/**
 * Email report settings and sends (C6 req 3, N12, D20, D26), and the
 * non-aviation topic labels (C7 req 4, N7).
 */

import { date, dateOrNull, type Db, must, num, one, type Row, strOrNull } from "./db.ts";

// ---- report settings (C6 req 3, N12) ----

export interface ReportSettings {
	tenantId: string;
	sessionReportEnabled: boolean;
	weeklyReportEnabled: boolean;
	reportEmail: string | null;
	unsubscribeToken: string;
	updatedAt: Date;
}

const SETTINGS_COLS = "tenant_id, session_report_enabled, weekly_report_enabled, report_email, unsubscribe_token, updated_at";

function toSettings(r: Row): ReportSettings {
	return {
		tenantId: String(r.tenant_id),
		sessionReportEnabled: Boolean(r.session_report_enabled),
		weeklyReportEnabled: Boolean(r.weekly_report_enabled),
		reportEmail: strOrNull(r.report_email),
		unsubscribeToken: String(r.unsubscribe_token),
		updatedAt: date(r.updated_at),
	};
}

async function ensureSettings(db: Db, tenantId: string): Promise<void> {
	await db.query("insert into report_settings (tenant_id) values ($1) on conflict (tenant_id) do nothing", [tenantId]);
}

/** The tenant's settings. Both reports start off; the row and its unsubscribe token are made on first read. */
export async function getReportSettings(db: Db, tenantId: string): Promise<ReportSettings> {
	await ensureSettings(db, tenantId);
	return toSettings(await must(db, `select ${SETTINGS_COLS} from report_settings where tenant_id = $1`, [tenantId]));
}

/**
 * Change some settings; fields left out stay as they are. `reportEmail: null`
 * clears the address. A report cannot be on without an address.
 */
export async function updateReportSettings(
	db: Db,
	tenantId: string,
	patch: { sessionReportEnabled?: boolean; weeklyReportEnabled?: boolean; reportEmail?: string | null },
): Promise<ReportSettings> {
	return db.transaction(async (tx) => {
		await ensureSettings(tx, tenantId);
		return toSettings(
			await must(
				tx,
				`update report_settings set
				   session_report_enabled = coalesce($2::boolean, session_report_enabled),
				   weekly_report_enabled = coalesce($3::boolean, weekly_report_enabled),
				   report_email = case when $4::boolean then $5::text else report_email end,
				   updated_at = now()
				 where tenant_id = $1 returning ${SETTINGS_COLS}`,
				[tenantId, patch.sessionReportEnabled ?? null, patch.weeklyReportEnabled ?? null, "reportEmail" in patch, patch.reportEmail ?? null],
			),
		);
	});
}

/** The unsubscribe link in a report email. False if the token matches no tenant. */
export async function unsubscribeByToken(db: Db, token: string, kind: "session" | "weekly" | "all"): Promise<boolean> {
	const rows = await db.query(
		`update report_settings set
		   session_report_enabled = case when $2::text in ('session', 'all') then false else session_report_enabled end,
		   weekly_report_enabled = case when $2::text in ('weekly', 'all') then false else weekly_report_enabled end,
		   updated_at = now()
		 where unsubscribe_token = $1 returning tenant_id`,
		[token, kind],
	);
	return rows.length > 0;
}

/** Tenants with the weekly report on and an address set. */
export async function listWeeklyRecipients(db: Db): Promise<{ tenantId: string; reportEmail: string }[]> {
	const rows = await db.query("select tenant_id, report_email from report_settings where weekly_report_enabled and report_email is not null order by tenant_id");
	return rows.map((r) => ({ tenantId: String(r.tenant_id), reportEmail: String(r.report_email) }));
}

// ---- report sends: never twice (D26) ----

export type ReportSendKey = { tenantId: string; kind: "session"; chatId: string } | { tenantId: string; kind: "weekly"; weekStart: string };

export interface ReportSend {
	id: number;
	tenantId: string;
	kind: "session" | "weekly";
	chatId: string | null;
	/** YYYY-MM-DD */
	weekStart: string | null;
	claimedAt: Date;
	sentAt: Date | null;
	providerMessageId: string | null;
}

const SEND_COLS = "id, tenant_id, kind, chat_id, week_start::text as week_start, claimed_at, sent_at, provider_message_id";

function toSend(r: Row): ReportSend {
	return {
		id: num(r.id),
		tenantId: String(r.tenant_id),
		kind: r.kind as "session" | "weekly",
		chatId: strOrNull(r.chat_id),
		weekStart: strOrNull(r.week_start),
		claimedAt: date(r.claimed_at),
		sentAt: dateOrNull(r.sent_at),
		providerMessageId: strOrNull(r.provider_message_id),
	};
}

/**
 * Claim the right to send one report: the session report for a chat, or the
 * weekly report for a week (`weekStart` as YYYY-MM-DD). Null when it was
 * already claimed, so the caller sends nothing.
 */
export async function claimReportSend(db: Db, key: ReportSendKey): Promise<ReportSend | null> {
	const r = await one(
		db,
		`insert into report_sends (tenant_id, kind, chat_id, week_start) values ($1, $2, $3, $4::date) on conflict do nothing returning ${SEND_COLS}`,
		[key.tenantId, key.kind, key.kind === "session" ? key.chatId : null, key.kind === "weekly" ? key.weekStart : null],
	);
	return r ? toSend(r) : null;
}

export async function markReportSent(db: Db, sendId: number, providerMessageId?: string, at: Date = new Date()): Promise<ReportSend> {
	return toSend(await must(db, `update report_sends set sent_at = $2, provider_message_id = $3 where id = $1 returning ${SEND_COLS}`, [sendId, at, providerMessageId ?? null]));
}

// ---- topic labels (C7 req 4, N7) ----

export interface TopicLabel {
	tenantId: string;
	chatId: string;
	topic: string;
	/** Haiku's label. null: the tenant server had no such chat, so there is no label (admin/flags.ts). */
	isAviation: boolean | null;
	model: string;
	labeledAt: Date;
}

const LABEL_COLS = "tenant_id, chat_id, topic, is_aviation, model, labeled_at";

function toLabel(r: Row): TopicLabel {
	return {
		tenantId: String(r.tenant_id),
		chatId: String(r.chat_id),
		topic: String(r.topic),
		isAviation: r.is_aviation === null || r.is_aviation === undefined ? null : Boolean(r.is_aviation),
		model: String(r.model),
		labeledAt: date(r.labeled_at),
	};
}

/** Save the label for a session, replacing an earlier one. */
export async function saveTopicLabel(db: Db, l: { tenantId: string; chatId: string; topic: string; isAviation: boolean | null; model: string; at?: Date }): Promise<TopicLabel> {
	return toLabel(
		await must(
			db,
			`insert into topic_labels (tenant_id, chat_id, topic, is_aviation, model, labeled_at) values ($1, $2, $3, $4, $5, $6)
			 on conflict (tenant_id, chat_id) do update set topic = excluded.topic, is_aviation = excluded.is_aviation, model = excluded.model, labeled_at = excluded.labeled_at
			 returning ${LABEL_COLS}`,
			[l.tenantId, l.chatId, l.topic, l.isAviation, l.model, l.at ?? new Date()],
		),
	);
}

export async function getTopicLabel(db: Db, tenantId: string, chatId: string): Promise<TopicLabel | null> {
	const r = await one(db, `select ${LABEL_COLS} from topic_labels where tenant_id = $1 and chat_id = $2`, [tenantId, chatId]);
	return r ? toLabel(r) : null;
}

export async function getTopicLabels(db: Db, tenantId: string): Promise<TopicLabel[]> {
	return (await db.query(`select ${LABEL_COLS} from topic_labels where tenant_id = $1 order by labeled_at, chat_id`, [tenantId])).map(toLabel);
}

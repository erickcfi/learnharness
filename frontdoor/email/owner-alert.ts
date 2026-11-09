/**
 * Owner alert email (for w2-pause's cost alerts and autopause, C3 req 5
 * and 6). D15 says alerts show on the dashboard; this email is extra and
 * goes out only when the Railway variable OWNER_ALERT_EMAIL is set.
 *
 * The email carries the tenant id and the amounts, never a student's
 * email address or session text. sendOwnerAlert never throws: it returns
 * whether the email went out, so an alert or pause is never held up by
 * email.
 *
 *   const sendOwnerAlert = createOwnerAlertSender({ sender, to: config.ownerAlertEmail, publicUrl, log });
 *   await sendOwnerAlert({ kind: "autopause", tenantId, costUsd: 89.12, thresholdUsd: 89 });
 */
import { reportCopy } from "./copy.ts";
import { type EmailDocument, renderEmailHtml, renderEmailText } from "./layout.ts";
import { describeSendError, type EmailMessage, type EmailSender } from "./sender.ts";

export type OwnerAlertKind = "cost-alert" | "autopause";

export interface OwnerAlert {
	kind: OwnerAlertKind;
	tenantId: string;
	/** Model cost over the last 30 days, in dollars. */
	costUsd: number;
	/** The alert or autopause level that was passed, in dollars. */
	thresholdUsd: number;
	/** When it happened. Default: now. */
	at?: Date;
}

export interface OwnerAlertResult {
	sent: boolean;
	/** Why nothing was sent. */
	reason?: "no-owner-address" | "email-off" | "send-failed";
	messageId?: string;
}

export type SendOwnerAlert = (alert: OwnerAlert) => Promise<OwnerAlertResult>;

export interface OwnerAlertDeps {
	/** Null when email is off (production without the SES variables). */
	sender: EmailSender | null;
	/** OWNER_ALERT_EMAIL. */
	to: string | undefined;
	/** The site address, for the dashboard link. */
	publicUrl: string;
	/** IANA zone for the time shown. */
	timeZone: string;
	log?: (line: string) => void;
}

const dollars = (n: number) => `$${n.toFixed(2)}`;

export function ownerAlertMessage(alert: OwnerAlert, deps: Pick<OwnerAlertDeps, "publicUrl" | "timeZone">, to: string): EmailMessage {
	const c = reportCopy.ownerAlert;
	const when = new Intl.DateTimeFormat("en-US", {
		timeZone: deps.timeZone,
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(alert.at ?? new Date());
	const threshold = `$${Number.isInteger(alert.thresholdUsd) ? alert.thresholdUsd : alert.thresholdUsd.toFixed(2)}`;
	const doc: EmailDocument = {
		title: c.title(alert.kind),
		preheader: c.explain(alert.kind),
		blocks: [
			{ kind: "paragraph", text: c.explain(alert.kind) },
			{
				kind: "rows",
				rows: [
					{ label: c.tenantRow, value: alert.tenantId },
					{ label: c.costRow, value: dollars(alert.costUsd) },
					{ label: c.thresholdRow(alert.kind), value: threshold },
					{ label: c.timeRow, value: when },
				],
			},
		],
		footer: { links: [{ text: c.dashboardLink, href: `${deps.publicUrl}/admin` }], lines: [c.why] },
	};
	return {
		kind: "owner-alert",
		to,
		subject: c.subject(alert.kind, alert.tenantId.slice(0, 8), threshold),
		html: renderEmailHtml(doc),
		text: renderEmailText(doc),
		tenantId: alert.tenantId,
	};
}

export function createOwnerAlertSender(deps: OwnerAlertDeps): SendOwnerAlert {
	return async (alert) => {
		if (!deps.to) return { sent: false, reason: "no-owner-address" };
		if (!deps.sender) return { sent: false, reason: "email-off" };
		try {
			const { messageId } = await deps.sender.send(ownerAlertMessage(alert, deps, deps.to));
			return { sent: true, messageId };
		} catch (error) {
			deps.log?.(`owner alert email for tenant ${alert.tenantId} failed: ${describeSendError(error)}`);
			return { sent: false, reason: "send-failed" };
		}
	};
}

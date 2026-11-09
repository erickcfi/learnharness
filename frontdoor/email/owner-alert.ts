/**
 * DROPPED (master, 2026-11-08): PRD D15 says cost alerts show on the
 * dashboard only, so there is no alert email to the Owner. Nothing imports
 * this file. It is waiting for approval to delete it (agents never delete
 * files without a yes). Delete it whole; nothing else changes.
 */
import { type EmailDocument, renderEmailHtml, renderEmailText } from "./layout.ts";
import type { EmailMessage } from "./sender.ts";

export interface DroppedOwnerAlert {
	kind: "cost-alert" | "autopause";
	tenantId: string;
	costUsd: number;
	thresholdUsd: number;
}

/** Unused. Kept compiling only until the file is deleted. */
export function droppedOwnerAlertMessage(alert: DroppedOwnerAlert, to: string): EmailMessage {
	const doc: EmailDocument = {
		title: alert.kind,
		preheader: alert.kind,
		blocks: [{ kind: "paragraph", text: `${alert.tenantId}: $${alert.costUsd.toFixed(2)} of $${alert.thresholdUsd}` }],
		footer: { links: [], lines: [] },
	};
	return { kind: "session-report", to, subject: alert.kind, html: renderEmailHtml(doc), text: renderEmailText(doc) };
}

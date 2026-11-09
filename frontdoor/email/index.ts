/**
 * Email for the North Aero Ground Tutor (C6 req 3 to 5, N1): the sending
 * layer, the look of every email, and its wording. The reports themselves
 * are in frontdoor/reports/. (No Owner alert email: D15, dashboard only.)
 */
export { isValidEmailAddress, normalizeEmailAddress } from "./address.ts";
export {
	assertEmailEnv,
	EMAIL_FROM_ADDRESS,
	EMAIL_FROM_NAME,
	EMAIL_REPLY_TO,
	emailEnvProblems,
	loadEmailConfig,
	SES_CONFIGURATION_SET,
	SES_VARIABLES,
	type EmailConfig,
	type EmailMode,
	type SesSettings,
} from "./config.ts";
export { BRAND_NAME, REPORT_LABEL, reportCopy, settingsCopy, unsubscribeCopy } from "./copy.ts";
export { EMAIL_COLORS, escapeHtml, oneLine, renderEmailHtml, renderEmailText, type Block, type EmailDocument, type EmailLink } from "./layout.ts";
export {
	checkEmailMessage,
	createSesSender,
	describeSendError,
	FROM_HEADER,
	InvalidEmailMessageError,
	MemoryEmailSender,
	sesSendEmailInput,
	type EmailKind,
	type EmailMessage,
	type EmailSender,
	type SendResult,
	type SesClientLike,
} from "./sender.ts";

import { type EmailConfig } from "./config.ts";
import { createSesSender, type EmailSender, MemoryEmailSender } from "./sender.ts";

/** The sender for this run: SES in production when set up, the fake outside production, none when email is off. */
export function senderFor(config: EmailConfig, log?: (line: string) => void): EmailSender | null {
	if (config.mode === "ses" && config.ses) return createSesSender(config.ses);
	if (config.mode === "memory") return new MemoryEmailSender(log ? { log } : {});
	return null;
}

/**
 * The sending layer (C6 req 3 and 4, N1). Everything that sends email goes
 * through EmailSender:
 *
 *   createSesSender   Amazon SES, API v2, with the ground-tutor-reports
 *                     configuration set. Production only.
 *   MemoryEmailSender the fake: keeps messages in memory. Tests and local
 *                     runs. Nothing leaves the machine.
 *
 * A message has one recipient, a subject, an HTML part and a plain-text
 * part, and optional extra headers (List-Unsubscribe). Header values and
 * the recipient are checked for line breaks, so no text can add a header.
 *
 * Logs name the email kind and the tenant id, never an address or any
 * report text (cross-cutting req 3).
 */
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { isValidEmailAddress } from "./address.ts";
import { EMAIL_FROM_ADDRESS, EMAIL_FROM_NAME, EMAIL_REPLY_TO, SES_CONFIGURATION_SET, type SesSettings } from "./config.ts";

/** W2-8 adds the billing emails (billing/emails.ts): the sign-up confirmation and the annual renewal notice. */
export type EmailKind = "session-report" | "weekly-report" | "billing-confirmation" | "annual-renewal-notice";

export interface EmailMessage {
	kind: EmailKind;
	/** One address. */
	to: string;
	subject: string;
	html: string;
	text: string;
	/** Extra headers, for example List-Unsubscribe. */
	headers?: Readonly<Record<string, string>>;
	/** For logs only. */
	tenantId?: string;
}

export interface SendResult {
	/** The provider's message id (SES MessageId). */
	messageId: string;
}

export interface EmailSender {
	readonly mode: "ses" | "memory";
	/** Throws when the provider refuses the message. */
	send(message: EmailMessage): Promise<SendResult>;
}

export class InvalidEmailMessageError extends Error {
	constructor(reason: string) {
		super(`Email not sent: ${reason}`);
		this.name = "InvalidEmailMessageError";
	}
}

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
/** Headers SES or this module sets; a message may not set them. */
const RESERVED_HEADERS = new Set(["from", "to", "cc", "bcc", "reply-to", "subject", "sender", "return-path", "content-type", "mime-version", "x-ses-configuration-set"]);

/** Throws InvalidEmailMessageError for a bad recipient, subject or header. */
export function checkEmailMessage(message: EmailMessage): void {
	if (!isValidEmailAddress(message.to)) throw new InvalidEmailMessageError("the recipient is not one valid address");
	if (/[\r\n]/.test(message.subject) || message.subject.trim() === "") throw new InvalidEmailMessageError("the subject is empty or has a line break");
	if (message.text.trim() === "" || message.html.trim() === "") throw new InvalidEmailMessageError("the plain-text or HTML part is empty");
	for (const [name, value] of Object.entries(message.headers ?? {})) {
		if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) throw new InvalidEmailMessageError(`header ${JSON.stringify(name)} is not allowed`);
		if (/[\r\n\0]/.test(value)) throw new InvalidEmailMessageError(`header ${name} has a line break`);
	}
}

/** "North Aero Ground Tutor" <reports@ground.flynorthaero.com> */
export const FROM_HEADER = `"${EMAIL_FROM_NAME}" <${EMAIL_FROM_ADDRESS}>`;

/** What SESv2Client.send needs from a client. Tests pass a fake. */
export interface SesClientLike {
	send(command: SendEmailCommand): Promise<{ MessageId?: string | undefined }>;
}

/** The SES v2 SendEmail input for one message (exported for tests). */
export function sesSendEmailInput(message: EmailMessage) {
	return {
		FromEmailAddress: FROM_HEADER,
		Destination: { ToAddresses: [message.to] },
		ReplyToAddresses: [EMAIL_REPLY_TO],
		ConfigurationSetName: SES_CONFIGURATION_SET,
		EmailTags: [{ Name: "kind", Value: message.kind }],
		Content: {
			Simple: {
				Subject: { Data: message.subject, Charset: "UTF-8" },
				Body: {
					Text: { Data: message.text, Charset: "UTF-8" },
					Html: { Data: message.html, Charset: "UTF-8" },
				},
				...(message.headers && Object.keys(message.headers).length > 0
					? { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) }
					: {}),
			},
		},
	};
}

/**
 * Amazon SES (API v2). The credentials come from the SES_* Railway
 * variables, passed in explicitly, so no other AWS setting on the service
 * is picked up by mistake. The SDK retries throttling on its own.
 */
export function createSesSender(settings: SesSettings, client?: SesClientLike): EmailSender {
	const ses: SesClientLike =
		client ??
		new SESv2Client({
			region: settings.region,
			credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
			maxAttempts: 3,
		});
	return {
		mode: "ses",
		async send(message) {
			checkEmailMessage(message);
			const out = await ses.send(new SendEmailCommand(sesSendEmailInput(message)));
			if (!out.MessageId) throw new Error("SES accepted the message but returned no MessageId");
			return { messageId: out.MessageId };
		},
	};
}

/** The fake. Keeps every message; can be told to fail the next sends. */
export class MemoryEmailSender implements EmailSender {
	readonly mode = "memory" as const;
	readonly sent: EmailMessage[] = [];
	#failures: Error[] = [];
	#count = 0;
	readonly #log: ((line: string) => void) | undefined;

	constructor(options: { log?: (line: string) => void } = {}) {
		this.#log = options.log;
	}

	/** The next send throws this error (tests). */
	failNext(error: Error = new Error("fake send failure")): void {
		this.#failures.push(error);
	}

	async send(message: EmailMessage): Promise<SendResult> {
		checkEmailMessage(message);
		const failure = this.#failures.shift();
		if (failure) throw failure;
		this.sent.push(message);
		this.#log?.(`email (not sent, local fake): ${message.kind}${message.tenantId ? ` for tenant ${message.tenantId}` : ""}`);
		return { messageId: `memory-${++this.#count}` };
	}
}

/** The error's name and AWS code only: never the message, which can hold an address. */
export function describeSendError(error: unknown): string {
	const e = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } };
	const name = typeof e?.name === "string" ? e.name : "Error";
	const status = typeof e?.$metadata?.httpStatusCode === "number" ? ` (HTTP ${e.$metadata.httpStatusCode})` : "";
	return `${name}${status}`;
}

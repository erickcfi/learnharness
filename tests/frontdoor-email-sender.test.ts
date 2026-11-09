/**
 * The sending layer (W2-10; C6 req 3 to 5, N1, PD7): email settings and
 * modes, the SES v2 sender (with a fake SES client: nothing is sent), the
 * in-memory fake, the email look, and the Owner alert.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { isValidEmailAddress, normalizeEmailAddress } from "../frontdoor/email/address.ts";
import { emailEnvProblems, loadEmailConfig, SES_CONFIGURATION_SET } from "../frontdoor/email/config.ts";
import { REPORT_LABEL } from "../frontdoor/email/copy.ts";
import { senderFor } from "../frontdoor/email/index.ts";
import { renderEmailHtml, renderEmailText, type EmailDocument } from "../frontdoor/email/layout.ts";
import { createOwnerAlertSender } from "../frontdoor/email/owner-alert.ts";
import { createSesSender, describeSendError, type EmailMessage, InvalidEmailMessageError, MemoryEmailSender, type SesClientLike } from "../frontdoor/email/sender.ts";

const SES_ENV = { SES_REGION: "us-west-2", SES_ACCESS_KEY_ID: "AKIAEXAMPLEKEY000000", SES_SECRET_ACCESS_KEY: "example-secret-value-not-real-0000000000" };

const message = (over: Partial<EmailMessage> = {}): EmailMessage => ({
	kind: "session-report",
	to: "student@example.com",
	subject: "Study report, Nov 8",
	html: "<p>hi</p>",
	text: "hi",
	tenantId: "tenant-1",
	...over,
});

function fakeSes(answer: { MessageId?: string } | Error = { MessageId: "ses-123" }) {
	const inputs: unknown[] = [];
	const client: SesClientLike = {
		async send(command: SendEmailCommand) {
			inputs.push(command.input);
			if (answer instanceof Error) throw answer;
			return answer;
		},
	};
	return { client, inputs };
}

describe("email settings (Railway variables)", () => {
	it("uses the in-memory fake outside production, even with the SES variables set", () => {
		const config = loadEmailConfig({ NODE_ENV: "test", ...SES_ENV });
		assert.equal(config.mode, "memory");
		assert.equal(config.ses, undefined);
		assert.ok(senderFor(config) instanceof MemoryEmailSender);
	});

	it("is off in production when no SES variable is set, and the start is not blocked", () => {
		const config = loadEmailConfig({ NODE_ENV: "production" });
		assert.equal(config.mode, "off");
		assert.equal(senderFor(config), null);
	});

	it("uses SES in production when all three SES variables are set", () => {
		const config = loadEmailConfig({ NODE_ENV: "production", ...SES_ENV });
		assert.equal(config.mode, "ses");
		assert.deepEqual(config.ses, { region: "us-west-2", accessKeyId: SES_ENV.SES_ACCESS_KEY_ID, secretAccessKey: SES_ENV.SES_SECRET_ACCESS_KEY });
		assert.equal(senderFor(config)?.mode, "ses");
	});

	it("refuses a partial SES set in production, naming what is missing and never a value", () => {
		const problems = emailEnvProblems({ NODE_ENV: "production", SES_REGION: "us-west-2", SES_ACCESS_KEY_ID: SES_ENV.SES_ACCESS_KEY_ID });
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, /SES_SECRET_ACCESS_KEY is not set/);
		assert.ok(!problems[0]!.includes(SES_ENV.SES_ACCESS_KEY_ID));
		assert.throws(() => loadEmailConfig({ NODE_ENV: "production", SES_SECRET_ACCESS_KEY: "x".repeat(40) }), /SES_REGION, SES_ACCESS_KEY_ID are not set/);
	});

	it("checks the Region, the Owner alert address and the public address", () => {
		assert.match(emailEnvProblems({ SES_REGION: "Oregon" }).join(), /SES_REGION must be an AWS Region code/);
		assert.match(emailEnvProblems({ OWNER_ALERT_EMAIL: "erick" }).join(), /OWNER_ALERT_EMAIL must be one email address/);
		assert.match(emailEnvProblems({ FRONTDOOR_PUBLIC_URL: "https://ground.flynorthaero.com/account" }).join(), /origin only/);
		assert.match(emailEnvProblems({ NODE_ENV: "production", FRONTDOOR_PUBLIC_URL: "http://ground.flynorthaero.com" }).join(), /https:\/\//);
		assert.deepEqual(emailEnvProblems({ NODE_ENV: "production", FRONTDOOR_PUBLIC_URL: "https://staging.example.com/", OWNER_ALERT_EMAIL: "owner@example.com" }), []);
	});

	it("defaults the link address to the real site and drops a trailing slash", () => {
		assert.equal(loadEmailConfig({}).publicUrl, "https://ground.flynorthaero.com");
		assert.equal(loadEmailConfig({ FRONTDOOR_PUBLIC_URL: "https://staging.example.com/" }).publicUrl, "https://staging.example.com");
		assert.equal(loadEmailConfig({ OWNER_ALERT_EMAIL: " owner@example.com " }).ownerAlertEmail, "owner@example.com");
	});
});

describe("email addresses", () => {
	it("accepts one plain address and refuses lists, names and line breaks", () => {
		assert.ok(isValidEmailAddress("cfi.name+tutor@flight-school.example.com"));
		for (const bad of ["", "no-at-sign", "a@b", "a@b.c", "two@example.com, more@example.com", "Name <a@example.com>", "a@example.com\r\nBcc: x@example.com", "a b@example.com", `${"x".repeat(65)}@example.com`]) {
			assert.equal(isValidEmailAddress(bad), false, bad);
		}
	});

	it("normalizes by trimming and lower-casing the domain only", () => {
		assert.equal(normalizeEmailAddress("  Jane.Doe@Example.COM "), "Jane.Doe@example.com");
		assert.equal(normalizeEmailAddress("nope"), null);
	});
});

describe("Amazon SES sender (API v2)", () => {
	it("sends from reports@ with Reply-To info@, the configuration set, both parts and the extra headers", async () => {
		const ses = fakeSes();
		const sender = createSesSender({ region: "us-west-2", accessKeyId: "a", secretAccessKey: "b" }, ses.client);
		const result = await sender.send(message({ headers: { "List-Unsubscribe": "<https://ground.flynorthaero.com/account/unsubscribe?t=abc&k=session>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }));
		assert.deepEqual(result, { messageId: "ses-123" });
		assert.deepEqual(ses.inputs[0], {
			FromEmailAddress: '"North Aero Ground Tutor" <reports@ground.flynorthaero.com>',
			Destination: { ToAddresses: ["student@example.com"] },
			ReplyToAddresses: ["info@flynorthaero.com"],
			ConfigurationSetName: SES_CONFIGURATION_SET,
			EmailTags: [{ Name: "kind", Value: "session-report" }],
			Content: {
				Simple: {
					Subject: { Data: "Study report, Nov 8", Charset: "UTF-8" },
					Body: { Text: { Data: "hi", Charset: "UTF-8" }, Html: { Data: "<p>hi</p>", Charset: "UTF-8" } },
					Headers: [
						{ Name: "List-Unsubscribe", Value: "<https://ground.flynorthaero.com/account/unsubscribe?t=abc&k=session>" },
						{ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
					],
				},
			},
		});
		assert.equal(SES_CONFIGURATION_SET, "ground-tutor-reports");
	});

	it("refuses a bad recipient or a header that could add another header, before calling SES", async () => {
		const ses = fakeSes();
		const sender = createSesSender({ region: "us-west-2", accessKeyId: "a", secretAccessKey: "b" }, ses.client);
		await assert.rejects(sender.send(message({ to: "a@example.com\nBcc: b@example.com" })), InvalidEmailMessageError);
		await assert.rejects(sender.send(message({ subject: "Hi\r\nBcc: b@example.com" })), InvalidEmailMessageError);
		await assert.rejects(sender.send(message({ headers: { "X-Note": "a\r\nBcc: b@example.com" } })), InvalidEmailMessageError);
		await assert.rejects(sender.send(message({ headers: { Bcc: "b@example.com" } })), InvalidEmailMessageError);
		await assert.rejects(sender.send(message({ text: "  " })), InvalidEmailMessageError);
		assert.equal(ses.inputs.length, 0);
	});

	it("passes an SES refusal up, and describes it by name only (no address)", async () => {
		const refusal = Object.assign(new Error("Email address is not verified: student@example.com"), { name: "MessageRejected", $metadata: { httpStatusCode: 400 } });
		const sender = createSesSender({ region: "us-west-2", accessKeyId: "a", secretAccessKey: "b" }, fakeSes(refusal).client);
		await assert.rejects(sender.send(message()), /not verified/);
		assert.equal(describeSendError(refusal), "MessageRejected (HTTP 400)");
		await assert.rejects(createSesSender({ region: "us-west-2", accessKeyId: "a", secretAccessKey: "b" }, fakeSes({}).client).send(message()), /no MessageId/);
	});
});

describe("in-memory fake sender", () => {
	it("keeps messages, fails on demand, and logs no address", async () => {
		const lines: string[] = [];
		const fake = new MemoryEmailSender({ log: (l) => lines.push(l) });
		fake.failNext(new Error("boom"));
		await assert.rejects(fake.send(message()), /boom/);
		assert.deepEqual(await fake.send(message()), { messageId: "memory-1" });
		assert.equal(fake.sent.length, 1);
		assert.equal(fake.mode, "memory");
		assert.deepEqual(lines, ["email (not sent, local fake): session-report for tenant tenant-1"]);
	});
});

describe("email look", () => {
	const doc: EmailDocument = {
		title: "Study session report",
		preheader: "45 min of study on Nov 8, 2026.",
		label: REPORT_LABEL,
		blocks: [
			{ kind: "rows", rows: [{ label: "Date", value: "Nov 8, 2026" }] },
			{ kind: "card", title: "<script>alert(1)</script> & weather", lines: ["Plan: 1 of 2 topics covered."] },
			{ kind: "list", items: [{ lead: "METAR", text: "A routine weather report." }] },
		],
		footer: { links: [{ text: "Turn off session reports", href: "https://x.example/account/unsubscribe?t=a&k=session" }], lines: ["Questions? Reply."] },
	};

	it("escapes student text, fits a phone, and uses the brand colors", () => {
		const html = renderEmailHtml(doc);
		assert.ok(!html.includes("<script>"));
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; weather/);
		assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
		assert.match(html, /max-width:560px/);
		assert.match(html, /#faf6ec/);
		assert.match(html, /#e86a28/);
		assert.match(html, /NORTH AERO <span[^>]*>\/ GROUND TUTOR/);
		assert.match(html, /href="https:\/\/x\.example\/account\/unsubscribe\?t=a&amp;k=session"/);
		assert.equal(html.split(REPORT_LABEL).length - 1, 2, "label at the top and the bottom");
	});

	it("has a plain-text part with the same content and the label at the top and the bottom", () => {
		const text = renderEmailText(doc);
		assert.equal(text.split(REPORT_LABEL).length - 1, 2);
		assert.match(text, /Date: Nov 8, 2026/);
		assert.match(text, /\* <script>alert\(1\)<\/script> & weather\n {2}Plan: 1 of 2 topics covered\./);
		assert.match(text, /- METAR: A routine weather report\./);
		assert.match(text, /Turn off session reports: https:\/\/x\.example\/account\/unsubscribe\?t=a&k=session/);
		assert.ok(!text.includes("<td"));
	});
});

describe("Owner alert email", () => {
	const alert = { kind: "autopause" as const, tenantId: "0f8c2c1e-1111-4222-8333-444455556666", costUsd: 89.4, thresholdUsd: 89, at: new Date("2026-11-08T20:00:00Z") };
	const base = { publicUrl: "https://ground.flynorthaero.com", timeZone: "America/Los_Angeles" };

	it("sends nothing without OWNER_ALERT_EMAIL (D15: dashboard only by default)", async () => {
		const fake = new MemoryEmailSender();
		assert.deepEqual(await createOwnerAlertSender({ ...base, sender: fake, to: undefined })(alert), { sent: false, reason: "no-owner-address" });
		assert.deepEqual(await createOwnerAlertSender({ ...base, sender: null, to: "owner@example.com" })(alert), { sent: false, reason: "email-off" });
		assert.equal(fake.sent.length, 0);
	});

	it("sends the tenant id, the amounts, the time and a dashboard link", async () => {
		const fake = new MemoryEmailSender();
		const result = await createOwnerAlertSender({ ...base, sender: fake, to: "owner@example.com" })(alert);
		assert.deepEqual(result, { sent: true, messageId: "memory-1" });
		const m = fake.sent[0]!;
		assert.equal(m.kind, "owner-alert");
		assert.equal(m.to, "owner@example.com");
		assert.equal(m.subject, "Autopause: student 0f8c2c1e paused at $89");
		assert.match(m.text, /Tenant: 0f8c2c1e-1111-4222-8333-444455556666/);
		assert.match(m.text, /Model cost, last 30 days: \$89\.40/);
		assert.match(m.text, /Autopause level: \$89/);
		assert.match(m.text, /Nov 8, 2026, 12:00 PM PST/);
		assert.match(m.text, /Open the dashboard: https:\/\/ground\.flynorthaero\.com\/admin/);
	});

	it("never throws when sending fails, and logs the error name only", async () => {
		const fake = new MemoryEmailSender();
		fake.failNext(Object.assign(new Error("owner@example.com rejected"), { name: "MessageRejected" }));
		const lines: string[] = [];
		const result = await createOwnerAlertSender({ ...base, sender: fake, to: "owner@example.com", log: (l) => lines.push(l) })({ ...alert, kind: "cost-alert", thresholdUsd: 60, costUsd: 61 });
		assert.deepEqual(result, { sent: false, reason: "send-failed" });
		assert.equal(lines.length, 1);
		assert.ok(!lines[0]!.includes("owner@example.com"));
		assert.match(lines[0]!, /MessageRejected/);
	});
});

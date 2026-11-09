/**
 * Email reports, wired into the front door (W2-10). startFrontDoor() calls
 * startEmailReports() once and passes `reportPages` to the gateway.
 *
 *  - The sender: Amazon SES in production when the SES variables are set,
 *    none when they are not (email off), the in-memory fake outside
 *    production (frontdoor/email/config.ts).
 *  - The report loop: runs every 5 minutes when there is a database and a
 *    sender. It reads each tenant's record from the tenant's own server.
 *  - The report pages: /account/reports and /account/unsubscribe.
 *  - sendOwnerAlert: for w2-pause's alerts, to OWNER_ALERT_EMAIL.
 */
import type { Db } from "../db/db.ts";
import { loadEmailConfig, type EmailMode } from "../email/config.ts";
import { senderFor } from "../email/index.ts";
import { createOwnerAlertSender, type SendOwnerAlert } from "../email/owner-alert.ts";
import type { EmailSender } from "../email/sender.ts";
import type { ClerkGateway } from "../gateway/auth.ts";
import type { AccountStore } from "../tenants/accounts.ts";
import { createReportPages, type ReportPages } from "./pages.ts";
import { createReportRunner, type ReportRunner } from "./runner.ts";
import { clerkUsers, createClerkStudentDirectory, type StudentDirectory } from "./students.ts";
import { createTenantRecordReader } from "./tenant-record.ts";
import { REPORT_TIME_ZONE } from "./time.ts";

export interface EmailReportsOptions {
	env: Readonly<Record<string, string | undefined>>;
	/** Null without SUPABASE_DB_URL (local runs): no loop, and the pages say they are unavailable. */
	db: Db | null;
	accounts: Pick<AccountStore, "get">;
	clerk: ClerkGateway;
	clerkSettings: { secretKey: string; publishableKey: string };
	sessionSecret: Uint8Array;
	secureCookies: boolean;
	trustForwardedHeaders: boolean;
	/** Starts the tenant's server if needed; resolves to its port. */
	ensureRunning(tenantId: string): Promise<number>;
	/**
	 * Extra headers for reads from a tenant's server. After w2-isolation lands,
	 * pass the tenant server's own secret header here.
	 */
	tenantHeaders?: (tenantId: string) => Record<string, string>;
	/** Tests: a sender instead of the one the variables choose (null: email off). */
	sender?: EmailSender | null;
	/** Tests: a directory instead of Clerk. */
	students?: StudentDirectory;
	log: (line: string) => void;
}

export interface EmailReports {
	mode: EmailMode;
	sender: EmailSender | null;
	reportPages: ReportPages;
	sendOwnerAlert: SendOwnerAlert;
	/** Null when there is no database or no sender. */
	runner: ReportRunner | null;
	close(): Promise<void>;
}

const MODE_LINE: Record<EmailMode, string> = {
	ses: "email: Amazon SES",
	off: "email: off (the SES variables are not set); report settings still save",
	memory: "email: local fake, nothing is sent",
};

export function startEmailReports(options: EmailReportsOptions): EmailReports {
	const config = loadEmailConfig(options.env);
	const sender = options.sender !== undefined ? options.sender : senderFor(config, options.log);
	options.log(MODE_LINE[config.mode]);
	const students = options.students ?? (options.db ? createClerkStudentDirectory(options.db, clerkUsers(options.clerkSettings)) : null);

	const runner =
		options.db && sender && students
			? createReportRunner({
					db: options.db,
					sender,
					students,
					readRecord: createTenantRecordReader({ ensureRunning: options.ensureRunning, ...(options.tenantHeaders ? { headers: options.tenantHeaders } : {}) }),
					publicUrl: config.publicUrl,
					timeZone: REPORT_TIME_ZONE,
					log: options.log,
				})
			: null;
	runner?.start();

	return {
		mode: config.mode,
		sender,
		runner,
		reportPages: createReportPages({
			db: options.db,
			students,
			accounts: options.accounts,
			clerk: options.clerk,
			sessionSecret: options.sessionSecret,
			secureCookies: options.secureCookies,
			trustForwardedHeaders: options.trustForwardedHeaders,
			emailMode: config.mode,
			log: options.log,
		}),
		sendOwnerAlert: createOwnerAlertSender({ sender, to: config.ownerAlertEmail, publicUrl: config.publicUrl, timeZone: REPORT_TIME_ZONE, log: options.log }),
		close: async () => {
			await runner?.stop();
		},
	};
}

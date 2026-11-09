/**
 * Email reports, wired into the front door (W2-10). startFrontDoor() calls
 * startEmailReports() once and passes `reportPages` to the gateway.
 *
 *  - The sender: Amazon SES in production when the SES variables are set,
 *    none when they are not (email off), the in-memory fake outside
 *    production (frontdoor/email/config.ts).
 *  - The report loop: runs every 5 minutes when there is a database and a
 *    sender.
 *  - The report pages: /account/reports and /account/unsubscribe.
 *
 * Two inputs the master wires at merge (stand-ins until then):
 *  - `tenantFetch`: w2-isolation's supervisor.tenantFetch, which adds each
 *    tenant server's secret. Stand-in: tenantFetchStandIn(ensureRunning).
 *  - `sittings`: w2-dashboard's frontdoor/study-time "ended sittings"
 *    export. Stand-in: studyTimeSittings(db).
 *
 * No Owner alert email: PRD D15, alerts show on the dashboard only.
 */
import type { Db } from "../db/db.ts";
import { type EmailMode, loadEmailConfig } from "../email/config.ts";
import { senderFor } from "../email/index.ts";
import type { EmailSender } from "../email/sender.ts";
import type { ClerkGateway } from "../gateway/auth.ts";
import type { AccountStore } from "../tenants/accounts.ts";
import { createReportPages, type ReportPages } from "./pages.ts";
import { createReportRunner, type ReportRunner } from "./runner.ts";
import type { EndedSittingsSource } from "./sittings.ts";
import { studyTimeSittings } from "./study-time-stand-in.ts";
import { clerkUsers, createClerkStudentDirectory, type StudentDirectory } from "./students.ts";
import { createTenantRecordReader, type TenantFetch } from "./tenant-record.ts";
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
	/** Reads a tenant's server (w2-isolation's supervisor.tenantFetch shape). */
	tenantFetch: TenantFetch;
	/** Ended study sittings. Default: the stand-in that reads study_time. */
	sittings?: EndedSittingsSource;
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
					sittings: options.sittings ?? studyTimeSittings(options.db),
					readRecord: createTenantRecordReader(options.tenantFetch),
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
		close: async () => {
			await runner?.stop();
		},
	};
}

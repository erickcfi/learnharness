/**
 * Email reports (C6 req 3, D26, N12; cards P6-03, P6-04, P6-05): the
 * session-end and weekly reports, the loop that sends them, the report
 * settings page and the unsubscribe page. Sending is in frontdoor/email/.
 */
export { buildSessionReport, buildWeeklyReport, reportMessage, settingsUrl, unsubscribeUrl, SESSION_FACT_LIMIT, WEEKLY_FACT_LIMIT, type ReportContent, type ReportKind, type ReportLinks, type StudentInfo, type WeekStudy } from "./build.ts";
export { createReportPages, REPORTS_PATH, UNSUBSCRIBE_PATH, type ReportPages, type ReportPagesDeps } from "./pages.ts";
export { createReportRunner, MAX_ATTEMPTS, MIN_WEEKLY_SECONDS, REPORT_INTERVAL_MS, type ReportRunner, type ReportRunnerDeps, type RunSummary } from "./runner.ts";
export {
	endedOnly,
	groupSittings,
	mainChat,
	MIN_REPORT_SECONDS,
	reportableSittings,
	reportWindowStart,
	SESSION_IDLE_MINUTES,
	SESSION_LOOKBACK_HOURS,
	sittingSeconds,
	stretchWindowStart,
	type EndedSitting,
	type EndedSittingsSource,
	type ReportableOptions,
	type Sitting,
	type Stretch,
} from "./sittings.ts";
export {
	claimSittingReport,
	clerkUserIdForTenant,
	listSessionRecipients,
	listWeeklyReportRecipients,
	releaseReportClaim,
	stretchesActiveSince,
	stretchesStartedIn,
	unsubscribeTokenExists,
	type Recipient,
} from "./store.ts";
export { studyTimeSittings } from "./study-time-stand-in.ts";
export { clerkUsers, createClerkStudentDirectory, MemoryStudentDirectory, profileFromClerkUser, type ClerkUsersLike, type StudentDirectory, type StudentProfile } from "./students.ts";
export { createTenantRecordReader, RECORD_READ_TIMEOUT_MS, tenantFetchStandIn, type TenantFetch, type TenantRecordReader } from "./tenant-record.ts";
export { displayDate, displayShortDate, localDate, REPORT_TIME_ZONE, weekContaining, weekDueNow, WEEKLY_SEND_HOUR, WEEKLY_SEND_WINDOW_HOURS, zonedTime, type ReportWeek } from "./time.ts";
export { startEmailReports, type EmailReports, type EmailReportsOptions } from "./wiring.ts";

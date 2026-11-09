/**
 * The report loop (C6 req 3, P6-03, P6-04). Every few minutes it:
 *
 *  1. Session reports: for each student with them on, takes the study
 *     sittings that ended (30 idle minutes, from EndedSittingsSource) in
 *     the last 12 hours, claims each sitting once in report_sends, builds
 *     the email from the student's record, sends it, and marks it sent.
 *  2. Weekly reports: from Monday 08:00 school time, for 48 hours, claims
 *     last week once per student who studied that week, and sends it.
 *
 * Reports start off (report_settings defaults); only students who turned
 * one on are read. If building or sending fails, the claim is released so
 * a later run tries again, at most MAX_ATTEMPTS times per report while
 * the front door runs. Runs never overlap. Logs carry tenant ids and error
 * names only.
 */
import type { Db } from "../db/db.ts";
import { claimReportSend, markReportSent } from "../db/reports.ts";
import { describeSendError, type EmailSender } from "../email/sender.ts";
import { buildSessionReport, buildWeeklyReport, reportMessage, type WeekStudy } from "./build.ts";
import { type EndedSittingsSource, mainChat, type ReportableOptions, reportableSittings, reportWindowStart } from "./sittings.ts";
import { claimSittingReport, listSessionRecipients, listWeeklyReportRecipients, type Recipient, releaseReportClaim, stretchesStartedIn } from "./store.ts";
import type { StudentDirectory } from "./students.ts";
import type { TenantRecordReader } from "./tenant-record.ts";
import { REPORT_TIME_ZONE, weekDueNow } from "./time.ts";

export const REPORT_INTERVAL_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 3;
/** A week with less study than this gets no weekly report. */
export const MIN_WEEKLY_SECONDS = 5 * 60;

export interface ReportRunnerDeps {
	db: Db;
	sender: EmailSender;
	students: StudentDirectory;
	/** Ended study sittings (frontdoor/study-time's export; a stand-in until merge). */
	sittings: EndedSittingsSource;
	readRecord: TenantRecordReader;
	/** The site address used in links. */
	publicUrl: string;
	timeZone?: string;
	now?: () => Date;
	log?: (line: string) => void;
	report?: ReportableOptions;
}

export interface RunSummary {
	sessionSent: number;
	weeklySent: number;
	failed: number;
}

export interface ReportRunner {
	/** One pass. Resolves to what it sent. A pass already under way is joined, not repeated. */
	runOnce(): Promise<RunSummary>;
	/** Runs a pass every `intervalMs`. */
	start(intervalMs?: number): void;
	/** Stops the timer and waits for a pass under way. */
	stop(): Promise<void>;
}

export function createReportRunner(deps: ReportRunnerDeps): ReportRunner {
	const timeZone = deps.timeZone ?? REPORT_TIME_ZONE;
	const now = () => (deps.now ? deps.now() : new Date());
	const log = deps.log ?? (() => {});
	const attempts = new Map<string, number>();
	let running: Promise<RunSummary> | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;

	const exhausted = (key: string) => (attempts.get(key) ?? 0) >= MAX_ATTEMPTS;
	const links = (r: Recipient) => ({ publicUrl: deps.publicUrl, unsubscribeToken: r.unsubscribeToken });

	async function failed(key: string, sendId: number, tenantId: string, what: string, error: unknown): Promise<void> {
		const n = (attempts.get(key) ?? 0) + 1;
		attempts.set(key, n);
		await releaseReportClaim(deps.db, sendId).catch(() => undefined);
		log(`${what} for tenant ${tenantId} failed (try ${n} of ${MAX_ATTEMPTS}): ${describeSendError(error)}`);
	}

	async function sendSessionReports(at: Date, summary: RunSummary): Promise<void> {
		for (const r of await listSessionRecipients(deps.db)) {
			try {
				const ended = await deps.sittings({ tenantId: r.tenantId, endedSince: reportWindowStart(at, deps.report?.lookbackHours), now: at });
				for (const sitting of reportableSittings(ended, at, deps.report)) {
					const chatId = mainChat(sitting);
					const key = `session:${r.tenantId}:${sitting.sittingStartedAt.toISOString()}`;
					if (!chatId || exhausted(key)) continue;
					const sendId = await claimSittingReport(deps.db, { tenantId: r.tenantId, sittingStartedAt: sitting.sittingStartedAt, chatId });
					if (sendId === null) continue;
					try {
						const [source, profile] = await Promise.all([deps.readRecord(r.tenantId), deps.students.get(r.tenantId)]);
						const content = buildSessionReport({ source, sitting, student: { name: profile?.name ?? null }, timeZone, builtAt: now() });
						const { messageId } = await deps.sender.send(reportMessage(content, { address: r.reportEmail, tenantId: r.tenantId }, links(r)));
						await markReportSent(deps.db, sendId, messageId, now());
						summary.sessionSent++;
					} catch (error) {
						summary.failed++;
						await failed(key, sendId, r.tenantId, "session report", error);
					}
				}
			} catch (error) {
				summary.failed++;
				log(`session reports for tenant ${r.tenantId} skipped: ${describeSendError(error)}`);
			}
		}
	}

	async function sendWeeklyReports(at: Date, summary: RunSummary): Promise<void> {
		const week = weekDueNow(at, timeZone);
		if (!week) return;
		for (const r of await listWeeklyReportRecipients(deps.db)) {
			const key = `weekly:${r.tenantId}:${week.weekStart}`;
			if (exhausted(key)) continue;
			try {
				const stretches = await stretchesStartedIn(deps.db, r.tenantId, week.startsAt, week.endsAt);
				const totalSeconds = stretches.reduce((sum, s) => sum + s.activeSeconds, 0);
				if (totalSeconds < MIN_WEEKLY_SECONDS) continue;
				const send = await claimReportSend(deps.db, { tenantId: r.tenantId, kind: "weekly", weekStart: week.weekStart });
				if (!send) continue;
				try {
					const chats = new Map<string, number>();
					for (const s of stretches) if (s.chatId !== null) chats.set(s.chatId, (chats.get(s.chatId) ?? 0) + s.activeSeconds);
					const study: WeekStudy = { week, totalSeconds, chats: [...chats].map(([chatId, activeSeconds]) => ({ chatId, activeSeconds })) };
					const [source, profile] = await Promise.all([deps.readRecord(r.tenantId), deps.students.get(r.tenantId)]);
					const content = buildWeeklyReport({ source, study, student: { name: profile?.name ?? null }, timeZone, builtAt: now() });
					const { messageId } = await deps.sender.send(reportMessage(content, { address: r.reportEmail, tenantId: r.tenantId }, links(r)));
					await markReportSent(deps.db, send.id, messageId, now());
					summary.weeklySent++;
				} catch (error) {
					summary.failed++;
					await failed(key, send.id, r.tenantId, "weekly report", error);
				}
			} catch (error) {
				summary.failed++;
				log(`weekly report for tenant ${r.tenantId} skipped: ${describeSendError(error)}`);
			}
		}
	}

	async function pass(): Promise<RunSummary> {
		const summary: RunSummary = { sessionSent: 0, weeklySent: 0, failed: 0 };
		const at = now();
		try {
			await sendSessionReports(at, summary);
			await sendWeeklyReports(at, summary);
		} catch (error) {
			summary.failed++;
			log(`report pass stopped: ${describeSendError(error)}`);
		}
		if (summary.sessionSent || summary.weeklySent || summary.failed) {
			log(`reports: ${summary.sessionSent} session, ${summary.weeklySent} weekly sent, ${summary.failed} failed`);
		}
		return summary;
	}

	const runner: ReportRunner = {
		runOnce() {
			running ??= pass().finally(() => {
				running = null;
			});
			return running;
		},
		start(intervalMs = REPORT_INTERVAL_MS) {
			if (timer) return;
			timer = setInterval(() => void runner.runOnce(), intervalMs);
			timer.unref();
		},
		async stop() {
			if (timer) clearInterval(timer);
			timer = null;
			await running;
		},
	};
	return runner;
}

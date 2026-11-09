/**
 * Puts the dashboard together for the front door (W2-9): the /admin
 * handler, the study-time routes, the non-aviation sweep, and the runtime
 * the Next.js pages read (registry.ts). wiring/front-door.ts calls
 * createDashboard() once at start and close() at shutdown.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createClerkClient } from "@clerk/backend";
import { type Db, listConsents } from "../db/index.ts";
import type { ClerkGateway } from "../gateway/auth.ts";
import { parseCookies } from "../gateway/cookies.ts";
import { SESSION_COOKIE, verifySession } from "../gateway/session.ts";
import { createSharingEndpoint } from "../sharing/index.ts";
import { listLibrary } from "../library/index.ts";
import { createStudyTimeEndpoint, createStudyTimeRecorder, type StudyTimeEndpoint } from "../study-time/index.ts";
import { resolveAdminAccess } from "./access.ts";
import { type ClerkUsersApi, clerkDirectory, noDirectory, type StudentDirectory } from "./directory.ts";
import { haikuClassifier, startFlagSweeper, type TopicClassifier } from "./flags.ts";
import { createAdminHandler } from "./handler.ts";
import { buildOverview } from "./overview.ts";
import { type AlertActions, databaseAlertActions, databasePauseActions, type PauseActions } from "./pause.ts";
import { DASHBOARD_TIME_ZONE } from "./period.ts";
import { type AdminRuntime, getAdminRuntime, registerAdminRuntime } from "./registry.ts";
import { readSessionText, SessionTextNotAllowedError } from "./session-text.ts";
import { buildStudentDetail } from "./student.ts";
import { supervisorTenantFetch, type TenantFetch, TenantReadError } from "./tenant-api.ts";
import { readThresholds } from "./thresholds.ts";

export interface DashboardOptions {
	db: Db | null;
	sessionSecret: Uint8Array;
	clerk: Pick<ClerkGateway, "isSessionActive">;
	secureCookies: boolean;
	trustForwardedHeaders: boolean;
	frontDoorApp(req: IncomingMessage, res: ServerResponse): unknown;
	supervisor: { ensureRunning(tenantId: string): Promise<number> };
	libraryDir: string;
	/** For student names (directory.ts). Without it, the table shows short tenant ids. */
	clerkSecretKey?: string;
	/** For the non-aviation labels (flags.ts). */
	anthropic?: { apiKey: string; baseUrl?: string };
	/** Run the non-aviation sweep (N7). */
	labelTopics?: boolean;
	/** Overrides, for tests and for the merge with W2-6 and W2-7. */
	tenantFetch?: TenantFetch;
	pause?: PauseActions;
	alerts?: AlertActions;
	directory?: StudentDirectory;
	classifier?: TopicClassifier;
	now?: () => number;
	log?: (line: string) => void;
}

export interface Dashboard {
	admin: { handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> };
	/** The gateway's studentRoutes: the study-time heartbeat and the session-text switch. */
	studentRoutes: StudyTimeEndpoint;
	runtime: AdminRuntime;
	close(): Promise<void>;
}

export function createDashboard(options: DashboardOptions): Dashboard {
	const { db } = options;
	const log = options.log;
	const now = () => new Date(options.now ? options.now() : Date.now());
	const tenantFetch = options.tenantFetch ?? supervisorTenantFetch(options.supervisor);
	const directory =
		options.directory ??
		(options.clerkSecretKey ? clerkDirectory(createClerkClient({ secretKey: options.clerkSecretKey }) as unknown as ClerkUsersApi, { log }) : noDirectory);

	const studyTime = createStudyTimeEndpoint({ recorder: db ? createStudyTimeRecorder({ db, log }) : null });
	const sharing = createSharingEndpoint({ db, trustForwardedHeaders: options.trustForwardedHeaders, now: options.now });
	const studentRoutes: StudyTimeEndpoint = {
		handles: (pathname) => studyTime.handles(pathname) || sharing.handles(pathname),
		handle: (req, res, tenantId, pathname) => (sharing.handles(pathname) ? sharing : studyTime).handle(req, res, tenantId, pathname),
	};

	// Without a database every admin route answers 503, so the stand-ins below never run.
	const admin = createAdminHandler({
		db,
		sessionSecret: options.sessionSecret,
		clerk: options.clerk,
		secureCookies: options.secureCookies,
		trustForwardedHeaders: options.trustForwardedHeaders,
		frontDoorApp: options.frontDoorApp,
		tenantFetch,
		pause: options.pause ?? (db ? databasePauseActions(db) : { pauseTenant: async () => {}, unpauseTenant: async () => {} }),
		alerts: options.alerts ?? (db ? databaseAlertActions(db) : { clearAlert: async () => false }),
		libraryDir: options.libraryDir,
		directory,
		now: options.now,
		log,
	});

	const needDb = (): Db => {
		if (!db) throw new Error("The dashboard needs the database.");
		return db;
	};
	const runtime: AdminRuntime = {
		ready: db !== null,
		timeZone: DASHBOARD_TIME_ZONE,
		async identify(cookieHeader) {
			if (!db) return null;
			const access = await resolveAdminAccess({ db, sessionSecret: options.sessionSecret, clerk: null, now: options.now }, cookieHeader, "dashboard.view");
			return access.kind === "allowed" ? access.identity : null;
		},
		overview: (period) => buildOverview(needDb(), { period, now: now(), directory }),
		student: (tenantId, period) => buildStudentDetail({ db: needDb(), tenantFetch, directory }, tenantId, { period, now: now() }),
		async sessionText(tenantId, chatId) {
			try {
				return { allowed: true, text: await readSessionText({ db: needDb(), tenantFetch }, tenantId, chatId) };
			} catch (error) {
				if (error instanceof SessionTextNotAllowedError) return { allowed: false };
				if (error instanceof TenantReadError) return { allowed: true, text: null };
				throw error;
			}
		},
		thresholds: () => readThresholds(needDb()),
		library: () => listLibrary(options.libraryDir),
		async studentSharing(cookieHeader) {
			if (!db) return null;
			const session = await verifySession(parseCookies(cookieHeader).get(SESSION_COOKIE), options.sessionSecret, options.now ? options.now() : Date.now());
			if (!session) return null;
			const latest = (await listConsents(db, session.tenantId)).filter((c) => c.kind === "session_text_opt_in").at(-1);
			return { optedIn: !!latest && latest.revokedAt === null, changedAt: latest ? (latest.revokedAt ?? latest.grantedAt) : null };
		},
	};
	registerAdminRuntime(runtime);

	const classifier = options.classifier ?? (options.anthropic ? haikuClassifier(options.anthropic) : undefined);
	const stopSweep = db && options.labelTopics && classifier ? startFlagSweeper({ db, tenantFetch, classifier, now, log }) : null;

	return {
		admin,
		studentRoutes,
		runtime,
		async close() {
			await stopSweep?.();
			if (getAdminRuntime() === runtime) registerAdminRuntime(null);
		},
	};
}

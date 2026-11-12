/**
 * The guided course page (master, 2026-11-11). Puts the pieces together for
 * the front door: the /course routes (endpoint.ts), and the runtime the
 * Next.js page reads (registry.ts). wiring/front-door.ts calls createCourse()
 * once at start and close() at shutdown. See README.md in this folder.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "../db/index.ts";
import { parseCookies } from "../gateway/cookies.ts";
import { SESSION_COOKIE, verifySession } from "../gateway/session.ts";
import type { AccountStore } from "../tenants/accounts.ts";
import { databaseStartBlock, noStartBlock, type StartBlockCheck } from "./blocks.ts";
import { type CourseEndpoint, createCourseEndpoint, type TenantRequest } from "./endpoint.ts";
import { type LegStartMarks, legStartMarks } from "./marks.ts";
import { getCourseRuntime, registerCourseRuntime, type CourseRuntime } from "./registry.ts";
import { type CourseSource, libraryCourseSource } from "./source.ts";
import { courseView } from "./view.ts";

export interface CourseOptions {
	db: Db | null;
	accounts: AccountStore;
	sessionSecret: Uint8Array;
	libraryDir: string;
	/** True when billing (the trial gate) is on, so a used-up trial or ended plan blocks new lessons. */
	billing: boolean;
	tenantFetch: TenantRequest;
	frontDoorApp(req: IncomingMessage, res: ServerResponse): unknown;
	trustForwardedHeaders: boolean;
	/** Overrides, for tests. */
	source?: CourseSource;
	marks?: LegStartMarks;
	startBlock?: StartBlockCheck;
	now?: () => number;
	log?: (line: string) => void;
}

export interface Course {
	endpoint: CourseEndpoint;
	runtime: CourseRuntime;
	close(): void;
}

/** The page's own login and 18+ check, then the view. */
export function courseRuntime(options: Pick<CourseOptions, "accounts" | "sessionSecret" | "now"> & { source: CourseSource; marks: LegStartMarks; startBlock: StartBlockCheck }): CourseRuntime {
	const now = () => (options.now ? options.now() : Date.now());
	return {
		async page(cookieHeader) {
			const session = await verifySession(parseCookies(cookieHeader).get(SESSION_COOKIE), options.sessionSecret, now());
			if (!session) return { status: "sign-in" };
			const account = await options.accounts.get(session.userId);
			if (!account || account.tenantId !== session.tenantId) return { status: "sign-in" };
			if (!account.ageConfirmedAt) return { status: "confirm-age" };
			const course = await options.source.load();
			if (!course) return { status: "coming-soon" };
			const [marks, block] = await Promise.all([options.marks.latestByLeg(session.tenantId), options.startBlock(session.tenantId)]);
			return { status: "ready", course: courseView(course, marks, block) };
		},
	};
}

export function createCourse(options: CourseOptions): Course {
	const log = options.log;
	const source = options.source ?? libraryCourseSource(options.libraryDir, log);
	const marks = options.marks ?? legStartMarks(options.db, log);
	const startBlock = options.startBlock ?? (options.db ? databaseStartBlock(options.db, { billing: options.billing, now: options.now, log }) : noStartBlock);
	const endpoint = createCourseEndpoint({
		frontDoorApp: options.frontDoorApp,
		source,
		marks,
		startBlock,
		tenantFetch: options.tenantFetch,
		trustForwardedHeaders: options.trustForwardedHeaders,
		now: options.now,
		log,
	});
	const runtime = courseRuntime({ accounts: options.accounts, sessionSecret: options.sessionSecret, now: options.now, source, marks, startBlock });
	registerCourseRuntime(runtime);
	return {
		endpoint,
		runtime,
		close() {
			if (getCourseRuntime() === runtime) registerCourseRuntime(null);
		},
	};
}

export { COURSE_PATH, COURSE_START_PATH, chatStartPath } from "./endpoint.ts";
export { firstMessage } from "./first-message.ts";
export type { CoursePageState, CourseView } from "./view.ts";

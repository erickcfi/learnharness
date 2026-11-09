/**
 * W2-7 (pause and data safety) put together for wiring/front-door.ts, so
 * the shared wiring file needs only a few lines:
 *
 *   const safety = createDataSafety({ db, volumeDir, log });
 *   const meterStore = safety.wrapMeterStore(store);     // alert, autopause, retention refusal
 *   ... supervisor ...
 *   const { gate } = safety.attach(supervisor);           // screens, export, record, jobs
 *   createGateway({ ..., tenantGate: gate });
 *   await safety.close();                                 // at shutdown
 *
 * For other packages:
 *  - safety.controls.pauseTenant / unpauseTenant: w2-dashboard's buttons.
 *  - safety.retention().startRetention / endRetention: W2-8, from Stripe.
 *  - onAlert: called once per newly opened alert (w2-email, if wired).
 */
import { type Db, listStudyStretches } from "../db/index.ts";
import { copyTenantsNightly, NIGHTLY_KEEP, NIGHTLY_UTC_HOUR } from "../backups/nightly.ts";
import { buildExport, buildRecordHtml, type RecordInputs, type TenantFetch } from "../retention/export.ts";
import { createRetention, type Retention } from "../retention/lifecycle.ts";
import { type JobScheduler, startJobs } from "../retention/schedule.ts";
import { type AccessReader, createAccessReader } from "./access.ts";
import { createPauseControls, type PauseControls } from "./controls.ts";
import { createTenantGate, type TenantGate } from "./gate.ts";
import { type AlertListener, createCostWatch, type CostWatch } from "./limits.ts";
import { withPauseRules } from "./meter.ts";
import type { MeteringStore } from "../metering/store.ts";

export interface DataSafetyOptions {
	db: Db;
	volumeDir: string;
	log: (line: string) => void;
	onAlert?: AlertListener;
	/** The student's name for the study record, from the login. Default "Student". */
	studentName?: (userId: string) => Promise<string | null>;
	/** Deletes a student's login at Clerk on day 91. Not wired unless the master says so. */
	deleteLogin?: (clerkUserId: string) => Promise<void>;
	/** Make nightly copies of each tenant folder (backups/nightly.ts). Default true. */
	nightlyCopies?: boolean;
	/** Tests: how long an access answer is reused. Default 5 s. */
	accessTtlMs?: number;
	/** Tests: the job timer. false: no timer (runNow only). */
	jobTimer?: { firstTickMs?: number; tickMs?: number } | false;
	now?: () => Date;
}

/** What wiring gives attach(): the tenant supervisor's two calls. */
export interface TenantServers {
	ensureRunning(tenantId: string): Promise<number>;
	stop(tenantId: string): Promise<void>;
}

export interface DataSafety {
	access: AccessReader;
	watch: CostWatch;
	controls: PauseControls;
	wrapMeterStore<S extends MeteringStore>(store: S): S;
	/** Builds the gate and starts the jobs. Call once, after the supervisor exists. */
	attach(servers: TenantServers, options?: { fetchTenant?: TenantFetch }): { gate: TenantGate; retention: Retention; jobs: JobScheduler };
	/** The retention calls (after attach). */
	retention(): Retention;
	close(): Promise<void>;
}

/** GET a path from the tenant's own server on 127.0.0.1. */
export function supervisorFetch(servers: Pick<TenantServers, "ensureRunning">): TenantFetch {
	return async (tenantId, path) => {
		const port = await servers.ensureRunning(tenantId);
		return fetch(`http://127.0.0.1:${port}${path}`, { headers: { accept: "application/json, text/markdown;q=0.9, */*;q=0.1" }, signal: AbortSignal.timeout(60_000) });
	};
}

export function createDataSafety(options: DataSafetyOptions): DataSafety {
	const { db, log } = options;
	const now = options.now ?? (() => new Date());
	const access = createAccessReader({ db, ttlMs: options.accessTtlMs, now: () => now().getTime() });
	const watch = createCostWatch({
		db,
		now,
		log,
		onAlert: (event) => {
			// An autopause shows on the screens at once, not after the access cache runs out.
			if (event.kind === "autopause") access.forget(event.tenantId);
			return options.onAlert?.(event);
		},
	});
	const base = createPauseControls({ db, now });
	// A pause or unpause from this process shows at once on the screens.
	const controls: PauseControls = {
		async pauseTenant(tenantId, reason, by) {
			const r = await base.pauseTenant(tenantId, reason, by);
			access.forget(tenantId);
			return r;
		},
		async unpauseTenant(tenantId, by) {
			const r = await base.unpauseTenant(tenantId, by);
			access.forget(tenantId);
			return r;
		},
	};

	let attached: { gate: TenantGate; retention: Retention; jobs: JobScheduler } | null = null;

	async function activeSecondsBySession(tenantId: string): Promise<Record<string, number>> {
		const out: Record<string, number> = {};
		for (const s of await listStudyStretches(db, tenantId)) if (s.chatId) out[s.chatId] = (out[s.chatId] ?? 0) + s.activeSeconds;
		return out;
	}

	return {
		access,
		watch,
		controls,
		wrapMeterStore: (store) => withPauseRules(store, { watch, access }),
		attach(servers, attachOptions = {}) {
			if (attached) return attached;
			const fetchTenant = attachOptions.fetchTenant ?? supervisorFetch(servers);
			const inputs = async (tenantId: string, userId: string, timeZone: string): Promise<RecordInputs> => ({
				tenantId,
				fetchTenant,
				studentName: (await options.studentName?.(userId).catch(() => null)) || "Student",
				timeZone,
				activeSecondsBySession: await activeSecondsBySession(tenantId),
				now: now(),
			});
			const gate = createTenantGate({
				access,
				log,
				data: {
					exportZip: async (tenantId, userId, timeZone) => buildExport(await inputs(tenantId, userId, timeZone)),
					recordHtml: async (tenantId, userId, timeZone) => buildRecordHtml(await inputs(tenantId, userId, timeZone)),
				},
			});
			const lifecycle = createRetention({
				db,
				volumeDir: options.volumeDir,
				now,
				log,
				stopTenant: (id) => servers.stop(id),
				...(options.deleteLogin ? { deleteLogin: options.deleteLogin } : {}),
			});
			const retention: Retention = {
				async startRetention(tenantId, endedAt) {
					const t = await lifecycle.startRetention(tenantId, endedAt);
					access.forget(tenantId);
					return t;
				},
				async endRetention(tenantId) {
					const t = await lifecycle.endRetention(tenantId);
					access.forget(tenantId);
					return t;
				},
				async runDay91() {
					const result = await lifecycle.runDay91();
					for (const id of result.deletedIds) access.forget(id);
					return result;
				},
			};
			const jobList = [
				{ name: "day-91 delete", run: () => retention.runDay91() },
				...(options.nightlyCopies === false
					? []
					: [{ name: "nightly copies", run: () => copyTenantsNightly({ volumeDir: options.volumeDir, now: now(), keep: NIGHTLY_KEEP, utcHour: NIGHTLY_UTC_HOUR, log }) }]),
			];
			const jobs =
				options.jobTimer === false
					? startJobs(jobList, { firstTickMs: 2 ** 31 - 1, log })
					: startJobs(jobList, { ...(options.jobTimer ?? {}), log });
			attached = { gate, retention, jobs };
			return attached;
		},
		retention() {
			if (!attached) throw new Error("createDataSafety: call attach() first");
			return attached.retention;
		},
		async close() {
			await attached?.jobs.stop();
			await watch.idle();
		},
	};
}

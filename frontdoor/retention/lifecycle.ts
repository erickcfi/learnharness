/**
 * Retention and the day-91 delete (P1-08; C1 req 6, D25, and the trial
 * record decision of 2026-11-08).
 *
 *   const retention = createRetention({ db, volumeDir, stopTenant });
 *   await retention.startRetention(tenantId, endedAt); // W2-8, when Stripe says the plan ended
 *   await retention.endRetention(tenantId);           // W2-8, when the student subscribes again
 *   await retention.runDay91();                       // the scheduler, every hour
 *
 * startRetention keeps the tenant 90 days from the end of the plan: the
 * tutor is closed (pause/gate.ts, pause/meter.ts), and the student can
 * download the export and print the record. Calling it again with the
 * same end time changes nothing (a repeated Stripe event).
 *
 * runDay91 deletes every tenant whose 90 days are over. For each one, in
 * this order (master decision, 2026-11-08), each step tried again on the
 * next run if it fails:
 *  1. stop its tutor server, then delete its folder (<volume>/tenants/<id>),
 *     its key file (<volume>/auth/<id>.json) and its nightly copies
 *     (<volume>/backups/nightly/<night>/<id> and <id>.manifest.json);
 *  2. delete its account row, which removes every tenant row through the
 *     foreign keys. Just before, the Clerk user id goes on a pending list
 *     on the volume (<volume>/retention/pending-login-deletes.json), so
 *     step 3 is not lost when the row is gone;
 *  3. stop its server and delete its files again (a request may have
 *     started the server between steps 1 and 2), then delete its user at
 *     Clerk, if deleteLogin is given (Clerk holds the email address). A
 *     failed Clerk delete stays on the pending list, and every run starts
 *     by trying the list again.
 * The Owner's own tenant (owner role, db/accounts.ts isOwnerTenant) is never
 * deleted or emptied: the job leaves it out and logs that it was kept.
 * Staff is not exempt.
 * What is left: trial_claims (a keyed hash of the email and Stripe's card
 * fingerprint, written when the trial started, with no tenant link) and
 * stripe_events (Stripe event ids only). Stripe keeps its own records.
 * Railway's volume backups still hold the data until they expire (runbook).
 *
 * Logs carry tenant ids and counts only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type Db,
	deleteTenantAndAccount,
	endRetention as dbEndRetention,
	getTenant,
	isOwnerTenant,
	listTenantsDueForDeletion,
	startRetention as dbStartRetention,
	type Tenant,
} from "../db/index.ts";
import { one } from "../db/db.ts";
import { assertTenantId, tenantAuthFile, tenantDir } from "../tenants/paths.ts";

/** Where the nightly copies live (backups/nightly.ts writes them). */
export const nightlyRoot = (volumeDir: string) => path.join(path.resolve(volumeDir), "backups", "nightly");

export interface RetentionOptions {
	db: Db;
	volumeDir: string;
	/** Stops the tenant's server so nothing writes in its folder. */
	stopTenant?: (tenantId: string) => Promise<void>;
	/** Deletes the student's login at Clerk. A login Clerk no longer has must count as deleted. */
	deleteLogin?: (clerkUserId: string) => Promise<void>;
	now?: () => Date;
	log?: (line: string) => void;
}

export interface Day91Result {
	due: number;
	deleted: number;
	failed: number;
	/** Ids of the tenants deleted by this run. */
	deletedIds: string[];
	/** Clerk users still to delete after this run (a Clerk delete failed). */
	loginsPending: number;
}

/** Clerk users whose tenant is deleted but whose Clerk delete has not succeeded yet. */
export const pendingLoginFile = (volumeDir: string) => path.join(path.resolve(volumeDir), "retention", "pending-login-deletes.json");

interface PendingLogin {
	clerkUserId: string;
	/** For the log only. */
	tenantId: string;
}

function readPending(file: string): PendingLogin[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		return Array.isArray(parsed) ? parsed.filter((p): p is PendingLogin => typeof p?.clerkUserId === "string" && typeof p?.tenantId === "string") : [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function writePending(file: string, pending: readonly PendingLogin[]): void {
	if (pending.length === 0) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
	fs.renameSync(temp, file);
}

export interface Retention {
	startRetention(tenantId: string, endedAt: Date): Promise<Tenant>;
	endRetention(tenantId: string): Promise<Tenant>;
	runDay91(): Promise<Day91Result>;
}

function errorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : ((error as Error | null)?.name ?? "Error");
}

/** Deletes the tenant's files on the volume. Returns how many of the three kinds were there. */
export function removeTenantFiles(volumeDir: string, tenantId: string): { folder: boolean; keyFile: boolean; nightlyCopies: number } {
	assertTenantId(tenantId);
	const folder = tenantDir(volumeDir, tenantId);
	const keyFile = tenantAuthFile(volumeDir, tenantId);
	const result = { folder: fs.existsSync(folder), keyFile: fs.existsSync(keyFile), nightlyCopies: 0 };
	fs.rmSync(folder, { recursive: true, force: true });
	fs.rmSync(keyFile, { force: true });
	const nightly = nightlyRoot(volumeDir);
	let nights: string[] = [];
	try {
		nights = fs.readdirSync(nightly);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const night of nights) {
		const copy = path.join(nightly, night, tenantId);
		const manifest = path.join(nightly, night, `${tenantId}.manifest.json`);
		if (fs.existsSync(copy) || fs.existsSync(manifest)) result.nightlyCopies += 1;
		fs.rmSync(copy, { recursive: true, force: true });
		fs.rmSync(manifest, { force: true });
	}
	return result;
}

export function createRetention(options: RetentionOptions): Retention {
	const { db, volumeDir } = options;
	const now = options.now ?? (() => new Date());
	const log = options.log ?? ((line: string) => console.log(line));
	let running: Promise<Day91Result> | null = null;

	const pendingFile = pendingLoginFile(volumeDir);

	/** Tries each pending Clerk delete once. Returns how many are still pending. */
	async function deletePendingLogins(): Promise<number> {
		if (!options.deleteLogin) return 0;
		const left: PendingLogin[] = [];
		for (const p of readPending(pendingFile)) {
			try {
				await options.deleteLogin(p.clerkUserId);
				log(`day-91: deleted the Clerk user of tenant ${p.tenantId}`);
			} catch (error) {
				left.push(p);
				log(`day-91: the Clerk user of tenant ${p.tenantId} could not be deleted (${errorCode(error)}); the next run tries again`);
			}
		}
		writePending(pendingFile, left);
		return left.length;
	}

	async function deleteOne(tenant: Tenant): Promise<void> {
		// 1. The server, then the files.
		await options.stopTenant?.(tenant.id);
		const files = removeTenantFiles(volumeDir, tenant.id);
		// 2. The database rows. The Clerk user id goes on the pending list first, so step 3 survives a crash.
		const login = await one(db, "select a.clerk_user_id from accounts a join tenants t on t.account_id = a.id where t.id = $1", [tenant.id]);
		if (options.deleteLogin && login?.clerk_user_id) {
			const pending = readPending(pendingFile).filter((p) => p.tenantId !== tenant.id);
			writePending(pendingFile, [...pending, { clerkUserId: String(login.clerk_user_id), tenantId: tenant.id }]);
		}
		await deleteTenantAndAccount(db, tenant.id);
		// 3. A request may have started its server again before the rows went: stop it, and remove what it wrote.
		await options.stopTenant?.(tenant.id);
		removeTenantFiles(volumeDir, tenant.id);
		log(
			`day-91: deleted tenant ${tenant.id} (folder ${files.folder ? "yes" : "already gone"}, key file ${files.keyFile ? "yes" : "already gone"}, ${files.nightlyCopies} nightly copies, database rows)`,
		);
	}

	async function run(): Promise<Day91Result> {
		// Clerk users left over from an earlier run first.
		await deletePendingLogins();
		const due: Tenant[] = [];
		for (const tenant of await listTenantsDueForDeletion(db, now())) {
			// The Owner's own tenant is never deleted or emptied. If the check fails, the run stops here and deletes nothing.
			if (await isOwnerTenant(db, tenant.id)) log(`day-91: tenant ${tenant.id} belongs to the Owner; kept`);
			else due.push(tenant);
		}
		const result: Day91Result = { due: due.length, deleted: 0, failed: 0, deletedIds: [], loginsPending: 0 };
		for (const tenant of due) {
			try {
				await deleteOne(tenant);
				result.deleted += 1;
				result.deletedIds.push(tenant.id);
			} catch (error) {
				result.failed += 1;
				log(`day-91: tenant ${tenant.id} could not be deleted (${errorCode(error)}); the next run tries again`);
			}
		}
		// Then the Clerk users of the tenants just deleted.
		result.loginsPending = await deletePendingLogins();
		if (due.length > 0 || result.loginsPending > 0) {
			log(`day-91: ${due.length} due, ${result.deleted} deleted, ${result.failed} failed, ${result.loginsPending} Clerk users still to delete`);
		}
		return result;
	}

	return {
		async startRetention(tenantId, endedAt) {
			assertTenantId(tenantId);
			if (Number.isNaN(endedAt.getTime())) throw new Error("startRetention needs a valid end date.");
			const tenant = await dbStartRetention(db, tenantId, endedAt);
			log(`retention: tenant ${tenantId} kept until ${tenant.retentionEndsAt?.toISOString()}`);
			return tenant;
		},
		async endRetention(tenantId) {
			assertTenantId(tenantId);
			const before = await getTenant(db, tenantId);
			if (!before) throw new Error(`tenant ${tenantId} does not exist`);
			if (before.status !== "retention") return before;
			const tenant = await dbEndRetention(db, tenantId);
			log(`retention: tenant ${tenantId} is back in service`);
			return tenant;
		},
		runDay91() {
			// One run at a time: a slow run and the next tick never overlap.
			running ??= run().finally(() => {
				running = null;
			});
			return running;
		},
	};
}

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
 * this order, so a failure part way is finished by the next run:
 *  1. stop its tutor server;
 *  2. delete its folder (<volume>/tenants/<id>), its key file
 *     (<volume>/auth/<id>.json) and its nightly copies
 *     (<volume>/backups/nightly/<night>/<id> and <id>.manifest.json);
 *  3. delete its login at Clerk, if deleteLogin is given (Clerk holds the
 *     email address);
 *  4. delete its account row, which removes every tenant row through the
 *     foreign keys;
 *  5. delete the folder again, in case a request started its server
 *     between steps 2 and 4.
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

	async function deleteOne(tenant: Tenant): Promise<void> {
		await options.stopTenant?.(tenant.id);
		const files = removeTenantFiles(volumeDir, tenant.id);
		const login = await one(db, "select a.clerk_user_id from accounts a join tenants t on t.account_id = a.id where t.id = $1", [tenant.id]);
		if (options.deleteLogin && login?.clerk_user_id) await options.deleteLogin(String(login.clerk_user_id));
		await deleteTenantAndAccount(db, tenant.id);
		removeTenantFiles(volumeDir, tenant.id);
		log(
			`day-91: deleted tenant ${tenant.id} (folder ${files.folder ? "yes" : "already gone"}, key file ${files.keyFile ? "yes" : "already gone"}, ${files.nightlyCopies} nightly copies, login ${options.deleteLogin ? "deleted" : "kept"}, database rows)`,
		);
	}

	async function run(): Promise<Day91Result> {
		const due = await listTenantsDueForDeletion(db, now());
		const result: Day91Result = { due: due.length, deleted: 0, failed: 0, deletedIds: [] };
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
		if (due.length > 0) log(`day-91: ${due.length} due, ${result.deleted} deleted, ${result.failed} failed`);
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

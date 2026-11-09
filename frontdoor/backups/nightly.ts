/**
 * Nightly copies of each tenant folder (P1-09, X3), so one student's
 * folder can be restored without rolling back every student (a Railway
 * volume restore is all or nothing).
 *
 *   <volume>/backups/nightly/<YYYY-MM-DD>/<tenant id>/              the copy
 *   <volume>/backups/nightly/<YYYY-MM-DD>/<tenant id>.manifest.json  its files, sizes and SHA-256
 *
 * Once a day, at the first job tick at or after NIGHTLY_UTC_HOUR (UTC),
 * every tenant folder is copied; a tenant whose manifest already exists for
 * that night is skipped, so a restart in the middle finishes the night
 * without starting over. The newest NIGHTLY_KEEP nights are kept and older
 * ones removed. The library is not copied (the Owner has the originals, and
 * Railway's volume backups hold it). The day-91 delete removes a tenant's
 * copies with its folder (retention/lifecycle.ts).
 *
 * These copies live on the same volume, so they do not replace Railway's
 * volume backups; Railway's backups also hold them. Logs: counts only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isTenantId } from "../tenants/paths.ts";
import { copyTree, hashTree, listTree, type Manifest } from "./manifest.ts";

/** Nights kept on the volume. */
export const NIGHTLY_KEEP = 7;
/** 10:00 UTC is 2 or 3 a.m. on the US West Coast. */
export const NIGHTLY_UTC_HOUR = 10;

export const nightlyDir = (volumeDir: string) => path.join(path.resolve(volumeDir), "backups", "nightly");
const NIGHT = /^\d{4}-\d{2}-\d{2}$/;

export interface NightlyOptions {
	volumeDir: string;
	now: Date;
	keep?: number;
	utcHour?: number;
	/** Copy now, whatever the hour (tests, a manual run). */
	force?: boolean;
	log?: (line: string) => void;
}

export interface NightlyResult {
	/** The night copied, or null when it was not time yet. */
	night: string | null;
	copied: number;
	skipped: number;
	failed: number;
	pruned: number;
}

function errorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : ((error as Error | null)?.name ?? "Error");
}

/** Copies one folder; symlinks and special files are left out (upstream writes none). Returns how many were left out. */
async function copyOne(volumeDir: string, nightPath: string, tenantId: string, madeAt: Date): Promise<number> {
	const source = path.join(path.resolve(volumeDir), "tenants", tenantId);
	const staging = path.join(nightPath, `.partial-${tenantId}`);
	const final = path.join(nightPath, tenantId);
	// A partial copy from an interrupted run is replaced.
	await fs.promises.rm(staging, { recursive: true, force: true });
	await fs.promises.rm(final, { recursive: true, force: true });
	const tree = await listTree(source);
	const symlinksSkipped = tree.refused.length;
	await copyTree(source, staging, { ...tree, refused: [] });
	const manifest: Manifest = { version: 1, tenantId, madeAt: madeAt.toISOString(), files: await hashTree(staging) };
	await fs.promises.rename(staging, final);
	const manifestFile = path.join(nightPath, `${tenantId}.manifest.json`);
	await fs.promises.writeFile(`${manifestFile}.tmp`, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
	await fs.promises.rename(`${manifestFile}.tmp`, manifestFile);
	return symlinksSkipped;
}

export async function copyTenantsNightly(options: NightlyOptions): Promise<NightlyResult> {
	const log = options.log ?? ((line: string) => console.log(line));
	const result: NightlyResult = { night: null, copied: 0, skipped: 0, failed: 0, pruned: 0 };
	if (!options.force && options.now.getUTCHours() < (options.utcHour ?? NIGHTLY_UTC_HOUR)) return result;

	const night = options.now.toISOString().slice(0, 10);
	result.night = night;
	const root = nightlyDir(options.volumeDir);
	const nightPath = path.join(root, night);
	await fs.promises.mkdir(nightPath, { recursive: true, mode: 0o700 });
	await fs.promises.chmod(path.dirname(root), 0o700).catch(() => undefined);

	let tenants: string[] = [];
	try {
		tenants = (await fs.promises.readdir(path.join(path.resolve(options.volumeDir), "tenants"), { withFileTypes: true }))
			.filter((e) => e.isDirectory() && isTenantId(e.name))
			.map((e) => e.name)
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	for (const tenantId of tenants) {
		if (fs.existsSync(path.join(nightPath, `${tenantId}.manifest.json`))) {
			result.skipped += 1;
			continue;
		}
		try {
			const left = await copyOne(options.volumeDir, nightPath, tenantId, options.now);
			if (left > 0) log(`nightly copies: tenant ${tenantId}: ${left} symlinks or special files left out`);
			result.copied += 1;
		} catch (error) {
			result.failed += 1;
			log(`nightly copies: tenant ${tenantId} (${errorCode(error)})`);
		}
	}

	const keep = options.keep ?? NIGHTLY_KEEP;
	const nights = (await fs.promises.readdir(root)).filter((n) => NIGHT.test(n)).sort();
	for (const old of nights.slice(0, Math.max(0, nights.length - keep))) {
		await fs.promises.rm(path.join(root, old), { recursive: true, force: true });
		result.pruned += 1;
	}
	if (result.copied || result.failed || result.pruned) {
		log(`nightly copies ${night}: ${result.copied} copied, ${result.skipped} already done, ${result.failed} failed, ${result.pruned} old nights removed`);
	}
	return result;
}

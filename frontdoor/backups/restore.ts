/**
 * Restore one tenant folder from a backup copy (P1-09, X3). Runbook:
 * docs/decisions/2026-11-08-backups.md.
 *
 * The backup copy is either
 *   - a nightly copy:  <night folder>/<tenant id>/  (with <tenant id>.manifest.json beside it), or
 *   - a whole-volume copy, for example one downloaded from a restored Railway
 *     backup:  <copy>/tenants/<tenant id>/
 *
 * Two targets:
 *   scratch  copies into <dir>/<tenant id>/ and checks it. Touches nothing
 *            live: use it to look inside a backup or to test one.
 *   live     copies into <volume>/tenants/<tenant id>/. The folder there now
 *            is moved aside to <volume>/restore-kept/<tenant id>-<time>/,
 *            never deleted. Then stopTenant runs, so the tutor server
 *            starts again on the restored folder at the next request.
 *
 * Every step checks: the tenant id is a UUID; the backup holds only plain
 * files and folders (no symlinks); with a manifest, the backup still
 * matches it; the copy matches the backup, file by file (size and SHA-256),
 * before it is put in place. The copy is made beside its final place and
 * renamed in, so a failure never leaves a half-restored folder live.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { assertTenantId } from "../tenants/paths.ts";
import { compareFiles, copyTree, hashTree, listTree, type Manifest } from "./manifest.ts";

export type RestoreTarget = { kind: "scratch"; dir: string } | { kind: "live"; volumeDir: string };

export interface RestoreOptions {
	backupDir: string;
	tenantId: string;
	target: RestoreTarget;
	/** live only: stops the tenant's running server after the swap. */
	stopTenant?: (tenantId: string) => Promise<void>;
	now?: Date;
}

export interface RestoreResult {
	source: string;
	restoredTo: string;
	files: number;
	bytes: number;
	/** live only: where the replaced folder was moved. */
	keptAside: string | null;
	/** True when a manifest was found and the backup matched it. */
	manifestChecked: boolean;
}

export class RestoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RestoreError";
	}
}

function isDir(p: string): boolean {
	try {
		return fs.lstatSync(p).isDirectory();
	} catch {
		return false;
	}
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** The tenant's folder inside a backup copy, and its manifest if there is one. */
export function findInBackup(backupDir: string, tenantId: string): { source: string; manifestFile: string | null } {
	assertTenantId(tenantId);
	const root = path.resolve(backupDir);
	const nightly = path.join(root, tenantId);
	if (isDir(nightly)) {
		const manifestFile = path.join(root, `${tenantId}.manifest.json`);
		return { source: nightly, manifestFile: fs.existsSync(manifestFile) ? manifestFile : null };
	}
	const volumeCopy = path.join(root, "tenants", tenantId);
	if (isDir(volumeCopy)) return { source: volumeCopy, manifestFile: null };
	throw new RestoreError(`No folder for tenant ${tenantId} in ${root} (looked for <backup>/${tenantId} and <backup>/tenants/${tenantId}).`);
}

export async function restoreTenantFolder(options: RestoreOptions): Promise<RestoreResult> {
	const { tenantId } = options;
	assertTenantId(tenantId);
	const now = options.now ?? new Date();
	const { source, manifestFile } = findInBackup(options.backupDir, tenantId);

	const tree = await listTree(source);
	if (tree.refused.length > 0) throw new RestoreError(`The backup holds ${tree.refused.length} symlinks or special files (first: ${tree.refused[0]}). Not restored; a person should look.`);
	const sourceFiles = await hashTree(source, tree);
	let manifestChecked = false;
	if (manifestFile) {
		const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Manifest;
		if (manifest.tenantId !== tenantId) throw new RestoreError("The manifest belongs to another tenant.");
		const problems = compareFiles(manifest.files, sourceFiles);
		if (problems.length > 0) throw new RestoreError(`The backup does not match its manifest (${problems.length} differences, first: ${problems[0]}).`);
		manifestChecked = true;
	}

	const parent = options.target.kind === "scratch" ? path.resolve(options.target.dir) : path.join(path.resolve(options.target.volumeDir), "tenants");
	const final = path.join(parent, tenantId);
	if (options.target.kind === "scratch" && fs.existsSync(final)) throw new RestoreError(`${final} already exists. Pick an empty scratch folder.`);
	fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
	const staging = path.join(parent, `.restore-${tenantId}-${stamp(now)}`);
	if (fs.existsSync(staging)) throw new RestoreError(`${staging} already exists.`);

	await copyTree(source, staging, tree);
	const problems = compareFiles(sourceFiles, await hashTree(staging));
	if (problems.length > 0) throw new RestoreError(`The copy does not match the backup (${problems.length} differences, first: ${problems[0]}). It was left at ${staging}.`);
	fs.chmodSync(staging, 0o700);

	let keptAside: string | null = null;
	if (options.target.kind === "live" && fs.existsSync(final)) {
		const keptRoot = path.join(path.resolve(options.target.volumeDir), "restore-kept");
		fs.mkdirSync(keptRoot, { recursive: true, mode: 0o700 });
		keptAside = path.join(keptRoot, `${tenantId}-${stamp(now)}`);
		fs.renameSync(final, keptAside);
	}
	fs.renameSync(staging, final);
	if (options.target.kind === "live") await options.stopTenant?.(tenantId);

	return {
		source,
		restoredTo: final,
		files: sourceFiles.length,
		bytes: sourceFiles.reduce((sum, f) => sum + f.size, 0),
		keptAside,
		manifestChecked,
	};
}

/**
 * Linux: the pids of tenant servers whose LH_DATA_DIR is this folder, read
 * from /proc. The restore script uses it to stop the server it restored
 * under, since it runs outside the front door process.
 */
export function findTenantServerPids(tenantFolder: string): number[] {
	const wanted = Buffer.from(`LH_DATA_DIR=${path.resolve(tenantFolder)}\0`);
	const pids: number[] = [];
	let entries: string[] = [];
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return pids;
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
		try {
			const environ = fs.readFileSync(`/proc/${entry}/environ`);
			if (environ.indexOf(wanted) === 0 || environ.indexOf(Buffer.concat([Buffer.from([0]), wanted])) >= 0) pids.push(Number(entry));
		} catch {
			// Gone, or not ours to read.
		}
	}
	return pids;
}

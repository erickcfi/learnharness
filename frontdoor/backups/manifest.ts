/**
 * File lists with sizes and SHA-256 hashes, so a copy of a tenant folder
 * can be checked against what was copied (P1-09, X3). Plain Node.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ManifestFile {
	/** Relative to the folder, with forward slashes. */
	path: string;
	size: number;
	sha256: string;
}

export interface Manifest {
	version: 1;
	tenantId: string;
	madeAt: string;
	files: ManifestFile[];
}

export interface Tree {
	/** Regular files, relative, sorted. */
	files: string[];
	/** Directories, relative, sorted (parents first). */
	dirs: string[];
	/** Symlinks and special files: a copy refuses them. */
	refused: string[];
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/** Walks a folder without following symlinks. */
export async function listTree(root: string): Promise<Tree> {
	const tree: Tree = { files: [], dirs: [], refused: [] };
	async function walk(rel: string): Promise<void> {
		const entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			const child = rel ? path.join(rel, entry.name) : entry.name;
			if (entry.isDirectory()) {
				tree.dirs.push(toPosix(child));
				await walk(child);
			} else if (entry.isFile()) tree.files.push(toPosix(child));
			else tree.refused.push(toPosix(child));
		}
	}
	await walk("");
	return tree;
}

export async function hashFile(file: string): Promise<{ size: number; sha256: string }> {
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of fs.createReadStream(file)) {
		hash.update(chunk as Buffer);
		size += (chunk as Buffer).length;
	}
	return { size, sha256: hash.digest("hex") };
}

/** Every regular file with its size and hash, sorted by path. */
export async function hashTree(root: string, tree?: Tree): Promise<ManifestFile[]> {
	const t = tree ?? (await listTree(root));
	const out: ManifestFile[] = [];
	for (const rel of t.files) out.push({ path: rel, ...(await hashFile(path.join(root, ...rel.split("/")))) });
	return out;
}

/** Differences between two file lists, as short lines; empty when they match. */
export function compareFiles(expected: readonly ManifestFile[], actual: readonly ManifestFile[]): string[] {
	const want = new Map(expected.map((f) => [f.path, f]));
	const got = new Map(actual.map((f) => [f.path, f]));
	const problems: string[] = [];
	for (const [p, f] of want) {
		const g = got.get(p);
		if (!g) problems.push(`missing: ${p}`);
		else if (g.size !== f.size || g.sha256 !== f.sha256) problems.push(`changed: ${p}`);
	}
	for (const p of got.keys()) if (!want.has(p)) problems.push(`extra: ${p}`);
	return problems;
}

/** Copies a tree made of plain files and folders. Folders 0700, files 0600. */
export async function copyTree(source: string, target: string, tree: Tree): Promise<void> {
	if (tree.refused.length > 0) throw new Error(`Refusing to copy ${tree.refused.length} symlinks or special files (first: ${tree.refused[0]}).`);
	await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
	for (const dir of tree.dirs) await fs.promises.mkdir(path.join(target, ...dir.split("/")), { recursive: true, mode: 0o700 });
	for (const file of tree.files) {
		const to = path.join(target, ...file.split("/"));
		await fs.promises.copyFile(path.join(source, ...file.split("/")), to, fs.constants.COPYFILE_EXCL);
		await fs.promises.chmod(to, 0o600);
	}
}
